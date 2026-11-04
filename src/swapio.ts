import { CONFIG } from "./config.js";
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

// Live swaps go through the Swap.io Agent API (hermes.ts), signed by the agent wallet.
async function liveSwap(from: string, to: string, amountIn: number): Promise<SwapResult> {
  if (!CONFIG.walletSecret) throw new Error("live mode needs WALLET_SECRET_KEY");
  const { keypairFromSecret } = await import("./wallets.js");
  const { hermesSwap } = await import("./hermes.js");
  const kp = await keypairFromSecret(CONFIG.walletSecret);
  const r = await hermesSwap(kp, from, to, amountIn);
  if (r.expectedOut == null) throw new Error(`swap sent (${r.signature}) but the quote had no output amount: check the ledger`);
  return { amountIn, amountOut: r.expectedOut, txSig: r.signature };
}
