import { CONFIG, TOKENS } from "./config.js";
import type { Market } from "./market.js";
import type { State } from "./store.js";
import { rt } from "./runtime.js";

export type SwapResult = { amountIn: number; amountOut: number; txSig: string };

// Executes a swap of `amountIn` units of `from` into `to`. Paper mode simulates it; live mode routes through Swap.io.
// This file and lending.ts are the only places that touch the wallet key. No AI ever sees it.
export async function executeSwap(from: string, to: string, amountIn: number, market: Market, state: State): Promise<SwapResult> {
  if (rt.tradeMode === "paper") {
    const cost = 0.0015; // simulated fee + price impact per side (backtest used 30 bps per round trip)
    const amountOut = (amountIn * market[from] * (1 - cost)) / market[to];
    state.paperBalances[from] -= amountIn;
    state.paperBalances[to] = (state.paperBalances[to] ?? 0) + amountOut;
    return { amountIn, amountOut, txSig: `paper-${Date.now()}` };
  }
  return liveSwap(from, to, amountIn);
}

// TODO(dev): wire to the real Swap.io API. Placeholder shape: request a swap transaction, sign locally, send.
async function liveSwap(from: string, to: string, amountIn: number): Promise<SwapResult> {
  if (!CONFIG.swapioApiUrl || !CONFIG.walletSecret) throw new Error("live mode needs SWAPIO_API_URL and WALLET_SECRET_KEY");
  const { Connection, Keypair, VersionedTransaction } = await import("@solana/web3.js");
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(CONFIG.walletSecret)));
  const atoms = Math.floor(amountIn * 10 ** TOKENS[from].decimals);
  const headers = { "content-type": "application/json", ...(CONFIG.swapioApiKey ? { authorization: `Bearer ${CONFIG.swapioApiKey}` } : {}) };
  const res = await fetch(`${CONFIG.swapioApiUrl}/swap`, {
    method: "POST",
    headers,
    body: JSON.stringify({ inputMint: TOKENS[from].mint, outputMint: TOKENS[to].mint, amount: String(atoms), slippageBps: CONFIG.limits.maxSlippageBps, userPublicKey: kp.publicKey.toBase58() }),
  });
  if (!res.ok) throw new Error(`Swap.io ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const q = (await res.json()) as { swapTransaction: string; outAmount: string };
  const tx = VersionedTransaction.deserialize(Buffer.from(q.swapTransaction, "base64"));
  tx.sign([kp]);
  const conn = new Connection(CONFIG.solanaRpc, "confirmed");
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const latest = await conn.getLatestBlockhash();
  const conf = await conn.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  if (conf.value.err) throw new Error(`transaction failed: ${JSON.stringify(conf.value.err)}`);
  return { amountIn, amountOut: Number(q.outAmount) / 10 ** TOKENS[to].decimals, txSig: sig };
}
