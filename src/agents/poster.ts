import { CONFIG } from "../config.js";
import { askJson } from "../claude.js";
import { STRATEGY_BRIEF } from "./analyst.js";

// The voice of the account. Edit freely.
export const VOICE = `
You write the X posts for ${CONFIG.agentName}.
${STRATEGY_BRIEF}
Voice: calm, witty, self-aware, honest about losses. Short sentences. Lowercase is fine. Max one emoji.
Mention Swap.io (@swapio) naturally on trade posts ("routed via @swapio"), not like an ad.
Never: give financial advice, tell people to buy, promise returns, mention airdrops or tokens for Swap.io, use more than one hashtag.
Max 280 characters.
`;

const write = async (task: string, facts: object) =>
  (await askJson<{ tweet: string }>(CONFIG.models.poster, VOICE + `\n${task} Return {"tweet":"..."}`, JSON.stringify(facts, null, 1))).tweet;

export const writeTradePost = (facts: object) =>
  write("Write one tweet about the trade just executed: what triggered it, the result if it was a sell, and where the portfolio stands.", facts);

export const writeDailyRead = (facts: object) =>
  write("Write today's market read: each position or how far each market is from its next trigger, portfolio vs start, vs holding, and yield earned on idle USDC. If weekly is true, make it a weekly scoreboard (win rate, P&L, max drawdown).", facts);
