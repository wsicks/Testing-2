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
import { fetchActiveMarkets } from "@/lib/polymarket/gamma";
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
import { cached } from "./cache";
import { audit } from "./audit";

export interface MarketsPayload {
  markets: NormalizedMarket[];
  source: "gamma" | "mock";
  fetchedAt: number;
}

export async function getMarkets(): Promise<MarketsPayload> {
  return cached("markets:list", MARKETS_CACHE_TTL, async () => {
    try {
      const markets = await fetchActiveMarkets({ limit: 100 });
      return { markets, source: "gamma" as const, fetchedAt: Date.now() };
    } catch (err) {
      await audit(
        "system",
        "api_error",
        `Gamma markets fetch failed — serving MOCK market list (${err instanceof Error ? err.message : "unknown"})`,
        { severity: "error", feedType: "api_error" },
      );
      return {
        markets: mockMarkets(),
        source: "mock" as const,
        fetchedAt: Date.now(),
      };
    }
  });
}

export async function getMarketByCondition(
  conditionId: string,
): Promise<NormalizedMarket | undefined> {
  const { markets } = await getMarkets();
  return markets.find((m) => m.conditionId === conditionId);
}

export function isMockToken(tokenId: string): boolean {
  return tokenId.startsWith("mocktok");
}

export async function getBook(
  tokenId: string,
  fallbackMid = 0.5,
): Promise<OrderBookData> {
  if (isMockToken(tokenId)) return mockOrderBook(tokenId, fallbackMid);
  return cached(`book:${tokenId}`, DETAIL_CACHE_TTL, async () => {
    try {
      return await fetchOrderBook(tokenId);
    } catch (err) {
      await audit(
        "system",
        "api_error",
        `CLOB book fetch failed for ${tokenId.slice(0, 12)}… — serving MOCK book`,
        { severity: "warn", feedType: "api_error" },
      );
      return mockOrderBook(tokenId, fallbackMid);
    }
  });
}

export async function getHistory(
  tokenId: string,
  interval: HistoryInterval = "1w",
  fidelity = 60,
): Promise<PricePoint[]> {
  if (isMockToken(tokenId)) return mockPriceHistory(tokenId);
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
  return cached(`trades:${conditionId}`, DETAIL_CACHE_TTL, async () => {
    try {
      return await fetchRecentTrades(conditionId);
    } catch {
      return [];
    }
  });
}

/** tokenId -> latest price map from the market list (yes + no tokens) */
export async function priceLookup(): Promise<Map<string, number>> {
  const { markets } = await getMarkets();
  const map = new Map<string, number>();
  for (const m of markets) {
    for (const o of m.outcomes) {
      if (o.tokenId && o.price !== undefined) map.set(o.tokenId, o.price);
    }
  }
  return map;
}
