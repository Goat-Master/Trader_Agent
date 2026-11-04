import { loadOutbox, saveOutbox, addEvent, loadState, stateExists, log } from "./store.js";
import { CONFIG } from "./config.js";
import { loadControls } from "./runtime.js";
import { writeTradePost, writeDailyRead, writeEduPost, writeLendPost } from "./agents/poster.js";
import { EDU_TOPICS } from "./topics.js";
import { reviewTweet } from "./agents/reviewer.js";
import { postTweet } from "./x.js";

// TWEETING AGENT
// Picks up events from the trading agent's outbox: Poster (AI) drafts -> Editor (AI) checks -> post on X (live) or keep as a draft.
// When switched off, new events are skipped (not queued), so turning it back on never floods X with stale posts.
const MAX_AGE_HOURS = 12;
const MAX_PER_RUN = 3;

export async function tweeterCycle() {
  const c = loadControls();
  if (c.tweeter.enabled) queueEduPost(c.trader.mode);
  const events = loadOutbox();
  const pending = events.filter((e) => e.status === "pending");
  if (!pending.length) return;
  const now = new Date().toISOString();

  if (!c.tweeter.enabled) {
    for (const e of pending) Object.assign(e, { status: "skipped", reason: "tweeting agent was off", handledAt: now });
    return saveOutbox(events);
  }

  let done = 0;
  for (const e of pending) {
    if ((Date.now() - Date.parse(e.time)) / 36e5 > MAX_AGE_HOURS) { Object.assign(e, { status: "expired", reason: `older than ${MAX_AGE_HOURS}h`, handledAt: now }); continue; }
    if (done >= MAX_PER_RUN) break;
    done++;
    try {
      const draft = e.kind === "trade" ? await writeTradePost(e.facts) : e.kind === "edu" ? await writeEduPost(e.facts) : e.kind === "lend" ? await writeLendPost(e.facts) : await writeDailyRead(e.facts);
      const v = await reviewTweet(draft, e.facts, e.kind);
      const text = v.fixedTweet?.trim() || draft;
      e.draft = draft;
      e.final = text;
      if (!v.approved || text.length > 280) Object.assign(e, { status: "blocked", reason: v.reason || "over 280 characters" });
      else if (c.tweeter.mode === "live") Object.assign(e, { status: "posted", tweetId: await postTweet(text), reason: v.reason });
      else Object.assign(e, { status: "draft", reason: v.reason });
      log(`tweet.${e.status}`, { kind: e.kind, text, reason: e.reason });
    } catch (err) {
      Object.assign(e, { status: "error", reason: (err as Error).message });
      log("tweet.error", { message: (err as Error).message });
    }
    e.handledAt = new Date().toISOString();
    saveOutbox(events);
  }
  saveOutbox(events);
}

// One educational post a day at EDU_POST_HOUR_UTC, rotating through the topic list
function queueEduPost(mode: "paper" | "live") {
  const now = new Date();
  if (now.getUTCHours() < CONFIG.eduPostHourUtc) return;
  const today = now.toISOString().slice(0, 10);
  const events = loadOutbox();
  const edu = events.filter((e) => e.kind === "edu");
  if (edu.some((e) => e.time.startsWith(today))) return;
  const recent = new Set(edu.slice(-20).map((e) => e.facts.topic));
  const start = edu.length % EDU_TOPICS.length;
  let topic = EDU_TOPICS[start];
  for (let i = 0; i < EDU_TOPICS.length; i++) { const t = EDU_TOPICS[(start + i) % EDU_TOPICS.length]; if (!recent.has(t)) { topic = t; break; } }
  const s = stateExists(mode) ? loadState(mode) : null;
  addEvent("edu", { topic, mode, paperTrading: mode === "paper", agentSnapshot: s?.lastSnapshot ?? null });
  log("edu.queued", { topic });
}
