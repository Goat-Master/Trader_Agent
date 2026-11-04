import { CONFIG } from "./config.js";
import { loadState, saveState, log, addEvent, type State, type Trade } from "./store.js";
import { getMarket, getBalances, portfolioValue, type Market } from "./market.js";
import { getDailyCloses, evaluate, type Signal } from "./signals.js";
import { accrue, lentBalance, deposit, withdraw, currentApy } from "./lending.js";
import { explain } from "./agents/analyst.js";
import { reviewTrade } from "./agents/reviewer.js";
import { checkTrade } from "./guard.js";
import { executeSwap } from "./swapio.js";
import { loadControls, rt, lendMode } from "./runtime.js";

// TRADING AGENT
// Every INTERVAL_MINUTES: refresh the portfolio for the dashboard.
// Once per new daily close (00:00 UTC): rules (code) -> guard (code) -> reviewer (AI data check) -> swap -> lend idle USDC
// -> analyst explains -> events dropped in the outbox for the tweeting agent.
export async function traderCycle() {
  const c = loadControls();
  if (!c.trader.enabled) return;
  rt.tradeMode = c.trader.mode;

  const state = loadState(rt.tradeMode);
  shareInterest(state, accrue(state));

  const symbols = [...new Set([...CONFIG.sleeves.map((s) => s.signalSymbol), "BTCUSDT", "SOLUSDT"])];
  const candles = Object.fromEntries(await Promise.all(symbols.map(async (s) => [s, await getDailyCloses(s)] as const)));
  const market = await getMarket();
  const closeOf = (sym: string) => candles[sym].at(-1)!.close;
  if (!state.startPrices) state.startPrices = { BTC: closeOf("BTCUSDT"), SOL: closeOf("SOLUSDT") };

  // Live ledger: split the real wallet's USDC across the sleeves the first time
  if (state.needsFunding) {
    const b = await getBalances(state);
    const usdc = b.USDC + (await lentBalance(state));
    for (const sl of CONFIG.sleeves) state.sleeves[sl.id].usdc = usdc * sl.weight;
    state.needsFunding = false;
    log("live.funded", { usdc: round2(usdc) });
  }

  const dayKey = new Date(candles[symbols[0]].at(-1)!.openTime).toISOString().slice(0, 10);
  if (state.lastProcessedDay !== dayKey) {
    if (CONFIG.killSwitch) log("cycle.skipped", { reason: "KILL_SWITCH env is on" });
    else await dailyRun(state, market, candles, dayKey);
  }

  state.lastSnapshot = await snapshot(state, market, candles);
  saveState(state);
}

async function dailyRun(state: State, market: Market, candles: Record<string, { close: number }[]>, dayKey: string) {
  const executed: { trade: Trade; label: string }[] = [];
  const lendMoves: { action: "deposit" | "withdraw"; amountUsd: number; reason: string }[] = [];

  for (const sl of CONFIG.sleeves) {
    const st = state.sleeves[sl.id];
    const sig: Signal = evaluate(sl.rule, candles[sl.signalSymbol].map((c) => c.close), st.inPosition);
    const wantIn = sig.target === 1;
    state.signals[sl.id] = { label: sl.label, asset: sl.asset, rule: sl.rule, target: sig.target, signalClose: sig.close, ...sig.facts, evaluatedFor: dayKey };
    if (wantIn === st.inPosition) continue;

    let balances = await getBalances(state);
    let from = "USDC", to = sl.asset, amountIn = st.usdc;
    if (wantIn) {
      const short = amountIn - balances.USDC;
      if (short > 0) {
        const moved = await withdraw(state, short + 0.01);
        if (moved > 0) lendMoves.push({ action: "withdraw", amountUsd: round2(moved), reason: `to buy ${sl.asset}` });
        balances = await getBalances(state);
      }
      amountIn = Math.min(amountIn, balances.USDC);
    } else {
      from = sl.asset; to = "USDC";
      const spendable = sl.asset === "SOL" ? balances.SOL - CONFIG.limits.minSolForFees : balances[sl.asset];
      amountIn = Math.min(st.units, spendable);
    }
    const action = { sleeve: sl.id, side: wantIn ? "buy" : "sell", from, to, amountIn, rule: sl.rule, signal: sig, mode: rt.tradeMode };

    const g = checkTrade({ from, to, amountIn, signalPrice: sig.close, asset: sl.asset }, balances, market, state);
    if (!g.ok) { log("guard.rejected", { reason: g.reason, action }); continue; }
    const v = await reviewTrade(action, { market, signal: sig, sleeve: st });
    log("reviewer.trade", v);
    if (!v.approved) { log("trade.blocked_by_reviewer", { reason: v.reason, action }); continue; }

    const r = await executeSwap(from, to, amountIn, market, state);
    const trade: Trade = { time: new Date().toISOString(), sleeve: sl.id, side: wantIn ? "buy" : "sell", asset: sl.asset, amountIn: r.amountIn, amountOut: r.amountOut, price: market[sl.asset], txSig: r.txSig, mode: rt.tradeMode };
    if (wantIn) Object.assign(st, { inPosition: true, units: r.amountOut, usdc: 0, costUsdc: r.amountIn, entryPrice: market[sl.asset], entryTime: trade.time });
    else {
      trade.pnlPct = st.costUsdc ? pct(r.amountOut / st.costUsdc - 1) : undefined;
      Object.assign(st, { inPosition: false, units: 0, usdc: r.amountOut, costUsdc: null, entryPrice: null, entryTime: null });
    }
    state.trades.push(trade);
    log("trade.executed", trade);
    executed.push({ trade, label: sl.label });
    saveState(state);
  }

  // Lend idle USDC, keeping a cash buffer so a buy never waits on a withdrawal
  const bal = await getBalances(state);
  if (bal.USDC > CONFIG.lending.cashBufferUsd + 1) {
    const moved = await deposit(state, bal.USDC - CONFIG.lending.cashBufferUsd);
    if (moved > 0) lendMoves.push({ action: "deposit", amountUsd: round2(moved), reason: executed.length ? "parking the proceeds of today's sale" : "idle USDC" });
  }
  // Rate changes on the lending pool
  const apy = await currentApy();
  const rateChange = apy !== null && state.lastLendApy != null && Math.abs(apy - state.lastLendApy) >= CONFIG.lending.apyChangeAlert
    ? { fromPct: round2(state.lastLendApy * 100), toPct: round2(apy * 100) } : null;
  if (apy !== null) state.lastLendApy = apy;

  const facts = await snapshot(state, market, candles);
  state.equity.push({ date: dayKey, value: facts.portfolioUsd, btc: candles.BTCUSDT.at(-1)!.close, sol: candles.SOLUSDT.at(-1)!.close });

  // Hand over to the tweeting agent
  const lending = { moves: lendMoves, usdcLent: facts.usdcLent, apyPct: apy === null ? null : round2(apy * 100), protocol: CONFIG.lending.protocol, rateChange };
  for (const e of executed) {
    if (CONFIG.tradePosts === "open" && e.trade.side !== "buy") continue;
    const f = { ...facts, lending, trade: { ...e.trade, rule: e.label, txLink: CONFIG.includeTxLink && rt.tradeMode === "live" ? `https://solscan.io/tx/${e.trade.txSig}` : undefined } };
    addEvent("trade", { ...f, analyst: await explain(f) });
  }
  // Lending changes not tied to a trade get their own post (moves tied to a trade go in that trade's post)
  const bigMoves = lendMoves.filter((m) => m.amountUsd >= CONFIG.lending.postMinUsd);
  if ((!executed.length && bigMoves.length) || rateChange) addEvent("lend", { ...facts, lending });

  const analysis = await explain(facts);
  state.lastAnalysis = { ...analysis, date: dayKey };
  addEvent("daily", { ...facts, analyst: analysis, weekly: new Date().getUTCDay() === 1 });

  state.lastProcessedDay = dayKey;
  log("daily.done", { day: dayKey, mode: rt.tradeMode, trades: executed.length, value: facts.portfolioUsd });
}

async function snapshot(state: State, market: Market, candles: Record<string, { close: number }[]>) {
  const value = portfolioValue(await getBalances(state), await lentBalance(state), market);
  if (state.startValueUsd === null) state.startValueUsd = value;
  state.peakValue = Math.max(state.peakValue, value);
  state.maxDrawdownPct = Math.min(state.maxDrawdownPct, pct(value / state.peakValue - 1));
  const sells = state.trades.filter((t) => t.side === "sell" && t.pnlPct !== undefined);
  const positions = Object.fromEntries(CONFIG.sleeves.map((sl) => {
    const st = state.sleeves[sl.id];
    return [sl.id, { label: sl.label, asset: sl.asset, inPosition: st.inPosition, entryPrice: st.entryPrice, entryTime: st.entryTime,
      openPnlPct: st.inPosition && st.costUsdc ? pct((st.units * market[sl.asset]) / st.costUsdc - 1) : null,
      valueUsd: round2(st.inPosition ? st.units * market[sl.asset] : st.usdc) }];
  }));
  return {
    time: new Date().toISOString(),
    paperTrading: rt.tradeMode === "paper",
    mode: rt.tradeMode,
    strategy: CONFIG.strategy,
    signals: state.signals,
    positions,
    portfolioUsd: value,
    startValueUsd: state.startValueUsd,
    changeSinceStartPct: pct(value / state.startValueUsd - 1),
    maxDrawdownPct: state.maxDrawdownPct,
    holdingBtcSinceStartPct: pct(candles.BTCUSDT.at(-1)!.close / state.startPrices!.BTC - 1),
    holdingSolSinceStartPct: pct(candles.SOLUSDT.at(-1)!.close / state.startPrices!.SOL - 1),
    usdcLent: round2(await lentBalance(state)),
    lending: lendMode(),
    yieldEarnedUsd: round2(state.interestEarned),
    closedTrades: sells.length,
    winRatePct: sells.length ? pct(sells.filter((t) => t.pnlPct! > 0).length / sells.length) : null,
    daysRunning: Math.max(1, Math.ceil((Date.now() - Date.parse(state.startedAt)) / 864e5)),
  };
}

// Lending interest belongs to the sleeves that are sitting in USDC
function shareInterest(state: State, interest: number) {
  const idle = Object.values(state.sleeves).filter((s) => !s.inPosition && s.usdc > 0);
  const total = idle.reduce((a, s) => a + s.usdc, 0);
  if (total > 0) for (const s of idle) s.usdc += interest * (s.usdc / total);
}

const pct = (x: number) => Math.round(x * 10000) / 100;
const round2 = (x: number) => Math.round(x * 100) / 100;
