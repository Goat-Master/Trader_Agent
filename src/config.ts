// All settings come from environment variables (set them in Railway > Variables).

const env = (k: string, d: string) => process.env[k] ?? d;
const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return process.env[k] !== undefined && Number.isFinite(v) ? v : d;
};

export type Rule = "sma50" | "donchian20_10" | "dip";
export type Sleeve = { id: string; asset: string; signalSymbol: string; rule: Rule; weight: number; label: string };

// Backtested on Binance daily closes, 30 bps costs per round trip, idle USDC at 4%.
//                       5 years (Nov 2021 to Nov 2026)     Post Trump election (Jan 22 2025 to Nov 1 2026)
//   dip_breakout        +449%, max DD -28%, 61% wins       +29%, max DD -19%, 63% wins   (default)
//   combo               +483%, max DD -54%, 35% wins       +32%, max DD -24%, 35% wins
//   btc_trend           +140%, max DD -57%, 23% wins       +18%, max DD -25%, 23% wins
//   sol_breakout        +826%, max DD -53%, 53% wins       +46%, max DD -33%, 58% wins   (fragile settings)
const DIP = { id: "btcDip", asset: "cbBTC", signalSymbol: "BTCUSDT", rule: "dip" as Rule, label: "BTC dip buy (RSI(2) under 10 while above 200-day average, sell on close above 5-day average)" };
const STRATEGIES: Record<string, Sleeve[]> = {
  dip_breakout: [
    { ...DIP, weight: 0.5 },
    { id: "solBreakout", asset: "SOL", signalSymbol: "SOLUSDT", rule: "donchian20_10", weight: 0.5, label: "SOL breakout (20-day high in, 10-day low out)" },
  ],
  combo: [
    { id: "btcTrend", asset: "cbBTC", signalSymbol: "BTCUSDT", rule: "sma50", weight: 0.5, label: "BTC trend (above 50-day average)" },
    { id: "solBreakout", asset: "SOL", signalSymbol: "SOLUSDT", rule: "donchian20_10", weight: 0.5, label: "SOL breakout (20-day high in, 10-day low out)" },
  ],
  btc_trend: [{ id: "btcTrend", asset: "cbBTC", signalSymbol: "BTCUSDT", rule: "sma50", weight: 1, label: "BTC trend (above 50-day average)" }],
  btc_dip: [{ ...DIP, weight: 1 }],
  sol_breakout: [{ id: "solBreakout", asset: "SOL", signalSymbol: "SOLUSDT", rule: "donchian20_10", weight: 1, label: "SOL breakout (20-day high in, 10-day low out)" }],
};

const strategy = env("STRATEGY", "dip_breakout");
if (!STRATEGIES[strategy]) throw new Error(`unknown STRATEGY ${strategy}`);

export const CONFIG = {
  agentName: env("AGENT_NAME", "Route"),
  strategy,
  sleeves: STRATEGIES[strategy],
  intervalMinutes: num("INTERVAL_MINUTES", 60), // how often it checks; it acts once per new daily close
  includeTxLink: env("INCLUDE_TX_LINK", "off") === "on",
  killSwitch: env("KILL_SWITCH", "off") === "on", // emergency override: blocks all swaps whatever the dashboard says
  startUsdc: num("PAPER_START_USDC", 300),

  models: {
    analyst: env("ANALYST_MODEL", "claude-sonnet-5-5"),
    reviewer: env("REVIEWER_MODEL", "claude-sonnet-5-5"),
    poster: env("POSTER_MODEL", "claude-haiku-5-5"),
  },

  // Hard limits, enforced in code before anything is signed.
  limits: {
    maxTradeUsd: num("MAX_TRADE_USD", 400),
    maxTradesPerDay: num("MAX_TRADES_PER_DAY", 4),
    maxSlippageBps: num("MAX_SLIPPAGE_BPS", 100),
    maxPriceGapPct: num("MAX_PRICE_GAP_PCT", 2), // on-chain price vs Binance signal price (catches depegs, bad data)
    minSolForFees: num("MIN_SOL_FOR_FEES", 0.02),
  },

  // USDC lending (idle cash). paper trading always simulates it (unless off). Live trading lends only with LEND_MODE=live (Kamino, dev must wire).
  lending: {
    mode: env("LEND_MODE", "paper") as "off" | "paper" | "live",
    paperApy: num("LEND_PAPER_APY", 0.04),
    cashBufferUsd: num("CASH_BUFFER_USD", 25), // always kept unlent so a buy never waits on a withdrawal
    protocol: env("LEND_PROTOCOL", "Kamino"),
    postMinUsd: num("LEND_POST_MIN_USD", 25), // lending moves at or above this get posted
    apyChangeAlert: num("LEND_APY_CHANGE_ALERT", 0.01), // post when the rate moves by this much (0.01 = 1 point)
  },

  dataDir: env("DATA_DIR", "./data"),
  dashboardPassword: env("DASHBOARD_PASSWORD", ""),
  port: num("PORT", 3000),
  tweeterIntervalMinutes: num("TWEETER_INTERVAL_MINUTES", 5),
  testSwapMaxUsd: num("TEST_SWAP_MAX_USD", 5),
  walletAdmin: {
    maxSol: num("FUND_MAX_SOL", 0.1), // cap per funding transfer
    maxUsdc: num("FUND_MAX_USDC", 50),
    maxWallets: num("MAX_BOT_WALLETS", 10), // test wallets the bot may create
  }, // cap for dashboard test swaps (also needs ALLOW_TEST_SWAPS=yes)
  eduPostHourUtc: num("EDU_POST_HOUR_UTC", 14), // daily educational post (14:00 UTC = afternoon EU, morning US)
  tradePosts: env("TRADE_POSTS", "all") as "open" | "all", // all = post when a trade opens and when it closes, open = opens only
  anthropicKey: env("ANTHROPIC_API_KEY", ""),
  solanaRpc: env("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
  walletAddress: env("WALLET_ADDRESS", ""),
  walletSecret: env("WALLET_SECRET_KEY", ""), // only read inside swapio.ts / lending.ts, never passed to any AI
  swapioApiUrl: env("SWAPIO_API_URL", ""),
  swapioApiKey: env("SWAPIO_API_KEY", ""),
  x: {
    apiKey: env("X_API_KEY", ""),
    apiSecret: env("X_API_SECRET", ""),
    accessToken: env("X_ACCESS_TOKEN", ""),
    accessSecret: env("X_ACCESS_SECRET", ""),
  },
};

// Whitelist. Nothing else can be traded.
export const TOKENS: Record<string, { mint: string; decimals: number }> = {
  SOL: { mint: "So11111111111111111111111111111111111111112", decimals: 9 },
  USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  cbBTC: { mint: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", decimals: 8 }, // Coinbase Wrapped BTC
};
