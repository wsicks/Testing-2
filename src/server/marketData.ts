// Market-data access layer: cached reads over the Polymarket public APIs with
// clearly-labeled mock fallbacks so demo mode still works fully offline.

import {
  DETAIL_CACHE_TTL,
  MARKETS_CACHE_TTL,
  SCANNER_EVENT_LIMIT,
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
import { setUpstreamLatencyHook } from "@/lib/polymarket/http";
import { cached } from "./cache";
import { audit } from "./audit";
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
  source: "gamma" | "mock";
  fetchedAt: number;
}

export async function getMarkets(): Promise<MarketsPayload> {
  return cached("markets:list", MARKETS_CACHE_TTL, async () => {
    try {
      const markets = await fetchActiveMarkets({ limit: SCANNER_EVENT_LIMIT });
      updateRegistry(markets); // refresh the O(1) hot-path registry
      return { markets, source: "gamma" as const, fetchedAt: Date.now() };
    } catch (err) {
      await audit(
        "system",
        "api_error",
        `Gamma markets fetch failed — serving MOCK market list (${err instanceof Error ? err.message : "unknown"})`,
        { severity: "error", feedType: "api_error" },
      );
      const markets = mockMarkets();
      updateRegistry(markets);
      return {
        markets,
        source: "mock" as const,
        fetchedAt: Date.now(),
      };
    }
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
        `CLOB book fetch failed for ${tokenId.slice(0, 12)}… — serving MOCK book (${err instanceof Error ? err.message : "unknown"})`,
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

/** tokenId -> latest price map (precomputed in the hot-path registry) */
export async function priceLookup(): Promise<Map<string, number>> {
  const pre = regPrices();
  if (pre.size > 0) return pre;
  await getMarkets(); // populates the registry
  return regPrices();
}
