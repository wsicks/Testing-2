// Market-data access layer: cached reads over the Polymarket public APIs with
// clearly-labeled mock fallbacks so demo mode still works fully offline.

import {
  DETAIL_CACHE_TTL,
  MARKETS_CACHE_TTL,
} from "@/lib/constants";
import type {
  NormalizedMarket,
  OrderBookData,
  PricePoint,
  RecentTrade,
} from "@/lib/types";

import {
  fetchOrderBook,
  fetchPriceHistory,
  type HistoryInterval,
} from "@/lib/polymarket/clob";
import { fetchRecentTrades } from "@/lib/polymarket/dataapi";
import {
  mockMarkets,
  mockOrderBook,
  mockPriceHistory,
} from "@/lib/demo/demoData";
import { setUpstreamLatencyHook } from "@/lib/polymarket/http";
import {
  fetchKalshiBook,
  fetchKalshiMarkets,
  fetchKalshiTrades,
  parseKsToken,
} from "@/lib/venues/kalshi";
import {
  fetchCoinbaseBook,
  fetchCoinbaseCandles,
  fetchCoinbaseMarkets,
  fetchCoinbaseTrades,
  parseCbToken,
} from "@/lib/venues/coinbase";
import { polymarketAdapter } from "@/lib/venues/polymarketAdapter";
import { venueForMarketKey, venueForToken } from "@/lib/venues/registry";
import { pointsToCandles, realizedVolDaily } from "@/lib/venues/derive";
import type { NormalizedCandle } from "@/lib/types";
import { cached } from "./cache";
import { audit } from "./audit";
import { getStore } from "./store";
import { recordLatency } from "./perf";
import {
  regByCondition,
  regByToken,
  regPrices,
  updateRegistry,
} from "./hotpath/registry";

// external Polymarket round-trips → perf panel (upstream.*, no <20ms promise)
setUpstreamLatencyHook(recordLatency);

export interface MarketsPayload {
  markets: NormalizedMarket[];
  /** status of the Polymarket leg (mock = Gamma unreachable) */
  source: "gamma" | "mock";
  /** venues that contributed rows this refresh */
  venuesLoaded: string[];
  fetchedAt: number;
}

/**
 * Merged multi-venue market list. Each venue is fetched in isolation —
 * one venue failing never hides the others. Polymarket falls back to
 * clearly-labeled MOCK rows offline; Kalshi/Coinbase simply drop out
 * (their failures are visible on /sources).
 */
export async function getMarkets(): Promise<MarketsPayload> {
  return cached("markets:list", MARKETS_CACHE_TTL, async () => {
    const store = await getStore();
    const settings = await store.getSettings();
    const v = settings.venues;

    const [pmR, ksR, cbR] = await Promise.allSettled([
      v.polymarket.publicData
        ? polymarketAdapter.listMarkets() // adapter path keeps the /sources ledger accurate
        : Promise.resolve([]),
      v.kalshi.publicData ? fetchKalshiMarkets() : Promise.resolve([]),
      v.coinbase.publicData ? fetchCoinbaseMarkets() : Promise.resolve([]),
    ]);

    let source: "gamma" | "mock" = "gamma";
    let pmMarkets: NormalizedMarket[];
    if (pmR.status === "fulfilled") {
      pmMarkets = pmR.value;
    } else {
      await audit(
        "system",
        "api_error",
        `Gamma markets fetch failed — serving MOCK Polymarket list (${pmR.reason instanceof Error ? pmR.reason.message : "unknown"})`,
        { severity: "error", feedType: "api_error" },
      );
      pmMarkets = mockMarkets();
      source = "mock";
    }
    const ksMarkets = ksR.status === "fulfilled" ? ksR.value : [];
    const cbMarkets = cbR.status === "fulfilled" ? cbR.value : [];

    const venuesLoaded = [
      pmMarkets.length ? "polymarket" : null,
      ksMarkets.length ? "kalshi" : null,
      cbMarkets.length ? "coinbase" : null,
    ].filter(Boolean) as string[];

    const markets = [...pmMarkets, ...ksMarkets, ...cbMarkets];
    updateRegistry(markets); // refresh the O(1) hot-path registry
    return { markets, source, venuesLoaded, fetchedAt: Date.now() };
  });
}

export async function getMarketByCondition(
  conditionId: string,
): Promise<NormalizedMarket | undefined> {
  // O(1) registry hit on the hot path; fall through to a refresh on miss
  const hit = regByCondition(conditionId);
  if (hit) return hit;
  const { markets } = await getMarkets();
  return markets.find((m) => m.conditionId === conditionId);
}

/** O(1) market lookup by outcome token id (hot path) */
export async function getMarketByToken(
  tokenId: string,
): Promise<NormalizedMarket | undefined> {
  const hit = regByToken(tokenId);
  if (hit) return hit;
  const { markets } = await getMarkets();
  return markets.find(
    (m) => m.yesTokenId === tokenId || m.noTokenId === tokenId,
  );
}

export function isMockToken(tokenId: string): boolean {
  return tokenId.startsWith("mocktok");
}

/**
 * Order book routed to the owning venue by token prefix. Kalshi/Coinbase
 * errors propagate (fail closed — a trade without a book gets blocked by the
 * risk engine); only Polymarket falls back to a labeled MOCK book so demo
 * mode survives offline.
 */
export async function getBook(
  tokenId: string,
  fallbackMid = 0.5,
): Promise<OrderBookData> {
  if (isMockToken(tokenId)) return mockOrderBook(tokenId, fallbackMid);
  const venue = venueForToken(tokenId);
  if (venue === "kalshi") {
    return cached(`book:${tokenId}`, DETAIL_CACHE_TTL, () => fetchKalshiBook(tokenId));
  }
  if (venue === "coinbase") {
    return cached(`book:${tokenId}`, DETAIL_CACHE_TTL, () => fetchCoinbaseBook(tokenId));
  }
  return cached(`book:${tokenId}`, DETAIL_CACHE_TTL, async () => {
    try {
      return await fetchOrderBook(tokenId);
    } catch (err) {
      await audit(
        "system",
        "api_error",
        `CLOB book fetch failed for ${tokenId.slice(0, 12)}… — serving MOCK book (${err instanceof Error ? err.message : "unknown"})`,
        { severity: "warn", feedType: "api_error" },
      );
      return mockOrderBook(tokenId, fallbackMid);
    }
  });
}

const INTERVAL_SECS: Record<HistoryInterval, { candleMin: number; lookbackSec: number }> = {
  "1d": { candleMin: 15, lookbackSec: 86_400 },
  "6h": { candleMin: 5, lookbackSec: 6 * 3_600 },
  "1h": { candleMin: 1, lookbackSec: 3_600 },
  "1w": { candleMin: 60, lookbackSec: 7 * 86_400 },
  "1m": { candleMin: 240, lookbackSec: 31 * 86_400 },
  max: { candleMin: 1440, lookbackSec: 180 * 86_400 },
};

export async function getHistory(
  tokenId: string,
  interval: HistoryInterval = "1w",
  fidelity = 60,
): Promise<PricePoint[]> {
  if (isMockToken(tokenId)) return mockPriceHistory(tokenId);
  const venue = venueForToken(tokenId);
  if (venue === "kalshi") {
    // sparse but honest: derive the probability path from the public tape
    const parsed = parseKsToken(tokenId);
    if (!parsed) return [];
    return cached(`hist:${tokenId}:${interval}`, 60_000, async () => {
      try {
        const trades = await fetchKalshiTrades(parsed.ticker);
        const pts = trades
          .map((t) => ({ t: Math.floor(t.ts / 1000), p: parsed.side === "no" ? 1 - t.price : t.price }))
          .sort((a, b) => a.t - b.t);
        return pts;
      } catch {
        return [];
      }
    });
  }
  if (venue === "coinbase") {
    const product = parseCbToken(tokenId);
    if (!product) return [];
    const cfg = INTERVAL_SECS[interval];
    return cached(`hist:${tokenId}:${interval}`, 60_000, async () => {
      try {
        const now = Math.floor(Date.now() / 1000);
        const candles = await fetchCoinbaseCandles(product, cfg.candleMin, now - cfg.lookbackSec, now);
        return candles.map((c) => ({ t: c.t, p: c.c }));
      } catch {
        return [];
      }
    });
  }
  return cached(`hist:${tokenId}:${interval}:${fidelity}`, 60_000, async () => {
    try {
      return await fetchPriceHistory(tokenId, { interval, fidelity });
    } catch {
      return mockPriceHistory(tokenId);
    }
  });
}

export async function getTrades(conditionId: string): Promise<RecentTrade[]> {
  if (conditionId.startsWith("0xmock")) return [];
  const venue = venueForMarketKey(conditionId);
  return cached(`trades:${conditionId}`, DETAIL_CACHE_TTL, async () => {
    try {
      if (venue === "kalshi") return await fetchKalshiTrades(conditionId.slice(3));
      if (venue === "coinbase") return await fetchCoinbaseTrades(conditionId.slice(3));
      return await fetchRecentTrades(conditionId);
    } catch {
      return [];
    }
  });
}

/** OHLCV candles for any venue market (native for Coinbase, derived for
 * Polymarket/Kalshi from price history / tape). resolutionMin ∈ TV set. */
export async function getCandles(
  conditionId: string,
  resolutionMin: number,
  fromSec: number,
  toSec: number,
): Promise<NormalizedCandle[]> {
  const venue = venueForMarketKey(conditionId);
  if (venue === "coinbase") {
    const product = conditionId.slice(3);
    return cached(`candles:${conditionId}:${resolutionMin}:${Math.floor(fromSec / 300)}`, 30_000, () =>
      fetchCoinbaseCandles(product, resolutionMin, fromSec, toSec),
    );
  }
  const market = regByCondition(conditionId);
  const tokenId = market?.yesTokenId ?? (venue === "kalshi" ? `${conditionId}:yes` : undefined);
  if (!tokenId) return [];
  const spanSec = toSec - fromSec;
  const interval: HistoryInterval =
    spanSec <= 86_400 ? "1d" : spanSec <= 7 * 86_400 ? "1w" : spanSec <= 31 * 86_400 ? "1m" : "max";
  const points = await getHistory(tokenId, interval, Math.max(1, Math.min(resolutionMin, 1440)));
  return pointsToCandles(
    points.filter((p) => p.t >= fromSec && p.t <= toSec),
    resolutionMin * 60,
  );
}

/** fresh Coinbase spot for reference signals (5s cache — freshness gated) */
export async function getSpotRef(
  product: string,
): Promise<{ price: number; ts: number } | undefined> {
  return cached(`spot:${product}`, 5_000, async () => {
    try {
      const book = await fetchCoinbaseBook(`cb:${product}`);
      if (book.midpoint === undefined) return undefined;
      return { price: book.midpoint, ts: book.ts };
    } catch {
      return undefined;
    }
  });
}

/** daily realized vol for a Coinbase product (10-min cache, 7d hourly bars) */
export async function getRealizedVolDaily(product: string): Promise<number | undefined> {
  return cached(`vol:${product}`, 10 * 60_000, async () => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const candles = await fetchCoinbaseCandles(product, 60, now - 7 * 86_400, now);
      return realizedVolDaily(candles);
    } catch {
      return undefined;
    }
  });
}

/** tokenId -> latest price map (precomputed in the hot-path registry) */
export async function priceLookup(): Promise<Map<string, number>> {
  const pre = regPrices();
  if (pre.size > 0) return pre;
  await getMarkets(); // populates the registry
  return regPrices();
}
