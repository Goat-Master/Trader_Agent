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

// Full swap of `amountIn` units of `from` into `to`, signed by `kp`.
export async function hermesSwap(kp: Keypair, from: string, to: string, amountIn: number, slippageBps = CONFIG.limits.maxSlippageBps): Promise<HermesSwap> {
  const base = (CONFIG.swapioApiUrl || "https://hermes.swap.io").replace(/\/$/, "");
  const pay = await x402Fetch(kp);
  const user = kp.publicKey.toString();
  const atoms = String(Math.floor(amountIn * 10 ** TOKENS[from].decimals));

  // 1. Quote
  const qr = await pay(`${base}/v1/swap/quote`, {
    input: { token: TOKENS[from].mint, amount: atoms, chainKey: "sol" },
    output: { token: TOKENS[to].mint, chainKey: "sol" },
    userAddress: user,
    slippageBps,
  });
  if (!qr.ok) throw new Error(`quote failed ${qr.status}: ${(await qr.text()).slice(0, 300)}`);
  const { quotes } = (await qr.json()) as { quotes: HermesQuote[] };
  if (!quotes?.length) throw new Error("no quotes returned");
  const best = quotes.find((q) => q.bestQuote) ?? quotes[0];

  // 2. Build
  const br = await pay(`${base}/v1/swap/build-tx`, { provider: best.provider.key, userAddress: user, chainKey: "sol", quoteResponse: best.providerQuote });
  if (!br.ok) throw new Error(`build-tx failed ${br.status}: ${(await br.text()).slice(0, 300)}`);
  const { transaction } = (await br.json()) as { transaction: string };

  // 3. Sign and send with our own RPC (skips the paid submit-tx call)
  const { Connection, VersionedTransaction } = await import("@solana/web3.js");
  const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
  tx.sign([kp]);
  const conn = new Connection(CONFIG.solanaRpc, "confirmed");
  const latest = await conn.getLatestBlockhash();
  const signature = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const conf = await conn.confirmTransaction({ signature, ...latest }, "confirmed");
  if (conf.value.err) throw new Error(`transaction failed on-chain: ${JSON.stringify(conf.value.err)} (${signature})`);

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
