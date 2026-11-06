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

// Public Solana RPCs rate-limit hard (HTTP 429), so retry with a short backoff before giving up.
async function rpc(method: string, params: unknown[]) {
  let last = "";
  for (let i = 0; i < 4; i++) {
    if (i) await new Promise((r) => setTimeout(r, 600 * i * i));
    try {
      const res = await fetch(CONFIG.solanaRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (res.status === 429 || res.status >= 500) { last = `RPC busy (${res.status})`; continue; }
      const j = (await res.json()) as { result?: any; error?: any };
      if (j.error) { last = `RPC ${method}: ${JSON.stringify(j.error).slice(0, 120)}`; if (/429|rate|too many/i.test(last)) continue; throw new Error(last); }
      return j.result;
    } catch (e) { last = (e as Error).message; if (/^RPC .*:/.test(last)) throw e; }
  }
  throw new Error(`${last}. The public Solana RPC is rate limiting: set SOLANA_RPC_URL to a free Helius or QuickNode endpoint`);
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
  // One call for every SPL token in the wallet, instead of one call per token
  const bySymbol = Object.fromEntries(Object.entries(TOKENS).filter(([s]) => s !== "SOL").map(([s, t]) => [t.mint, s]));
  const r = await rpc("getTokenAccountsByOwner", [owner, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed" }]);
  for (const acc of r.value) {
    const info = acc.account.data.parsed.info;
    const sym = bySymbol[info.mint];
    if (sym) out[sym] += info.tokenAmount.uiAmount ?? 0;
  }
  return out;
}

export function portfolioValue(balances: Record<string, number>, lent: number, m: Market) {
  const wallet = Object.entries(balances).reduce((a, [s, amt]) => a + amt * m[s], 0);
  return Math.round((wallet + lent) * 100) / 100;
}
