import { CONFIG } from "../config.js";
import { askJson } from "../claude.js";

// The Analyst (part of the trading agent). Trades follow backtested rules in code (signals.ts), so the backtest stays valid.
// The Analyst's job is judgment on top: explain each move in plain words and write the daily market read.
export const STRATEGY_BRIEF = `
${CONFIG.agentName} is an autonomous AI trading agent with a small public wallet on Solana. Every swap routes through Swap.io (6 routes, best price).
Strategy (${CONFIG.strategy}):
${CONFIG.sleeves.map((s) => `- ${Math.round(s.weight * 100)}% ${s.label}`).join("\n")}
- Idle USDC is lent on a major Solana lending protocol to earn yield while waiting.
Rules are fixed and backtested. Most trend trades lose small; profits come from a few big runs. Losing streaks are expected.
`;

export type Analysis = { headline: string; reasoning: string };

export async function explain(facts: object): Promise<Analysis> {
  return askJson<Analysis>(
    CONFIG.models.analyst,
    STRATEGY_BRIEF +
      `
You are the analyst. Given today's signals, positions and any actions taken, explain in plain English what happened and why, using ONLY the numbers provided.
Be honest about losses and about how far each market is from its next trigger.
Return {"headline":"<max 12 words>","reasoning":"<2 to 4 short sentences>"}`,
    JSON.stringify(facts, null, 1)
  );
}
