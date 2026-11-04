import { CONFIG } from "./config.js";
import { log, type State } from "./store.js";
import { lendMode } from "./runtime.js";

// Idle USDC lending. Paper mode simulates interest at LEND_PAPER_APY.
// Live mode: TODO(dev) wire Kamino Lend (main market USDC reserve) with @kamino-finance/klend-sdk.
// Until then, use LEND_MODE=off with MODE=live.

export function accrue(state: State): number {
  if (lendMode() !== "paper" || state.lentUsdc <= 0) { state.lastAccrual = new Date().toISOString(); return 0; }
  const days = (Date.now() - Date.parse(state.lastAccrual)) / 864e5;
  const interest = state.lentUsdc * (CONFIG.lending.paperApy / 365) * days;
  state.lentUsdc += interest;
  state.interestEarned += interest;
  state.lastAccrual = new Date().toISOString();
  return interest;
}

export async function lentBalance(state: State): Promise<number> {
  if (lendMode() === "live") throw new Error("Kamino live lending not wired yet (TODO dev)");
  return lendMode() === "paper" ? state.lentUsdc : 0;
}

// Current lending rate (APY). Paper uses LEND_PAPER_APY. TODO(dev): read the Kamino USDC reserve rate when live lending is wired.
export async function currentApy(): Promise<number | null> {
  return lendMode() === "paper" ? CONFIG.lending.paperApy : null;
}

export async function deposit(state: State, amount: number): Promise<number> {
  if (amount < 1 || lendMode() === "off") return 0;
  if (lendMode() === "live") throw new Error("Kamino live lending not wired yet (TODO dev)");
  state.paperBalances.USDC -= amount;
  state.lentUsdc += amount;
  log("lend.deposit", { amount: round(amount), lent: round(state.lentUsdc) });
  return amount;
}

export async function withdraw(state: State, amount: number): Promise<number> {
  if (amount <= 0 || lendMode() === "off") return 0;
  if (lendMode() === "live") throw new Error("Kamino live lending not wired yet (TODO dev)");
  const a = Math.min(amount, state.lentUsdc);
  state.lentUsdc -= a;
  state.paperBalances.USDC += a;
  log("lend.withdraw", { amount: round(a), lent: round(state.lentUsdc) });
  return a;
}

const round = (x: number) => Math.round(x * 100) / 100;
