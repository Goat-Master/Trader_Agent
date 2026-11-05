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
    if (paid.status === 402) throw new Error(`payment rejected: ${(await paid.text()).slice(0, 300)}`);
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
const KNOWN: [RegExp, string, boolean][] = [
  [/0x1771|6001|SlippageToleranceExceeded|slippage/i, "price moved past the slippage limit (stale quote)", true],
  [/BlockhashNotFound|Blockhash not found|block height exceeded/i, "quote expired before it was sent", true],
  [/insufficient lamports|0x1\b|insufficient funds/i, "not enough balance: check the token being sold, plus about 0.01 SOL for fees and new token accounts", false],
  [/AccountNotFound|could not find account/i, "a token account is missing in the wallet (it needs a little SOL to create one)", false],
];
async function simulationReason(e: any, conn: any): Promise<{ text: string; retry: boolean }> {
  let logs: string[] = e?.logs ?? [];
  if (!logs.length && typeof e?.getLogs === "function") { try { logs = await e.getLogs(conn); } catch {} }
  const all = `${e?.message ?? e} ${logs.join(" ")}`;
  for (const [re, text, retry] of KNOWN) if (re.test(all)) return { text, retry };
  const errLines = logs.filter((l) => /failed|error|Error/.test(l)).slice(-3);
  return { text: (errLines.length ? errLines.join(" | ") : String(e?.message ?? e)).slice(0, 400), retry: false };
}

// Full swap of `amountIn` units of `from` into `to`, signed by `kp`.
export async function hermesSwap(kp: Keypair, from: string, to: string, amountIn: number, slippageBps = CONFIG.limits.maxSlippageBps): Promise<HermesSwap> {
  const base = (CONFIG.swapioApiUrl || "https://hermes.swap.io").replace(/\/$/, "");
  const pay = await x402Fetch(kp);
  const user = kp.publicKey.toString();
  const atoms = String(Math.floor(amountIn * 10 ** TOKENS[from].decimals));

  const { Connection, VersionedTransaction } = await import("@solana/web3.js");
  const conn = new Connection(CONFIG.solanaRpc, "confirmed");

  // Quote, build, sign, send. A failed simulation means nothing was sent, so a stale quote is retried once with a fresh one.
  let quotes: HermesQuote[] = [], best!: HermesQuote, signature = "";
  for (let attempt = 1; ; attempt++) {
    // 1. Quote
    const qr = await pay(`${base}/v1/swap/quote`, {
      input: { token: TOKENS[from].mint, amount: atoms, chainKey: "sol" },
      output: { token: TOKENS[to].mint, chainKey: "sol" },
      userAddress: user,
      slippageBps,
    });
    if (!qr.ok) throw new Error(`quote failed ${qr.status}: ${(await qr.text()).slice(0, 300)}`);
    quotes = ((await qr.json()) as { quotes: HermesQuote[] }).quotes;
    if (!quotes?.length) throw new Error("no quotes returned");
    best = quotes.find((q) => q.bestQuote) ?? quotes[0];

    // 2. Build
    const br = await pay(`${base}/v1/swap/build-tx`, { provider: best.provider.key, userAddress: user, chainKey: "sol", quoteResponse: best.providerQuote });
    if (!br.ok) throw new Error(`build-tx failed ${br.status}: ${(await br.text()).slice(0, 300)}`);
    const built = await br.json();
    const transaction = findTx(built);
    if (!transaction) throw new Error(`build-tx returned no transaction we recognise. Response: ${JSON.stringify(built).slice(0, 400)}`);

    // 3. Sign and send with our own RPC (skips the paid submit-tx call)
    let tx: InstanceType<typeof VersionedTransaction>;
    try { tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64")); }
    catch { const { base58Decode } = await import("./wallets.js"); tx = VersionedTransaction.deserialize(base58Decode(transaction)); }
    tx.sign([kp]);
    try {
      const latest = await conn.getLatestBlockhash();
      signature = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
      const conf = await conn.confirmTransaction({ signature, ...latest }, "confirmed");
      if (conf.value.err) throw new Error(`transaction failed on-chain: ${JSON.stringify(conf.value.err)} (${signature})`);
      break;
    } catch (e) {
      if (signature) throw e; // it was sent: never retry
      const why = await simulationReason(e, conn);
      log("hermes.simulation_failed", { attempt, provider: best.provider.key, why: why.text });
      if (why.retry && attempt < 2) continue;
      throw new Error(`swap not sent (simulation failed): ${why.text}`);
    }
  }

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
