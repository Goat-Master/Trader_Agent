import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.js";

// Runtime controls, changed from the dashboard and saved on the volume.
// Env vars only set the starting values; after that the dashboard is the source of truth.

export type Mode = "paper" | "live";
export type Controls = {
  trader: { enabled: boolean; mode: Mode };
  tweeter: { enabled: boolean; mode: "dry" | "live" };
  updatedAt: string;
};

const file = () => join(CONFIG.dataDir, "controls.json");

export function loadControls(): Controls {
  mkdirSync(CONFIG.dataDir, { recursive: true });
  if (existsSync(file())) return JSON.parse(readFileSync(file(), "utf8"));
  return {
    trader: { enabled: process.env.TRADER_ENABLED !== "off", mode: process.env.MODE === "live" && prerequisites().liveTrading.ok ? "live" : "paper" },
    tweeter: { enabled: process.env.TWEETER_ENABLED !== "off", mode: process.env.POST_MODE === "live" && prerequisites().liveTweets.ok ? "live" : "dry" },
    updatedAt: new Date().toISOString(),
  };
}

// What has to be configured before a live switch is allowed
export function prerequisites() {
  const missing = (keys: [string, string | undefined][]) => keys.filter(([, v]) => !v).map(([k]) => k);
  const trade = missing([
    ["WALLET_ADDRESS", CONFIG.walletAddress],
    ["WALLET_SECRET_KEY", CONFIG.walletSecret],
    ["SWAPIO_API_URL", CONFIG.swapioApiUrl],
    ["ALLOW_LIVE_TRADING=yes", process.env.ALLOW_LIVE_TRADING === "yes" ? "ok" : ""],
  ]);
  const tweet = missing([
    ["X_API_KEY", CONFIG.x.apiKey],
    ["X_API_SECRET", CONFIG.x.apiSecret],
    ["X_ACCESS_TOKEN", CONFIG.x.accessToken],
    ["X_ACCESS_SECRET", CONFIG.x.accessSecret],
  ]);
  return { liveTrading: { ok: trade.length === 0, missing: trade }, liveTweets: { ok: tweet.length === 0, missing: tweet } };
}

export function setControls(patch: { trader?: Partial<Controls["trader"]>; tweeter?: Partial<Controls["tweeter"]> }): Controls {
  const c = loadControls();
  const p = prerequisites();
  if (patch.trader?.mode === "live" && !p.liveTrading.ok) throw new Error(`live trading is locked, missing: ${p.liveTrading.missing.join(", ")}`);
  if (patch.tweeter?.mode === "live" && !p.liveTweets.ok) throw new Error(`live tweets are locked, missing: ${p.liveTweets.missing.join(", ")}`);
  const next: Controls = {
    trader: { ...c.trader, ...pick(patch.trader, ["enabled", "mode"]) },
    tweeter: { ...c.tweeter, ...pick(patch.tweeter, ["enabled", "mode"]) },
    updatedAt: new Date().toISOString(),
  };
  if (!["paper", "live"].includes(next.trader.mode) || !["dry", "live"].includes(next.tweeter.mode)) throw new Error("invalid mode");
  writeFileSync(file(), JSON.stringify(next, null, 2));
  return next;
}

function pick<T extends object>(o: T | undefined, keys: string[]) {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k)));
}

// The trading mode for the cycle in progress. Set by the trader at the start of each cycle.
export const rt = { tradeMode: "paper" as Mode };

// Lending follows the trading mode: paper trading uses simulated lending, live trading uses Kamino only once wired.
export const lendMode = (): "off" | "paper" | "live" =>
  CONFIG.lending.mode === "off" ? "off" : rt.tradeMode === "paper" ? "paper" : CONFIG.lending.mode === "live" ? "live" : "off";
