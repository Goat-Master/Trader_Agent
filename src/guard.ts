import { CONFIG, TOKENS } from "./config.js";
import type { Market } from "./market.js";
import { tradesToday, type State } from "./store.js";
import { rt } from "./runtime.js";

// The safety net. Plain code, no AI. Every swap must pass this before it is signed.
export function checkTrade(
  p: { from: string; to: string; amountIn: number; signalPrice: number; asset: string },
  balances: Record<string, number>,
  market: Market,
  state: State
): { ok: true } | { ok: false; reason: string } {
  const L = CONFIG.limits;
  if (CONFIG.killSwitch) return { ok: false, reason: "kill switch is on" };
  if (!(p.from in TOKENS) || !(p.to in TOKENS)) return { ok: false, reason: "token not on the whitelist" };
  if (p.from === p.to) return { ok: false, reason: "same token" };
  if (!Number.isFinite(p.amountIn) || p.amountIn <= 0) return { ok: false, reason: "invalid amount" };
  const usd = p.amountIn * market[p.from];
  if (usd > L.maxTradeUsd) return { ok: false, reason: `over the $${L.maxTradeUsd} per-trade limit` };
  if (tradesToday(state).length >= L.maxTradesPerDay) return { ok: false, reason: "daily trade count reached" };
  if (p.amountIn > (balances[p.from] ?? 0) + 1e-9) return { ok: false, reason: `not enough ${p.from}` };
  // The on-chain token must track the price the signal was computed on (catches a cbBTC depeg or bad data).
  const gap = Math.abs(market[p.asset] / p.signalPrice - 1) * 100;
  if (gap > L.maxPriceGapPct) return { ok: false, reason: `${p.asset} on-chain price is ${gap.toFixed(1)}% away from the signal price` };
  if (rt.tradeMode === "live" && (balances.SOL ?? 0) < L.minSolForFees) return { ok: false, reason: "not enough SOL for fees" };
  return { ok: true };
}
