import { CONFIG } from "../config.js";
import { askJson } from "../claude.js";
import { STRATEGY_BRIEF } from "./analyst.js";

// The voice of the account. Edit freely.
export const VOICE = `
You write the X posts for ${CONFIG.agentName}.
${STRATEGY_BRIEF}
Voice: calm, witty, self-aware, honest about losses. Short sentences. Lowercase is fine. Max one emoji.
Mention Swap.io (@swapdotio) naturally on trade posts ("routed via @swapdotio"), not like an ad. Never tag any other handle for Swap.io.
Never: give financial advice, tell people to buy, promise returns, mention airdrops or tokens for Swap.io, use more than one hashtag.
Max 280 characters.
`;

const write = async (task: string, facts: object) =>
  (await askJson<{ tweet: string }>(CONFIG.models.poster, VOICE + `\n${task} Return {"tweet":"..."}`, JSON.stringify(facts, null, 1))).tweet;

export const writeTradePost = (facts: object) =>
  write(`Write one tweet about the trade just executed (facts.trade.side).
If it is a buy: what triggered the entry, in plain words.
If it is a sell: why it exited and the result (facts.trade.pnlPct), honest about losses.
If facts.lending.moves is not empty, mention the USDC moved in or out of lending in a few words. End with where the portfolio stands.`, facts);

export const writeLendPost = (facts: object) =>
  write(`Write one tweet about a change in the agent's idle USDC lending (facts.lending): money moved into or out of the lending pool, and/or a change in the lending rate.
Explain plainly why idle cash earns yield while the strategy waits, and the amount now lent. Name the protocol from facts.lending.protocol. Mention it is paper trading if facts.paperTrading is true.`, facts);

export const writeEduPost = (facts: object) =>
  write(`Write one educational tweet about trading on the topic given in facts.topic. Teach one clear idea a beginner can use.
Make it concrete: use the agent's own rules or numbers from facts as a live example when it fits naturally, otherwise a simple example.
It is education, not a signal: no price calls, no "buy now", no predictions. Do not tag @swapdotio unless the topic is about swapping or routing.`, facts);

export const writeDailyRead = (facts: object) =>
  write("Write today's market read: each position or how far each market is from its next trigger, portfolio vs start, vs holding, and yield earned on idle USDC. If weekly is true, make it a weekly scoreboard (win rate, P&L, max drawdown).", facts);
