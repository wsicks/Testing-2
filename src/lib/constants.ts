import type { AppSettings, AutopilotConfig } from "./types";

export const GAMMA_API_URL =
  process.env.GAMMA_API_URL ?? "https://gamma-api.polymarket.com";
export const CLOB_API_URL =
  process.env.CLOB_API_URL ?? "https://clob.polymarket.com";
export const DATA_API_URL =
  process.env.DATA_API_URL ?? "https://data-api.polymarket.com";
export const CLOB_WS_URL =
  process.env.NEXT_PUBLIC_CLOB_WS_URL ??
  "wss://ws-subscriptions-clob.polymarket.com/ws/market";

// ── Multi-venue endpoints (official public APIs only — never scraped) ────────
export const KALSHI_API_URL =
  process.env.KALSHI_API_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
/** Kalshi demo/sandbox environment — separate host, separate credentials */
export const KALSHI_DEMO_API_URL =
  process.env.KALSHI_DEMO_API_URL ?? "https://demo-api.kalshi.co/trade-api/v2";
export const COINBASE_API_URL =
  process.env.COINBASE_API_URL ?? "https://api.coinbase.com/api/v3/brokerage";
export const COINGECKO_API_URL =
  process.env.COINGECKO_API_URL ?? "https://api.coingecko.com/api/v3";

/** curated liquid Coinbase spot products served as reference/charting markets */
export const COINBASE_PRODUCTS = (
  process.env.COINBASE_PRODUCTS ?? "BTC-USD,ETH-USD,SOL-USD,XRP-USD,DOGE-USD"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** CoinGecko ids tracked as reference prices */
export const COINGECKO_IDS = (
  process.env.COINGECKO_IDS ?? "bitcoin,ethereum,solana"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const APP_NAME = "POLYQUANT";

/**
 * Autopilot defaults: OFF until the user enables it. Paper autopilot is one
 * switch; live autopilot additionally requires the live gate plus an explicit
 * time-boxed arming ritual. Sizing is deliberately small.
 */
export const DEFAULT_AUTOPILOT: AutopilotConfig = {
  mode: "off",
  // dislocation removed from defaults: its walk-forward backtest measured
  // -0.50c/entry after friction (0/4 folds positive) — the backtest gate
  // blocks it anyway, and defaults should not contradict the evidence
  enabledStrategies: ["microstructure", "price_movement", "favorite_convergence"],
  entryStyle: "maker",
  makerRestMin: 5,
  minScore: 60,
  perTradeUsd: 25,
  maxOpenPositions: 5,
  maxTradesPerHour: 12,
  maxSessionNotionalUsd: 500,
  sessionMaxLossUsd: 50,
  targetPct: 12,
  stopPct: 8,
  trailPct: 6,
  maxHoldMin: 240,
  flattenBeforeCloseMin: 30,
  requireRegimeMatch: true,
};

/**
 * Alpha Foundry / Wallet Radar defaults: research on, following watch-only,
 * live wallet-copying OFF (and further gated by promotion + approval + the
 * per-venue live gate + per-order confirmation even when turned on).
 */
export const DEFAULT_ALPHA: AppSettings["alpha"] = {
  foundryEnabled: true,
  walletFollowMode: "watch_only",
  walletLiveEnabled: false,
  maxCopyDriftCents: 2,
  maxWalletEntryAgeMin: 720,
  minWalletSampleSize: 20,
  minWalletForwardSamples: 10,
  testOrderUsd: 25,
  arbEnabled: true, // paper book only; math-locked pairs, never directional
};

export const DEFAULT_SETTINGS: AppSettings = {
  // risk
  defaultMode: "demo",
  maxTradePct: 1,
  maxTradeUsd: 250,
  maxDailyLossUsd: 100,
  maxMarketExposurePct: 5,
  maxCategoryExposurePct: 15,
  minLiquidityUsd: 5_000,
  maxSpread: 0.03,
  minSignalScore: 55,
  orderExpirationMin: 240,
  kellyCap: 0.25,
  feeRateBps: 0,
  slippageBps: 50,
  typedConfirmThresholdUsd: 100,
  staleDataMaxSecs: 60,
  closingSoonHours: 48,
  // prefs
  watchlist: [],
  categories: [],
  termsAcceptedAt: undefined,
  liveModeEnabled: false,
  killSwitch: false,
  scannersEnabled: true,
  paperStartingCash: 10_000,
  autopilot: DEFAULT_AUTOPILOT,
  alpha: DEFAULT_ALPHA,
  // public data on; paper on; live LOCKED — independently per venue
  venues: {
    polymarket: { publicData: true, paperTrading: true, liveEnabled: false },
    kalshi: { publicData: true, paperTrading: true, liveEnabled: false },
    coinbase: { publicData: true, paperTrading: true, liveEnabled: false },
    coingecko: { publicData: true },
  },
};

/** how many EVENTS the scanner pulls from Gamma per refresh (each event
 * nests several markets — 100 events ≈ 1,900 tokenized markets) */
export const SCANNER_EVENT_LIMIT = 100;
/** how many top markets get CLOB order-book enrichment per scan */
export const SCANNER_BOOK_LIMIT = 12;
/** gamma market list cache TTL (ms) */
export const MARKETS_CACHE_TTL = 15_000;
/** market detail (book/history/trades) cache TTL (ms) */
export const DETAIL_CACHE_TTL = 8_000;
/** minimum ms between full signal scans */
export const SCAN_MIN_INTERVAL = 20_000;

export const NEW_MARKET_HOURS = 48;

export const CATEGORY_FALLBACK = "Uncategorized";
