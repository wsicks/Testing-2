// Kalshi venue adapter — official public REST API (trade-api/v2), read-only.
// Kalshi contracts are REGULATED event contracts: their own tickers, fees,
// expiration and settlement rules. They are normalized for display and paper
// trading only; nothing here assumes a Kalshi contract resolves like any
// similarly-titled market elsewhere. Live Kalshi trading requires explicit
// credentials + venue terms acknowledgment and ships locked (kalshiLive.ts).
//
// Field notes (verified against the live API): current responses use
// *_dollars / *_fp string fields (e.g. yes_bid_dollars, volume_24h_fp); older
// docs describe integer-cent fields. Both are parsed. The order book is
// expressed as YES bids and NO bids; YES asks derive as (1 − NO bid).

import { KALSHI_API_URL } from "@/lib/constants";
import { getJson, qs, type HttpOpts } from "@/lib/polymarket/http";
import type {
  BookLevel,
  NormalizedMarket,
  OrderBookData,
  RecentTrade,
  VenueCapabilities,
} from "@/lib/types";
import { recordSourceFailure, recordSourceSuccess } from "./sourceStatus";
import type { SourceMetaStatic, VenueAdapter } from "./types";

export const KALSHI_META: SourceMetaStatic = {
  name: "Kalshi (official REST API)",
  licenseNote:
    "Official Kalshi trade API; public market data per Kalshi API terms. Regulated US event contracts (CFTC).",
  updateFrequency: "REST polling, 15s cache",
  rateLimitNote: "Kalshi basic tier rate limits apply; requests are cached and batched",
  dataClass: "tradable",
};

export const KALSHI_CAPABILITIES: VenueCapabilities = {
  publicData: true,
  orderBooks: true,
  candles: true,
  trades: true,
  paperTrading: true,
  liveTrading: false, // adapter present but locked until credentials + terms
  referenceOnly: false,
};

// ── raw shapes (both current *_dollars/_fp and legacy cent variants) ─────────

interface KalshiMarketRaw {
  ticker: string;
  event_ticker?: string;
  market_type?: string;
  title?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  status?: string;
  open_time?: string;
  close_time?: string;
  expiration_time?: string;
  rules_primary?: string;
  rules_secondary?: string;
  mve_collection_ticker?: string;
  is_provisional?: boolean;
  // current API
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  previous_price_dollars?: string;
  volume_fp?: string;
  volume_24h_fp?: string;
  liquidity_dollars?: string;
  open_interest_fp?: string;
  // legacy (integer cents)
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  last_price?: number;
  previous_price?: number;
  volume?: number;
  volume_24h?: number;
  liquidity?: number;
  open_interest?: number;
}

interface KalshiEventRaw {
  event_ticker: string;
  series_ticker?: string;
  title?: string;
  sub_title?: string;
  category?: string;
  mutually_exclusive?: boolean;
  settlement_sources?: { name?: string; url?: string }[];
  markets?: KalshiMarketRaw[];
}

/** parse "0.8300" dollars OR legacy integer cents into a 0..1 price */
export function kalshiPrice(dollars?: string, cents?: number): number | undefined {
  if (dollars !== undefined) {
    const v = Number(dollars);
    return Number.isFinite(v) ? v : undefined;
  }
  if (cents !== undefined && Number.isFinite(cents)) return cents / 100;
  return undefined;
}

function fp(fpStr?: string, legacy?: number): number {
  if (fpStr !== undefined) {
    const v = Number(fpStr);
    if (Number.isFinite(v)) return v;
  }
  return legacy ?? 0;
}

export const ksMarketKey = (ticker: string) => `ks:${ticker}`;
export const ksYesToken = (ticker: string) => `ks:${ticker}:yes`;
export const ksNoToken = (ticker: string) => `ks:${ticker}:no`;
export function parseKsToken(tokenId: string): { ticker: string; side: "yes" | "no" } | null {
  const m = /^ks:(.+):(yes|no)$/.exec(tokenId);
  return m ? { ticker: m[1], side: m[2] as "yes" | "no" } : null;
}

export function normalizeKalshiMarket(
  m: KalshiMarketRaw,
  event: KalshiEventRaw | undefined,
  now = Date.now(),
): NormalizedMarket | null {
  if (!m.ticker) return null;
  // skip synthetic multivariate combo legs and non-binary structures
  if (m.mve_collection_ticker || (m.market_type && m.market_type !== "binary")) return null;
  if (m.status && m.status !== "active" && m.status !== "open") return null;

  const yesBid = kalshiPrice(m.yes_bid_dollars, m.yes_bid);
  const yesAsk = kalshiPrice(m.yes_ask_dollars, m.yes_ask);
  const last = kalshiPrice(m.last_price_dollars, m.last_price);
  const prev = kalshiPrice(m.previous_price_dollars, m.previous_price);
  const midpoint =
    yesBid !== undefined && yesAsk !== undefined ? (yesBid + yesAsk) / 2 : last;
  const yesPrice = last ?? midpoint;
  const openInterest = fp(m.open_interest_fp, m.open_interest);
  const restingLiquidity = fp(m.liquidity_dollars, m.liquidity ? m.liquidity / 100 : 0);
  // Kalshi's liquidity field is often 0 even on active books; open-interest
  // notional is used as a labeled proxy when resting liquidity is unreported.
  const liquidity =
    restingLiquidity > 0 ? restingLiquidity : openInterest * (yesPrice ?? 0.5);

  const subtitle = m.yes_sub_title?.trim();
  const question = subtitle && subtitle !== m.title ? `${m.title ?? event?.title} — ${subtitle}` : (m.title ?? event?.title ?? m.ticker);
  const settleSource = event?.settlement_sources?.[0]?.name;

  return {
    conditionId: ksMarketKey(m.ticker),
    venueId: "kalshi",
    venueMarketId: m.ticker,
    venueTicker: m.ticker,
    eventSlug: event?.event_ticker,
    question,
    eventTitle: event?.title,
    description:
      [m.rules_primary, m.rules_secondary].filter(Boolean).join("\n\n") || undefined,
    resolutionSource: settleSource,
    category: event?.category || "Kalshi",
    tags: [event?.category ?? "Kalshi", "Kalshi"].filter(Boolean) as string[],
    endDate: m.close_time,
    startDate: m.open_time,
    active: true,
    closed: false,
    negRisk: Boolean(event?.mutually_exclusive),
    outcomeType: "binary",
    liquidity,
    volume24h: fp(m.volume_24h_fp, m.volume_24h),
    volumeTotal: fp(m.volume_fp, m.volume),
    openInterest,
    tickSize: 0.01,
    minOrderSize: 1,
    outcomes: [
      { tokenId: ksYesToken(m.ticker), label: "Yes", price: yesPrice },
      {
        tokenId: ksNoToken(m.ticker),
        label: "No",
        price: yesPrice !== undefined ? Number((1 - yesPrice).toFixed(4)) : undefined,
      },
    ],
    yesTokenId: ksYesToken(m.ticker),
    noTokenId: ksNoToken(m.ticker),
    yesPrice,
    noPrice: yesPrice !== undefined ? Number((1 - yesPrice).toFixed(4)) : undefined,
    bestBid: yesBid,
    bestAsk: yesAsk,
    spread:
      yesBid !== undefined && yesAsk !== undefined
        ? Number((yesAsk - yesBid).toFixed(4))
        : undefined,
    midpoint,
    oneDayPriceChange:
      last !== undefined && prev !== undefined ? Number((last - prev).toFixed(4)) : undefined,
    tradable: true,
    referenceOnly: false,
    sourceUrl: undefined, // no stable public permalink scheme — avoid guessing
    source: "kalshi",
    fetchedAt: now,
  };
}

interface RawBookFp {
  orderbook?: { yes?: [number, number][]; no?: [number, number][] };
  orderbook_fp?: { yes_dollars?: [string, string][]; no_dollars?: [string, string][] };
}

/**
 * Kalshi books quote YES bids and NO bids. For the requested side:
 *   bids  = same-side resting bids (best = highest)
 *   asks  = derived from the opposite side: price 1 − oppBid (best = lowest)
 */
export function normalizeKalshiBook(
  raw: RawBookFp,
  tokenId: string,
  now = Date.now(),
): OrderBookData {
  const parsed = parseKsToken(tokenId);
  const side = parsed?.side ?? "yes";
  const yesLv = levelsFrom(raw, "yes");
  const noLv = levelsFrom(raw, "no");
  const same = side === "yes" ? yesLv : noLv;
  const opp = side === "yes" ? noLv : yesLv;

  const bids: BookLevel[] = [...same].sort((a, b) => b.price - a.price);
  const asks: BookLevel[] = opp
    .map((l) => ({ price: Number((1 - l.price).toFixed(4)), size: l.size }))
    .sort((a, b) => a.price - b.price);

  const bestBid = bids[0]?.price;
  const bestAsk = asks[0]?.price;
  const midpoint =
    bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : bestBid ?? bestAsk;
  const band = (levels: BookLevel[]) =>
    midpoint === undefined
      ? 0
      : levels.reduce(
          (a, l) => (Math.abs(l.price - midpoint) <= 0.05 ? a + l.price * l.size : a),
          0,
        );
  return {
    tokenId,
    bids,
    asks,
    bestBid,
    bestAsk,
    midpoint,
    spread: bestBid !== undefined && bestAsk !== undefined ? Number((bestAsk - bestBid).toFixed(4)) : undefined,
    bidDepthUsd: band(bids),
    askDepthUsd: band(asks),
    ts: now,
    source: "clob",
  };
}

function levelsFrom(raw: RawBookFp, side: "yes" | "no"): BookLevel[] {
  const fpLevels = raw.orderbook_fp?.[side === "yes" ? "yes_dollars" : "no_dollars"];
  if (fpLevels) {
    return fpLevels
      .map(([p, s]) => ({ price: Number(p), size: Number(s) }))
      .filter((l) => Number.isFinite(l.price) && l.size > 0);
  }
  const cents = raw.orderbook?.[side];
  return (cents ?? [])
    .map(([p, s]) => ({ price: p / 100, size: s }))
    .filter((l) => Number.isFinite(l.price) && l.size > 0);
}

// ── fetchers ──────────────────────────────────────────────────────────────────

async function tracked<T>(fn: () => Promise<T>): Promise<T> {
  try {
    const v = await fn();
    recordSourceSuccess("kalshi");
    return v;
  } catch (err) {
    recordSourceFailure("kalshi", err);
    throw err;
  }
}

export async function fetchKalshiMarkets(opts: HttpOpts = {}): Promise<NormalizedMarket[]> {
  return tracked(async () => {
    const res = await getJson<{ events: KalshiEventRaw[] }>(
      `${KALSHI_API_URL}/events` +
        qs({ limit: 60, status: "open", with_nested_markets: true }),
      opts,
    );
    const now = Date.now();
    const out: NormalizedMarket[] = [];
    for (const ev of res.events ?? []) {
      for (const m of ev.markets ?? []) {
        const norm = normalizeKalshiMarket(m, ev, now);
        if (norm) out.push(norm);
      }
    }
    return out;
  });
}

export async function fetchKalshiBook(tokenId: string, opts: HttpOpts = {}): Promise<OrderBookData> {
  const parsed = parseKsToken(tokenId);
  if (!parsed) throw new Error(`not a kalshi token: ${tokenId}`);
  return tracked(async () => {
    const raw = await getJson<RawBookFp>(
      `${KALSHI_API_URL}/markets/${encodeURIComponent(parsed.ticker)}/orderbook` + qs({ depth: 32 }),
      opts,
    );
    return normalizeKalshiBook(raw, tokenId);
  });
}

interface KalshiTradeRaw {
  taker_side?: string;
  yes_price?: number;
  yes_price_dollars?: string;
  count?: number;
  count_fp?: string;
  created_time?: string;
}

export async function fetchKalshiTrades(ticker: string, opts: HttpOpts = {}): Promise<RecentTrade[]> {
  return tracked(async () => {
    const res = await getJson<{ trades: KalshiTradeRaw[] }>(
      `${KALSHI_API_URL}/markets/trades` + qs({ ticker, limit: 30 }),
      opts,
    );
    return (res.trades ?? []).flatMap((t) => {
      // a trade with no parseable price is DROPPED, not invented as 0c —
      // a fabricated 0c print becomes a 100c point in derived NO histories
      const price = kalshiPrice(t.yes_price_dollars, t.yes_price);
      if (price === undefined) return [];
      return [
        {
          side: (t.taker_side === "no" ? "SELL" : "BUY") as RecentTrade["side"],
          price,
          size: fp(t.count_fp, t.count),
          ts: t.created_time ? new Date(t.created_time).getTime() : Date.now(),
          outcome: "Yes",
        },
      ];
    });
  });
}

export const kalshiAdapter: VenueAdapter = {
  venueId: "kalshi",
  venueName: "Kalshi",
  capabilities: KALSHI_CAPABILITIES,
  meta: KALSHI_META,
  listMarkets: fetchKalshiMarkets,
  getOrderBook: fetchKalshiBook,
  getTrades: fetchKalshiTrades,
};
