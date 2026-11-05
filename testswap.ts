import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG, TOKENS } from "./config.js";
import { getMarket } from "./market.js";
import { hermesSwap } from "./hermes.js";
import { keypairFor, listWallets } from "./wallets.js";
import { log } from "./store.js";

// TEST SWAPS: one small real swap through the Swap.io Agent API from a chosen wallet, run from the dashboard.
// For testing the live swap path before going live. Capped at TEST_SWAP_MAX_USD and locked until ALLOW_TEST_SWAPS=yes.

export type TestSwapRecord = {
  time: string; wallet: string; walletName: string; from: string; to: string; amountUsd: number;
  status: "ok" | "failed"; provider?: string; signature?: string; solscan?: string; expectedOut?: number | null;
  quotes?: { provider: string; outAmount: number | null; best: boolean }[]; apiCostUsdc?: number; error?: string; durationMs: number;
};

const file = () => join(CONFIG.dataDir, "testswaps.json");
export const loadTestSwaps = (): TestSwapRecord[] => (existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : []);
const save = (r: TestSwapRecord[]) => { mkdirSync(CONFIG.dataDir, { recursive: true }); writeFileSync(file(), JSON.stringify(r.slice(-100), null, 2)); };

export const testSwapStatus = () => ({
  enabled: process.env.ALLOW_TEST_SWAPS === "yes",
  maxUsd: CONFIG.testSwapMaxUsd,
  tokens: Object.keys(TOKENS),
  wallets: listWallets().length,
});

let busy = false;
let lastRun = 0;

export async function runTestSwap(p: { walletId: string; from: string; to: string; amountUsd: number }): Promise<TestSwapRecord> {
  if (process.env.ALLOW_TEST_SWAPS !== "yes") throw new Error("test swaps are locked: set ALLOW_TEST_SWAPS=yes in Railway");
  if (CONFIG.killSwitch) throw new Error("KILL_SWITCH is on");
  if (!(p.from in TOKENS) || !(p.to in TOKENS) || p.from === p.to) throw new Error("pick two different whitelisted tokens");
  if (!Number.isFinite(p.amountUsd) || p.amountUsd <= 0 || p.amountUsd > CONFIG.testSwapMaxUsd) throw new Error(`amount must be between $0 and $${CONFIG.testSwapMaxUsd}`);
  if (busy) throw new Error("a test swap is already running");
  if (Date.now() - lastRun < 30_000) throw new Error("wait 30 seconds between test swaps");
  busy = true; lastRun = Date.now();
  const w = listWallets().find((x) => x.id === p.walletId);
  const started = Date.now();
  const rec: TestSwapRecord = { time: new Date().toISOString(), wallet: p.walletId, walletName: w?.name ?? p.walletId, from: p.from, to: p.to, amountUsd: p.amountUsd, status: "failed", durationMs: 0 };
  try {
    const kp = await keypairFor(p.walletId);
    const market = await getMarket();
    const amountIn = p.amountUsd / market[p.from];
    const r = await hermesSwap(kp, p.from, p.to, amountIn);
    Object.assign(rec, { status: "ok", provider: r.provider, signature: r.signature, solscan: `https://solscan.io/tx/${r.signature}`, expectedOut: r.expectedOut, quotes: r.quotes, apiCostUsdc: r.apiCostUsdc });
  } catch (e) {
    rec.error = (e as Error).message.slice(0, 400);
  } finally {
    busy = false;
    rec.durationMs = Date.now() - started;
    const all = loadTestSwaps(); all.push(rec); save(all);
    log(`testswap.${rec.status}`, { wallet: rec.walletName, from: rec.from, to: rec.to, amountUsd: rec.amountUsd, provider: rec.provider, signature: rec.signature, error: rec.error });
  }
  return rec;
}
