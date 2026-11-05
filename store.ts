import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG, TOKENS } from "./config.js";
import type { Mode } from "./runtime.js";

export type Trade = {
  time: string;
  sleeve: string;
  side: "buy" | "sell";
  asset: string;
  amountIn: number;
  amountOut: number;
  price: number;
  pnlPct?: number; // on sells: result of the round trip
  txSig: string;
  mode: Mode;
};

export type SleeveState = { inPosition: boolean; units: number; usdc: number; costUsdc: number | null; entryPrice: number | null; entryTime: string | null };

export type State = {
  mode: Mode;
  startedAt: string;
  needsFunding: boolean; // live ledger: split the real wallet's USDC across sleeves on the first run
  startValueUsd: number | null;
  startPrices: Record<string, number> | null; // for "vs holding" benchmarks
  paperBalances: Record<string, number>;
  lentUsdc: number; // paper lending balance
  interestEarned: number;
  lastAccrual: string;
  sleeves: Record<string, SleeveState>;
  trades: Trade[];
  lastProcessedDay: string | null; // last daily close acted on
  peakValue: number;
  maxDrawdownPct: number;
  signals: Record<string, object>; // latest evaluation per sleeve, for the dashboard
  equity: { date: string; value: number; btc: number; sol: number }[];
  lastSnapshot: Record<string, any> | null;
  lastAnalysis: { headline: string; reasoning: string; date: string } | null;
  lastLendApy?: number | null;
};

// Paper and live keep separate ledgers, so switching modes never mixes simulated and real money.
const file = (mode: Mode) => join(CONFIG.dataDir, `state.${mode}.json`);

export function stateExists(mode: Mode) {
  return existsSync(file(mode));
}

export function loadState(mode: Mode): State {
  mkdirSync(CONFIG.dataDir, { recursive: true });
  if (existsSync(file(mode))) return JSON.parse(readFileSync(file(mode), "utf8"));
  const paperBalances = Object.fromEntries(Object.keys(TOKENS).map((s) => [s, 0]));
  paperBalances.USDC = CONFIG.startUsdc;
  paperBalances.SOL = CONFIG.limits.minSolForFees * 2; // fee reserve, not part of any sleeve
  const paper = mode === "paper";
  const sleeves = Object.fromEntries(
    CONFIG.sleeves.map((s) => [s.id, { inPosition: false, units: 0, usdc: paper ? CONFIG.startUsdc * s.weight : 0, costUsdc: null, entryPrice: null, entryTime: null }])
  );
  const now = new Date().toISOString();
  return {
    mode, startedAt: now, needsFunding: !paper, startValueUsd: null, startPrices: null, paperBalances, lentUsdc: 0, interestEarned: 0,
    lastAccrual: now, sleeves, trades: [], lastProcessedDay: null, peakValue: 0, maxDrawdownPct: 0, signals: {}, equity: [], lastSnapshot: null, lastAnalysis: null,
  };
}

export function saveState(s: State) {
  s.equity = s.equity.slice(-1000);
  writeFileSync(file(s.mode), JSON.stringify(s, null, 2));
}

// ---------- outbox: the trading agent drops events here, the tweeting agent picks them up ----------
export type OutboxEvent = {
  id: string;
  time: string;
  kind: "trade" | "daily" | "edu" | "lend";
  facts: Record<string, any>;
  status: "pending" | "draft" | "posted" | "blocked" | "skipped" | "expired" | "error";
  draft?: string;
  final?: string;
  reason?: string;
  tweetId?: string;
  handledAt?: string;
};

const outboxFile = () => join(CONFIG.dataDir, "outbox.json");

export function loadOutbox(): OutboxEvent[] {
  return existsSync(outboxFile()) ? JSON.parse(readFileSync(outboxFile(), "utf8")) : [];
}

export function saveOutbox(events: OutboxEvent[]) {
  mkdirSync(CONFIG.dataDir, { recursive: true });
  writeFileSync(outboxFile(), JSON.stringify(events.slice(-300), null, 2));
}

export function addEvent(kind: OutboxEvent["kind"], facts: Record<string, any>) {
  const events = loadOutbox();
  events.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, time: new Date().toISOString(), kind, facts, status: "pending" });
  saveOutbox(events);
}

// ---------- activity log ----------
const logFile = () => join(CONFIG.dataDir, "activity.jsonl");

export function log(event: string, data: unknown = {}) {
  const line = { time: new Date().toISOString(), event, data };
  console.log(JSON.stringify(line));
  try {
    mkdirSync(CONFIG.dataDir, { recursive: true });
    appendFileSync(logFile(), JSON.stringify(line) + "\n");
  } catch {}
}

export function tailLog(n = 40): any[] {
  if (!existsSync(logFile())) return [];
  const lines = readFileSync(logFile(), "utf8").trim().split("\n").slice(-n);
  return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
}

export const today = () => new Date().toISOString().slice(0, 10);
export const tradesToday = (s: State) => s.trades.filter((t) => t.time.startsWith(today()));
