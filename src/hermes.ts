import { CONFIG, TOKENS } from "./config.js";
import { log } from "./store.js";

// Swap.io Agent API (https://hermes.swap.io), paid per request in USDC via x402.
// Flow from the docs: quote (paid) -> build-tx (paid) -> sign locally -> send with our own RPC -> confirm.
// Docs: docs.swap.io/developer-tools/agent-api-x402
// x402 v1 "exact" Solana payments, built here (Hermes speaks x402Version 1):
//   1. call the endpoint -> 402 with payment requirements (payTo, asset, maxAmountRequired, extra.feePayer)
//   2. build a v0 transaction: SetComputeUnitLimit, SetComputeUnitPrice, TransferChecked(USDC -> payTo's token account)
//      with the facilitator as fee payer, and sign only our part
//   3. retry with header X-PAYMENT = base64(JSON {x402Version, scheme, network, payload: {transaction}})
// The facilitator co-signs, pays the network fee and settles. We never pay more than X402_MAX_USDC per call.

type Keypair = import("@solana/web3.js").Keypair;

export type HermesQuote = { provider: { key: string; name?: string }; output?: any; bestQuote?: boolean; priceImpactPct?: number; minimumOutAmount?: string; providerQuote: unknown };
export type HermesSwap = { signature: string; provider: string; quotes: { provider: string; outAmount: number | null; best: boolean }[]; expectedOut: number | null; amountIn: number; apiCostUsdc: number };

type Requirement = { scheme: string; network: string; maxAmountRequired: string; payTo: string; asset?: string; extra?: { feePayer?: string } };

async function x402Fetch(kp: Keypair) {
  const web3 = await import("@solana/web3.js");
  const spl = await import("@solana/spl-token");
  const conn = new web3.Connection(CONFIG.solanaRpc, "confirmed");
  let spent = 0;

  async function pay(req: Requirement, version: number): Promise<string> {
    const asset = req.asset || TOKENS.USDC.mint;
    if (asset !== TOKENS.USDC.mint) throw new Error(`x402 asks for an unexpected token ${asset}`);
    const atoms = BigInt(req.maxAmountRequired);
    if (Number(atoms) / 1e6 > CONFIG.x402MaxUsdc) throw new Error(`x402 price $${Number(atoms) / 1e6} is above the $${CONFIG.x402MaxUsdc} per-call cap`);
    if (!req.extra?.feePayer) throw new Error("x402 requirements have no feePayer");
    const mint = new web3.PublicKey(asset);
    const owner = kp.publicKey;
    const source = spl.getAssociatedTokenAddressSync(mint, owner);
    const dest = spl.getAssociatedTokenAddressSync(mint, new web3.PublicKey(req.payTo));
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const msg = new web3.TransactionMessage({
      payerKey: new web3.PublicKey(req.extra.feePayer),
      recentBlockhash: blockhash,
      instructions: [
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units: CONFIG.x402ComputeUnits }),
        web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        spl.createTransferCheckedInstruction(source, mint, dest, owner, atoms, TOKENS.USDC.decimals),
      ],
    }).compileToV0Message();
    const tx = new web3.VersionedTransaction(msg);
    tx.sign([kp]); // partial: the facilitator adds the fee payer signature
    const transaction = Buffer.from(tx.serialize()).toString("base64");
    spent += Number(atoms) / 1e6;
    return Buffer.from(JSON.stringify({ x402Version: version, scheme: "exact", network: req.network, payload: { transaction } })).toString("base64");
  }

  const fetchPaid = async (url: string, body: unknown): Promise<Response> => {
    const init = { method: "POST", headers: { "Content-Type": "application/json" } as Record<string, string>, body: JSON.stringify(body) };
    const first = await fetch(url, init);
    if (first.status !== 402) return first;
    const terms = (await first.json()) as { x402Version?: number; accepts?: Requirement[]; error?: string };
    const req = terms.accepts?.find((a) => a.scheme === "exact" && String(a.network).startsWith("solana"));
    if (!req) throw new Error(`no Solana x402 payment option offered: ${JSON.stringify(terms).slice(0, 200)}`);
    if ((terms.x402Version ?? 1) !== 1) throw new Error(`x402 version ${terms.x402Version} is not supported yet`);
    const header = await pay(req, 1);
    const paid = await fetch(url, { ...init, headers: { ...init.headers, "X-PAYMENT": header } });
    if (paid.status === 402) {
      const body = await paid.text();
      if (/simulation_failed|insufficient/i.test(body)) throw new Error("this wallet can't pay the Swap.io API fee: it needs some USDC (a few cents covers the API, plus the amount you swap)");
      throw new Error(`payment rejected: ${body.slice(0, 300)}`);
    }
    return paid;
  };
  return Object.assign(fetchPaid, { spent: () => spent });
}

const outAmountOf = (q: HermesQuote, decimals: number): number | null => {
  const raw = q.output?.amount ?? q.output?.outAmount ?? q.output?.expectedAmount;
  return raw == null ? null : Number(raw) / 10 ** decimals;
};

// The serialized transaction can sit under different names (transaction, tx, swapTransaction, data...) or one level down.
const TX_KEYS = ["transaction", "serializedTransaction", "swapTransaction", "tx", "txData", "data", "rawTransaction", "base64"];
function findTx(o: any, depth = 0): string | null {
  if (typeof o === "string") return o.length > 100 ? o : null;
  if (!o || typeof o !== "object" || depth > 3) return null;
  if (Array.isArray(o)) { for (const x of o) { const t = findTx(x, depth + 1); if (t) return t; } return null; }
  for (const k of TX_KEYS) if (k in o) { const t = findTx(o[k], depth + 1); if (t) return t; }
  for (const k of ["transactions", "result", "response", "build"]) if (k in o) { const t = findTx(o[k], depth + 1); if (t) return t; }
  return null;
}

// Turn a long simulation log into one readable line. Known Solana and Jupiter error codes get plain names.
const KNOWN: [RegExp, string, boolean, boolean?][] = [
  [/0x1771|6001|SlippageToleranceExceeded|slippage/i, "price moved past the slippage limit (stale quote)", true],
  [/BlockhashNotFound|Blockhash not found|block height exceeded/i, "quote expired before it was sent", true],
  [/insufficient lamports|0x1\b|insufficient funds|InsufficientFundsForFee|prior credit/i, "not enough balance: check the token being sold, plus about 0.01 SOL for fees and new token accounts", false, true],
  [/AccountNotFound|could not find account/i, "a token account is missing in the wallet (it needs a little SOL to create one)", false],
];
async function simulationReason(e: any, conn: any): Promise<{ text: string; retry: boolean; balance?: boolean }> {
  let logs: string[] = e?.logs ?? [];
  if (!logs.length && typeof e?.getLogs === "function") { try { logs = await e.getLogs(conn); } catch {} }
  const all = `${e?.message ?? e} ${e?.transactionError?.message ?? ""} ${JSON.stringify(e?.transactionError ?? "")} ${logs.join(" ")}`;
  for (const [re, text, retry, balance] of KNOWN) if (re.test(all)) return { text, retry, balance };
  const errLines = logs.filter((l) => /failed|error|Error/.test(l)).slice(-3);
  return { text: (errLines.length ? errLines.join(" | ") : String(e?.message ?? e)).slice(0, 400), retry: false };
}

// Poll our own RPC (free) instead of the paid status endpoint. About 75 seconds, the life of a Solana blockhash.
async function waitForConfirmation(conn: any, signature: string) {
  for (let i = 0; i < 38; i++) {
    const { value } = await conn.getSignatureStatuses([signature], { searchTransactionHistory: false });
    const st = value?.[0];
    if (st?.err) throw new Error(`transaction failed on-chain: ${JSON.stringify(st.err)} (${signature})`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`sent but not confirmed after 75 seconds, check Solscan before trying again: ${signature}`);
}

// Full swap of `amountIn` units of `from` into `to`, signed by `kp`.
export async function hermesSwap(kp: Keypair, from: string, to: string, amountIn: number, slippageBps = CONFIG.limits.maxSlippageBps): Promise<HermesSwap> {
  const base = (CONFIG.swapioApiUrl || "https://hermes.swap.io").replace(/\/$/, "");
  const pay = await x402Fetch(kp);
  const user = kp.publicKey.toString();
  const atoms = String(Math.floor(amountIn * 10 ** TOKENS[from].decimals));

  const { Connection, VersionedTransaction } = await import("@solana/web3.js");
  const conn = new Connection(CONFIG.solanaRpc, "confirmed");

  // Preflight: a wallet short on SOL fails inside the swap programs with cryptic codes, so check first.
  // SOL covers the network fee plus temporary token accounts (about 0.002 each, mostly refunded).
  const MIN_SOL = 0.006;
  try {
    const { balancesOf } = await import("./market.js");
    const b = await balancesOf(user);
    const needSol = MIN_SOL + (from === "SOL" ? amountIn : 0);
    if (b.SOL < needSol) throw new Error(`swap not sent: the wallet has ${b.SOL.toFixed(4)} SOL and needs at least ${needSol.toFixed(4)} (${from === "SOL" ? "the amount + " : ""}${MIN_SOL} for fees and temporary accounts)`);
    if (from !== "SOL" && b[from] < amountIn) throw new Error(`swap not sent: the wallet has ${b[from]} ${from}, less than the ${amountIn} being sold`);
    if (from === "USDC" && b.USDC < amountIn + 0.02) throw new Error(`swap not sent: the wallet needs ${amountIn} USDC to sell plus about 0.02 USDC for the Swap.io API calls (has ${b.USDC})`);
  } catch (e) { if (/^swap not sent/.test((e as Error).message)) throw e; /* balance lookup failed: carry on, the swap will report its own error */ }

  // Quote, build, sign, send. A failed simulation means nothing was sent, so a stale quote is retried once with a fresh one.
  // A failed simulation means nothing was sent, so it is safe to try again:
  //   stale quote  -> fresh quote, once
  //   route error  -> next provider, from a fresh quote, up to 3 providers
  let quotes: HermesQuote[] = [], best!: HermesQuote, signature = "";
  const tried = new Set<string>(), reasons: string[] = [];
  let requote = true, requotes = 0;
  for (let attempt = 1; attempt <= 4; attempt++) {
    // 1. Quote
    if (requote) {
      const qr = await pay(`${base}/v1/swap/quote`, {
        input: { token: TOKENS[from].mint, amount: atoms, chainKey: "sol" },
        output: { token: TOKENS[to].mint, chainKey: "sol" },
        userAddress: user,
        slippageBps,
      });
      if (!qr.ok) throw new Error(`quote failed ${qr.status}: ${(await qr.text()).slice(0, 300)}`);
      quotes = ((await qr.json()) as { quotes: HermesQuote[] }).quotes;
      if (!quotes?.length) throw new Error("no quotes returned");
      requote = false;
    }
    const ranked = [...quotes.filter((q) => q.bestQuote), ...quotes.filter((q) => !q.bestQuote)];
    const next = ranked.find((q) => !tried.has(q.provider.key));
    if (!next) throw new Error(`every provider failed simulation (${[...tried].join(", ")})`);
    best = next;

    // 2. Build
    const br = await pay(`${base}/v1/swap/build-tx`, { provider: best.provider.key, userAddress: user, chainKey: "sol", quoteResponse: best.providerQuote });
    if (!br.ok) { tried.add(best.provider.key); log("hermes.build_failed", { provider: best.provider.key, status: br.status }); continue; }
    const built = await br.json();
    const transaction = findTx(built);
    if (!transaction) throw new Error(`build-tx returned no transaction we recognise. Response: ${JSON.stringify(built).slice(0, 400)}`);

    // 3. Sign, then send with our own RPC, or through Swap.io submit-tx when a co-signer is needed
    let tx: InstanceType<typeof VersionedTransaction>;
    try { tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64")); }
    catch { const { base58Decode } = await import("./wallets.js"); tx = VersionedTransaction.deserialize(base58Decode(transaction)); }
    tx.sign([kp]);
    // If another signer is still missing (Swap.io's gas sponsor as fee payer), only Swap.io can broadcast it: use submit-tx.
    const needsCosigner = tx.signatures.some((sig) => sig.every((b) => b === 0));
    const signedB64 = Buffer.from(tx.serialize()).toString("base64");
    try {
      if (needsCosigner) {
        const sr = await pay(`${base}/v1/swap/submit-tx`, { signedTransaction: signedB64, provider: best.provider.key, chainKey: "sol" });
        const sub = (await sr.json().catch(() => ({}))) as { transactionHash?: string; status?: string; errorMessage?: string; errorCode?: string };
        if (!sr.ok || sub.status === "failed" || !sub.transactionHash) throw new Error(`submit-tx ${sr.status}: ${sub.errorMessage || sub.errorCode || JSON.stringify(sub).slice(0, 300)}`);
        signature = sub.transactionHash;
      } else {
        signature = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
      }
      log("hermes.sent", { via: needsCosigner ? "swapio submit-tx" : "own rpc", provider: best.provider.key, signature });
      await waitForConfirmation(conn, signature);
      break;
    } catch (e) {
      if (signature) throw e; // it was sent: never retry
      let why = await simulationReason(e, conn);
      // Empty logs = rejected before any program ran: almost always no SOL to pay the network fee
      if (!why.balance && !((e as any)?.logs?.length)) {
        const lamports = await conn.getBalance(kp.publicKey).catch(() => null);
        if (lamports != null && lamports < 5_000_000) why = { text: `the wallet has ${(lamports / 1e9).toFixed(4)} SOL: it needs about 0.01 SOL for network fees and new token accounts`, retry: false, balance: true };
      }
      log("hermes.simulation_failed", { attempt, provider: best.provider.key, why: why.text });
      if (why.balance) throw new Error(`swap not sent: ${why.text}`);
      if (why.retry && requotes < 1) { requotes++; requote = true; tried.clear(); continue; }
      tried.add(best.provider.key);
      reasons.push(`${best.provider.key}: ${why.text.slice(0, 160)}`);
      requote = true; // quotes are short-lived (Swap.io docs): every new attempt starts from a fresh quote
      if (tried.size >= 3 || attempt === 4) throw new Error(`swap not sent, every route failed simulation. ${reasons.join(" || ")}`);
    }
  }
  if (!signature) throw new Error("swap not sent: no provider produced a working transaction");

  const d = TOKENS[to].decimals;
  const result: HermesSwap = {
    signature,
    provider: best.provider.name || best.provider.key,
    quotes: quotes.map((q) => ({ provider: q.provider.name || q.provider.key, outAmount: outAmountOf(q, d), best: q === best })),
    expectedOut: outAmountOf(best, d),
    amountIn,
    apiCostUsdc: Math.round(pay.spent() * 1e6) / 1e6,
  };
  log("hermes.swap", { from, to, amountIn, provider: result.provider, signature });
  return result;
}
