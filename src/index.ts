import { CONFIG } from "./config.js";
import { log } from "./store.js";
import { loadControls, prerequisites } from "./runtime.js";
import { traderCycle } from "./trader.js";
import { tweeterCycle } from "./tweeter.js";
import { startServer } from "./server.js";
import { storageProblem, dailyBackup } from "./persist.js";

// Two agents in one service, plus the dashboard:
//   Trading agent  every INTERVAL_MINUTES (acts once per daily close)   paper or live
//   Tweeting agent every TWEETER_INTERVAL_MINUTES                       drafts or live
// Both are switched on/off and between modes from the dashboard.

if (!CONFIG.anthropicKey) throw new Error("ANTHROPIC_API_KEY is missing");

let traderBusy = false, tweeterBusy = false;
function storageGate(agent: string) {
  const p = storageProblem();
  if (p) { log(`${agent}.paused`, { reason: p }); return false; }
  return true;
}
async function runTrader() {
  if (traderBusy || !storageGate("trader")) return; traderBusy = true;
  try { await traderCycle(); } catch (e) { log("trader.error", { message: (e as Error).message }); } finally { traderBusy = false; }
  try { const b = dailyBackup(); if (b) log("backup.created", { dir: b }); } catch (e) { log("backup.error", { message: (e as Error).message }); }
}
async function runTweeter() {
  if (tweeterBusy || storageProblem()) return; tweeterBusy = true;
  try { await tweeterCycle(); } catch (e) { log("tweeter.error", { message: (e as Error).message }); } finally { tweeterBusy = false; }
}

log("agent.start", { name: CONFIG.agentName, strategy: CONFIG.strategy, controls: loadControls(), prerequisites: prerequisites(), limits: CONFIG.limits });

if (process.argv.includes("--once")) {
  await runTrader();
  await runTweeter();
} else {
  startServer();
  await runTrader();
  await runTweeter();
  setInterval(runTrader, CONFIG.intervalMinutes * 60_000);
  setInterval(runTweeter, CONFIG.tweeterIntervalMinutes * 60_000);
}
