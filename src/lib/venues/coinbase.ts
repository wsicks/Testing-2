// Coinbase venue adapter — Advanced Trade PUBLIC market data (no auth).
// Coinbase serves as a crypto reference, charting, and (paper) execution
// venue. Spot products are `outcomeType: "asset"` — prices are USD, not
// probabilities, and every downstream consumer branches on that. Live
// Coinbase trading requires scoped API credentials and ships locked
// (coinbaseLive.ts); reference usage never requires authentication.

import { COINBASE_API_URL, COINBASE_PRODUCTS } from "@/lib/constants";
import { getJson, qs, type HttpOpts } from "@/lib/polymarket/http";
import type {
  NormalizedCandle,
  NormalizedMarket,
  OrderBookData,
  RecentTrade,
  VenueCapabilities,
} from "@/lib/types";
import { recordSourceFailure, recordSourceSuccess } from "./sourceStatus";
import type { SourceMetaStatic, VenueAdapter } from "./types";

export const COINBASE_META: SourceMetaStatic = {
  name: "Coinbase Advanced Trade (public market data)",
  licenseNote:
    "Official Coinbase Advanced Trade API, public endpoints per Coinbase API terms. Authenticated trading requires user-scoped credentials.",
  updateFrequency: "REST polling, 5–15s cache",
  rateLimitNote: "Public endpoints ~10 req/s; cached per product",
  dataClass: "tradable",
};

export const COINBASE_CAPABILITIES: VenueCapabilities = {
  publicData: true,
  orderBooks: true,
  candles: true,
  trades: true,
  paperTrading: true,
  liveTrading: false, // locked until user configures scoped credentials
  referenceOnly: false,
};

export const cbMarketKey = (productId: string) => `cb:${productId}`;
export function parseCbToken(tokenId: string): string | null {
  return tokenId.startsWith("cb:") ? tokenId.slice(3) : null;
}

interface CbProductRaw {
  product_id: string;
  price?: string;
  price_percentage_change_24h?: string;
  volume_24h?: string;
  base_name?: string;
  quote_name?: string;
  base_increment?: string;
  quote_increment?: string;
  quote_min_size?: string;
  status?: string;
  trading_disabled?: boolean;
  product_type?: string;
}

export function normalizeCoinbaseProduct(
  p: CbProductRaw,
  now = Date.now(),
): NormalizedMarket | null {
  if (!p.product_id) return null;
  const price = Number(p.price);
  if (!Number.isFinite(price)) return null;
  const vol24Base = Number(p.volume_24h) || 0;
  const volumeUsd = vol24Base * price;
  const change = Number(p.price_percentage_change_24h);
  const key = cbMarketKey(p.product_id);
  return {
    conditionId: key,
    venueId: "coinbase",
    venueMarketId: p.product_id,
    venueTicker: p.product_id,
    question: `${p.base_name ?? p.product_id} spot (${p.product_id})`,
    eventTitle: `Coinbase ${p.product_id}`,
    description: `Coinbase Advanced Trade spot product ${p.product_id}. USD price of ${p.base_name ?? p.product_id}; settles continuously — this is not an event contract and will resolve to nothing.`,
    resolutionSource: "Coinbase Advanced Trade",
    category: "Crypto Spot",
    tags: ["Crypto Spot", "Coinbase", p.base_name ?? ""].filter(Boolean),
    endDate: undefined,
    active: p.status !== "offline" && !p.trading_disabled,
    closed: false,
    negRisk: false,
    outcomeType: "asset",
    // liquidity proxy: 24h USD volume (products endpoint reports no resting
    // depth; the live book carries the real depth on the detail view)
    liquidity: volumeUsd,
    volume24h: volumeUsd,
    volumeTotal: volumeUsd,
    tickSize: Number(p.quote_increment) || 0.01,
    minOrderSize: Number(p.quote_min_size) || 1,
    outcomes: [{ tokenId: key, label: p.base_name ?? p.product_id, price }],
    yesTokenId: key,
    yesPrice: price,
    midpoint: price,
    bestBid: undefined,
    bestAsk: undefined,
    oneDayPriceChange: Number.isFinite(change) ? change / 100 : undefined,
    tradable: true,
    referenceOnly: false,
    sourceUrl: `https://www.coinbase.com/advanced-trade/spot/${p.product_id}`,
    source: "coinbase",
    fetchedAt: now,
  };
}

async function tracked<T>(fn: () => Promise<T>): Promise<T> {
  try {
    const v = await fn();
    recordSourceSuccess("coinbase");
    return v;
  } catch (err) {
    recordSourceFailure("coinbase", err);
    throw err;
  }
}

export async function fetchCoinbaseMarkets(opts: HttpOpts = {}): Promise<NormalizedMarket[]> {
  return tracked(async () => {
    const now = Date.now();
    const results = await Promise.allSettled(
      COINBASE_PRODUCTS.map((id) =>
        getJson<CbProductRaw>(`${COINBASE_API_URL}/market/products/${encodeURIComponent(id)}`, opts),
      ),
    );
    const out: NormalizedMarket[] = [];
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const norm = normalizeCoinbaseProduct(r.value, now);
      if (norm) out.push(norm);
    }
    if (out.length === 0) throw new Error("no coinbase products available");
    return out;
  });
}

interface CbBookRaw {
  pricebook?: {
    bids?: { price: string; size: string }[];
    asks?: { price: string; size: string }[];
    time?: string;
  };
}

export function normalizeCoinbaseBook(
  raw: CbBookRaw,
  tokenId: string,
  now = Date.now(),
): OrderBookData {
  const toLv = (arr?: { price: string; size: string }[]) =>
    (arr ?? [])
      .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
      .filter((l) => Number.isFinite(l.price) && l.size > 0);
  const bids = toLv(raw.pricebook?.bids).sort((a, b) => b.price - a.price);
  const asks = toLv(raw.pricebook?.asks).sort((a, b) => a.price - b.price);
  const bestBid = bids[0]?.price;
  const bestAsk = asks[0]?.price;
  const midpoint =
    bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : bestBid ?? bestAsk;
  // near-mid band scales with price for asset books (0.5% of mid)
  const bandW = midpoint !== undefined ? midpoint * 0.005 : 0;
  const band = (levels: typeof bids) =>
    midpoint === undefined
      ? 0
      : levels.reduce((a, l) => (Math.abs(l.price - midpoint) <= bandW ? a + l.price * l.size : a), 0);
  return {
    tokenId,
    bids,
    asks,
    bestBid,
    bestAsk,
    midpoint,
    spread: bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : undefined,
    bidDepthUsd: band(bids),
    askDepthUsd: band(asks),
    ts: raw.pricebook?.time ? new Date(raw.pricebook.time).getTime() : now,
    source: "clob",
  };
}

export async function fetchCoinbaseBook(tokenId: string, opts: HttpOpts = {}): Promise<OrderBookData> {
  const productId = parseCbToken(tokenId);
  if (!productId) throw new Error(`not a coinbase token: ${tokenId}`);
  return tracked(async () => {
    const raw = await getJson<CbBookRaw>(
      `${COINBASE_API_URL}/market/product_book` + qs({ product_id: productId, limit: 32 }),
      opts,
    );
    return normalizeCoinbaseBook(raw, tokenId);
  });
}

const GRANULARITY: Record<number, string> = {
  1: "ONE_MINUTE",
  5: "FIVE_MINUTE",
  15: "FIFTEEN_MINUTE",
  30: "THIRTY_MINUTE",
  60: "ONE_HOUR",
  240: "SIX_HOUR", // closest supported bucket ≥ 4h
  1440: "ONE_DAY",
};

export async function fetchCoinbaseCandles(
  productId: string,
  resolutionMin: number,
  fromSec: number,
  toSec: number,
  opts: HttpOpts = {},
): Promise<NormalizedCandle[]> {
  const gran = GRANULARITY[resolutionMin] ?? "ONE_HOUR";
  return tracked(async () => {
    const res = await getJson<{
      candles: { start: string; low: string; high: string; open: string; close: string; volume: string }[];
    }>(
      `${COINBASE_API_URL}/market/products/${encodeURIComponent(productId)}/candles` +
        qs({ start: Math.floor(fromSec), end: Math.floor(toSec), granularity: gran }),
      opts,
    );
    return (res.candles ?? [])
      .map((c) => ({
        t: Number(c.start),
        o: Number(c.open),
        h: Number(c.high),
        l: Number(c.low),
        c: Number(c.close),
        v: Number(c.volume),
      }))
      .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.c))
      .sort((a, b) => a.t - b.t);
  });
}

export async function fetchCoinbaseTrades(productId: string, opts: HttpOpts = {}): Promise<RecentTrade[]> {
  return tracked(async () => {
    const res = await getJson<{
      trades: { price: string; size: string; time: string; side?: string }[];
    }>(
      `${COINBASE_API_URL}/market/products/${encodeURIComponent(productId)}/ticker` + qs({ limit: 30 }),
      opts,
    );
    return (res.trades ?? []).map((t) => ({
      side: (t.side === "SELL" ? "SELL" : "BUY") as RecentTrade["side"],
      price: Number(t.price),
      size: Number(t.size),
      ts: new Date(t.time).getTime(),
    }));
  });
}

export const coinbaseAdapter: VenueAdapter = {
  venueId: "coinbase",
  venueName: "Coinbase",
  capabilities: COINBASE_CAPABILITIES,
  meta: COINBASE_META,
  listMarkets: fetchCoinbaseMarkets,
  getOrderBook: fetchCoinbaseBook,
  getTrades: fetchCoinbaseTrades,
  getCandles: fetchCoinbaseCandles,
};
