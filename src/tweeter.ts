import { loadOutbox, saveOutbox, log } from "./store.js";
import { loadControls } from "./runtime.js";
import { writeTradePost, writeDailyRead } from "./agents/poster.js";
import { reviewTweet } from "./agents/reviewer.js";
import { postTweet } from "./x.js";

// TWEETING AGENT
// Picks up events from the trading agent's outbox: Poster (AI) drafts -> Editor (AI) checks -> post on X (live) or keep as a draft.
// When switched off, new events are skipped (not queued), so turning it back on never floods X with stale posts.
const MAX_AGE_HOURS = 12;
const MAX_PER_RUN = 3;

export async function tweeterCycle() {
  const c = loadControls();
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
      const draft = e.kind === "trade" ? await writeTradePost(e.facts) : await writeDailyRead(e.facts);
      const v = await reviewTweet(draft, e.facts);
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
