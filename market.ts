import { CONFIG, TOKENS } from "./config.js";
import type { State } from "./store.js";
import { rt } from "./runtime.js";
import { tradingAddressSync } from "./wallets.js";

export type Market = Record<string, number>; // symbol -> USD price

// On-chain prices from Jupiter's public price API (numbers only, no outside text reaches the AI).
export async function getMarket(): Promise<Market> {
  const ids = Object.values(TOKENS).map((t) => t.mint).join(",");
  const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids}`);
  if (!res.ok) throw new Error(`price API ${res.status}`);
  const data = (await res.json()) as Record<string, { usdPrice?: number }>;
  const out: Market = {};
  for (const [sym, t] of Object.entries(TOKENS)) {
    const p = data[t.mint]?.usdPrice;
    if (typeof p !== "number" || !(p > 0)) throw new Error(`no price for ${sym}`);
    out[sym] = p;
  }
  return out;
}

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(CONFIG.solanaRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await res.json()) as { result?: any; error?: any };
  if (j.error) throw new Error(`RPC ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// Wallet balances in token units (paper mode uses the simulated balances).
export async function getBalances(state: State): Promise<Record<string, number>> {
  if (rt.tradeMode === "paper") return { ...state.paperBalances };
  const owner = tradingAddressSync();
  if (!owner) throw new Error("no trading wallet configured");
  return balancesOf(owner);
}

// Token balances (in token units) of any wallet address
export async function balancesOf(owner: string): Promise<Record<string, number>> {
  const out: Record<string, number> = Object.fromEntries(Object.keys(TOKENS).map((s) => [s, 0]));
  out.SOL = (await rpc("getBalance", [owner])).value / 1e9;
  for (const [sym, t] of Object.entries(TOKENS)) {
    if (sym === "SOL") continue;
    const r = await rpc("getTokenAccountsByOwner", [owner, { mint: t.mint }, { encoding: "jsonParsed" }]);
    for (const acc of r.value) out[sym] += acc.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
  }
  return out;
}

export function portfolioValue(balances: Record<string, number>, lent: number, m: Market) {
  const wallet = Object.entries(balances).reduce((a, [s, amt]) => a + amt * m[s], 0);
  return Math.round((wallet + lent) * 100) / 100;
}
