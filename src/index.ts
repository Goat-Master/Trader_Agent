import { CONFIG } from "./config.js";
import { log } from "./store.js";
import { loadControls, prerequisites } from "./runtime.js";
import { traderCycle } from "./trader.js";
import { tweeterCycle } from "./tweeter.js";
import { startServer } from "./server.js";

// Two agents in one service, plus the dashboard:
//   Trading agent  every INTERVAL_MINUTES (acts once per daily close)   paper or live
//   Tweeting agent every TWEETER_INTERVAL_MINUTES                       drafts or live
// Both are switched on/off and between modes from the dashboard.

if (!CONFIG.anthropicKey) throw new Error("ANTHROPIC_API_KEY is missing");

let traderBusy = false, tweeterBusy = false;
async function runTrader() {
  if (traderBusy) return; traderBusy = true;
  try { await traderCycle(); } catch (e) { log("trader.error", { message: (e as Error).message }); } finally { traderBusy = false; }
}
async function runTweeter() {
  if (tweeterBusy) return; tweeterBusy = true;
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
