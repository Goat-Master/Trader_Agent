import type { Rule } from "./config.js";

// Strategy rules. Plain code, identical to the backtest. The AI does not change these.
// Signals use Binance daily closes (00:00 UTC). The agent acts right after each daily close.

export type Candle = { openTime: number; close: number };

export async function getDailyCloses(symbol: string, limit = 260): Promise<Candle[]> {
  const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1d&limit=${limit}`);
  if (!res.ok) throw new Error(`Binance ${symbol} ${res.status}`);
  const rows = (await res.json()) as any[];
  const now = Date.now();
  return rows.filter((r) => Number(r[6]) < now).map((r) => ({ openTime: Number(r[0]), close: Number(r[4]) })); // closed candles only
}

export type Signal = { target: 0 | 1; close: number; facts: Record<string, number> };

export function evaluate(rule: Rule, closes: number[], inPosition: boolean): Signal {
  const n = closes.length;
  const last = closes[n - 1];
  if (rule === "sma50") {
    if (n < 50) throw new Error("need 50 daily closes");
    const sma50 = closes.slice(n - 50).reduce((a, b) => a + b, 0) / 50;
    return { target: last > sma50 ? 1 : 0, close: last, facts: { sma50: round(sma50), distancePct: round((last / sma50 - 1) * 100, 2) } };
  }
  if (rule === "dip") {
    // Buy when RSI(2) < 10 while the close is above the 200-day average; sell on the first close above the 5-day average.
    if (n < 201) throw new Error("need 201 daily closes");
    const sma200 = closes.slice(n - 200).reduce((a, b) => a + b, 0) / 200;
    const sma5 = closes.slice(n - 5).reduce((a, b) => a + b, 0) / 5;
    const rsi2 = rsiWilder(closes, 2);
    const target = inPosition ? (last > sma5 ? 0 : 1) : rsi2 < 10 && last > sma200 ? 1 : 0;
    return { target, close: last, facts: { rsi2: round(rsi2, 1), sma5: round(sma5), sma200: round(sma200), aboveSma200: last > sma200 ? 1 : 0 } };
  }
  // donchian20_10: buy on a close above the prior 20-day high, sell on a close below the prior 10-day low
  if (n < 21) throw new Error("need 21 daily closes");
  const high20 = Math.max(...closes.slice(n - 21, n - 1));
  const low10 = Math.min(...closes.slice(n - 11, n - 1));
  const target = inPosition ? (last < low10 ? 0 : 1) : last > high20 ? 1 : 0;
  return { target, close: last, facts: { high20: round(high20), low10: round(low10), toBuyTriggerPct: round((high20 / last - 1) * 100, 2), toSellTriggerPct: round((low10 / last - 1) * 100, 2) } };
}

// Wilder RSI over the whole series (same as the backtest: seeded with the first change)
function rsiWilder(c: number[], n: number) {
  let up = NaN, dn = NaN;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], u = Math.max(d, 0), w = Math.max(-d, 0);
    up = Number.isNaN(up) ? u : u / n + up * (1 - 1 / n);
    dn = Number.isNaN(dn) ? w : w / n + dn * (1 - 1 / n);
  }
  return dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
}

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
