import { CONFIG, TOKENS } from "./config.js";
import { log } from "./store.js";

// Swap.io Agent API (https://hermes.swap.io), paid per request in USDC via x402.
// Flow from the docs: quote (paid) -> build-tx (paid) -> sign locally -> send with our own RPC -> confirm.
// Docs: docs.swap.io/developer-tools/agent-api-x402
// x402 client: @payai/x402-solana (the package the docs call "x402-solana").

type Keypair = import("@solana/web3.js").Keypair;

export type HermesQuote = { provider: { key: string; name?: string }; output?: any; bestQuote?: boolean; priceImpactPct?: number; minimumOutAmount?: string; providerQuote: unknown };
export type HermesSwap = { signature: string; provider: string; quotes: { provider: string; outAmount: number | null; best: boolean }[]; expectedOut: number | null; amountIn: number };

async function x402Fetch(kp: Keypair) {
  let mod: any;
  try { mod = await import("@payai/x402-solana/client"); }
  catch { throw new Error("x402 client not installed: add @payai/x402-solana to package.json dependencies"); }
  const client = mod.createX402Client({
    wallet: { address: kp.publicKey.toString(), signTransaction: async (tx: any) => { tx.sign([kp]); return tx; } },
    network: "solana",
  });
  return (url: string, body: unknown) =>
    client.fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as Promise<Response>;
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
  };
  log("hermes.swap", { from, to, amountIn, provider: result.provider, signature });
  return result;
}
