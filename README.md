# Swap.io AI Trading Agent (v2)

An autonomous agent that trades a small Solana wallet through Swap.io, lends its idle USDC, and posts about it on X.

## Strategy

Backtested on Binance daily closes, 30 bps costs per round trip, idle USDC earning 4%:

| `STRATEGY` | 5 years (Nov 2021 to Nov 2026) | Post Trump election (Jan 22, 2025 to Nov 1, 2026) |
|---|---|---|
| `dip_breakout` (default): 50% BTC dip buy + 50% SOL breakout | +449%, max DD -28%, 61% wins | +29%, max DD -19%, 63% wins |
| `combo`: 50% BTC trend + 50% SOL breakout | +483%, max DD -54%, 35% wins | +32%, max DD -24%, 35% wins |
| `btc_trend`: cbBTC while BTC is above its 50-day average | +140%, max DD -57%, 23% wins | +18%, max DD -25%, 23% wins |
| `btc_dip`: BTC dip buy only | +72%, max DD -23%, 68% wins | +12%, max DD -12%, 67% wins |
| `sol_breakout`: SOL 20-day high in, 10-day low out | +826%, max DD -53%, 53% wins | +46%, max DD -33%, 58% wins (fragile settings) |
| Hold BTC (benchmark) | +24%, max DD -77% | -25%, max DD -53% |

BTC dip buy: buy when RSI(2) drops under 10 while BTC closes above its 200-day average, sell on the first close above the 5-day average.
Most of its time is spent in USDC earning yield. Past results do not guarantee future ones.

## How it works

Two agents in one Railway service, plus a dashboard:

```
TRADING AGENT   hourly check, acts once per daily close (00:00 UTC)        Paper or Live
  1. RULES (code)     Binance daily closes -> in or out, per leg (signals.ts)
  2. GUARD (code)     whitelist, limits, on-chain price vs signal price, kill switch
  3. REVIEWER (AI)    data sanity check, blocks only if the data looks broken
  4. SWAP             through Swap.io (simulated in paper mode)
  5. LEND             idle USDC, keeping CASH_BUFFER_USD in the wallet
  6. ANALYST (AI)     explains the day, drops trade and daily events in the outbox

TWEETING AGENT  every 5 minutes                                            Drafts or Live
  7. POSTER (AI)      writes the post for each event
  8. EDITOR (AI)      checks facts, no financial advice, under 280 chars
  9. X                posts it (Live) or keeps it as a draft (Drafts)
```

The rules are in code because they are exactly what the backtest measured.

## Dashboard

Open the Railway public link (Settings > Networking > Generate Domain), log in with any username and `DASHBOARD_PASSWORD`.

- **Controls:** each agent has On/Off and a mode switch (Paper/Live for trading, Drafts/Live for tweets). Live needs you to type LIVE to confirm, and stays locked until Railway has what it needs (wallet, `SWAPIO_API_URL` and `ALLOW_LIVE_TRADING=yes` for trading; the 4 X keys for tweets).
- **Separate ledgers:** paper and live keep their own positions and history. The first live run splits the real wallet's USDC across the legs.
- **Tweets off = skipped, not queued:** turning tweets back on never floods X with stale posts. Events older than 12 hours expire.
- **Shows:** value vs holding BTC and SOL, positions and next triggers, the analyst's latest read, trades, tweets (posted, drafts, blocked and why), recent activity.
- `KILL_SWITCH=on` in Railway blocks all swaps whatever the dashboard says.

Safety:
- Only `swapio.ts` and `lending.ts` touch the wallet key. No AI ever sees it, and the dashboard never shows secrets.
- No text from X or the web reaches the AIs. They only see numbers.
- Controls need the password, a custom header and a JSON body, which blocks cross-site requests.

## Files you will edit

| What | Where |
|---|---|
| Strategy, name, limits, modes | Railway Variables (see `.env.example`) |
| Analyst brief | `src/agents/trader.ts` |
| Tweet voice | `src/agents/poster.ts` |
| Reviewer strictness | `src/agents/reviewer.ts` |

## Setup (no local install)

1. **GitHub:** private repo, upload all files. No `.env` file.
2. **Anthropic:** API key at console.anthropic.com, set a monthly spend limit.
3. **Railway:** New Project > Deploy from GitHub repo.
   - Start command: `npm start`
   - Add a **Volume** mounted at `/data`
   - Variables from `.env.example` (at minimum `ANTHROPIC_API_KEY`, `DATA_DIR=/data`, `DASHBOARD_PASSWORD`)
   - Settings > Networking > **Generate Domain** for the dashboard link
4. **Dashboard:** open the link, log in, watch the first daily close.

## Going live, in stages

| Stage | Settings | How long |
|---|---|---|
| 1. Paper + Drafts | Dashboard defaults | 2 weeks. Read the drafted tweets on the dashboard |
| 2. Paper + Live tweets | Add the X keys, switch tweets to Live | Optional: build the account in public |
| 3. Live, small | Wallet + `SWAPIO_API_URL` + `ALLOW_LIVE_TRADING=yes`, switch trading to Live, $50 wallet | After the dev review |
| 4. Live + lending | `LEND_MODE=live` once Kamino is wired, fund to $200 to $500 | After stage 3 behaves |

**Stop trading:** switch the trading agent Off on the dashboard, or `KILL_SWITCH=on` in Railway.

## Dev checklist before live (about 2 to 4 hours)

- [ ] Wire `liveSwap()` in `src/swapio.ts` to the real Swap.io API (marked TODO)
- [ ] Wire Kamino Lend deposit, withdraw and balance in `src/lending.ts` (marked TODO), main market USDC reserve
- [ ] Check cbBTC liquidity on Solana for a $150 swap (price impact under 0.5%)
- [ ] Test one $5 swap each way, and one $5 deposit and withdrawal
- [ ] Review `guard.ts` and key handling
- [ ] Paid RPC (Helius, Triton) instead of the public one
- [ ] Commit the lockfile

## Risks to know

- **Lending withdrawals can stall** if a pool is fully borrowed (Jupiter Lend USDC hit 99% utilization in April 2026). The cash buffer covers part of a buy; for a full buy the agent withdraws first. A dev can split deposits across Kamino and a second protocol.
- **cbBTC** depends on Coinbase as custodian. The price gap check stops trading if it depegs.
- **Losing streaks** are normal for trend strategies. Say so in the bio and post every loss.

## Costs (rough, monthly)

Railway $5 to $10. Claude API $5 to $20 (one main run per day). X API about $1 to $3 for one or two posts a day without links.
