import type { AppSettings } from "./types";

export const GAMMA_API_URL =
  process.env.GAMMA_API_URL ?? "https://gamma-api.polymarket.com";
export const CLOB_API_URL =
  process.env.CLOB_API_URL ?? "https://clob.polymarket.com";
export const DATA_API_URL =
  process.env.DATA_API_URL ?? "https://data-api.polymarket.com";
export const CLOB_WS_URL =
  process.env.NEXT_PUBLIC_CLOB_WS_URL ??
  "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export const POLYMARKET_MARKET_URL = (slug: string) =>
  `https://polymarket.com/market/${slug}`;
export const POLYMARKET_EVENT_URL = (slug: string) =>
  `https://polymarket.com/event/${slug}`;

export const APP_NAME = "POLYQUANT";

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
};

/** how many markets the scanner pulls from Gamma per refresh */
export const SCANNER_MARKET_LIMIT = 300;
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
