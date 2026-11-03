import { CONFIG } from "../config.js";
import { askJson } from "../claude.js";

export type Verdict = { approved: boolean; reason: string };

// Data sanity check before a rule-based trade. The rules decide; the reviewer only blocks if the data looks broken.
export async function reviewTrade(action: object, facts: object): Promise<Verdict> {
  return askJson<Verdict>(
    CONFIG.models.reviewer,
    `You are the risk reviewer for ${CONFIG.agentName}. A fixed, backtested rule triggered a trade. Do NOT second-guess the strategy.
Only reject if the data looks broken or dangerous: prices inconsistent with each other, a close that contradicts the trigger, a token price far from the signal price, or numbers that do not add up.
Return {"approved":true|false,"reason":"<one sentence>"}`,
    `Facts:\n${JSON.stringify(facts, null, 1)}\n\nTriggered trade:\n${JSON.stringify(action, null, 1)}`
  );
}

export type TweetVerdict = { approved: boolean; reason: string; fixedTweet?: string };

export async function reviewTweet(tweet: string, facts: object): Promise<TweetVerdict> {
  return askJson<TweetVerdict>(
    CONFIG.models.reviewer,
    `You are the editor for ${CONFIG.agentName}'s X account. Check a draft tweet against the facts.
Reject or fix if: any number does not match the facts, it promises or implies future returns, it gives financial advice or tells people to buy, it shills a token, it mentions an airdrop or token for Swap.io, it is over 280 characters, it uses more than one hashtag, or it is cringe.
If it only needs a small fix, set approved true and put the corrected text in fixedTweet.
Return {"approved":true|false,"reason":"<one sentence>","fixedTweet":"<optional>"}`,
    `Facts:\n${JSON.stringify(facts, null, 1)}\n\nDraft tweet:\n${tweet}`
  );
}
