// Pure scanner filter/sort pipeline over the in-memory market list.
// Shared by the /api/markets route and the performance benchmarks — the
// <20ms p95 budget for cached table operations is enforced against exactly
// this code. All comparisons are typed numeric fields; no string parsing.

import type { NormalizedMarket } from "./types";

export interface ScannerQuery {
  q?: string;
  venue?: string;
  tag?: string;
  closingHrs?: number;
  minLiquidity?: number;
  minVolume?: number;
  maxSpread?: number;
  priceMin?: number;
  priceMax?: number;
  newOnly?: boolean;
  highMovement?: boolean;
  watchlistOnly?: boolean;
  tradableOnly?: boolean;
  hideReference?: boolean;
  /** rows older than this many seconds are dropped */
  maxDataAgeSecs?: number;
  sort?: string;
  dir?: "asc" | "desc";
  limit?: number;
}

export interface SignalJoin {
  score: number;
  strategy: string;
  status: string;
}

export function filterSortMarkets(
  markets: NormalizedMarket[],
  query: ScannerQuery,
  bestSignal: Map<string, SignalJoin>,
  watchlist: Set<string>,
  now = Date.now(),
): NormalizedMarket[] {
  const q = query.q?.toLowerCase();
  const tag = query.tag?.toLowerCase();

  const rows = markets.filter((m) => {
    if (query.venue && m.venueId !== query.venue) return false;
    if (query.tradableOnly && (!m.tradable || m.referenceOnly)) return false;
    if (query.hideReference && m.referenceOnly) return false;
    if (
      query.maxDataAgeSecs !== undefined &&
      now - m.fetchedAt > query.maxDataAgeSecs * 1000
    )
      return false;
    if (
      q &&
      !`${m.question} ${m.eventTitle ?? ""} ${m.venueTicker ?? ""}`
        .toLowerCase()
        .includes(q)
    )
      return false;
    if (
      tag &&
      m.category?.toLowerCase() !== tag &&
      !m.tags.some((t) => t.toLowerCase() === tag)
    )
      return false;
    if (query.closingHrs !== undefined) {
      if (!m.endDate) return false;
      const msLeft = new Date(m.endDate).getTime() - now;
      if (msLeft < 0 || msLeft > query.closingHrs * 3_600_000) return false;
    }
    if (query.minLiquidity !== undefined && m.liquidity < query.minLiquidity)
      return false;
    if (query.minVolume !== undefined && m.volume24h < query.minVolume) return false;
    if (query.maxSpread !== undefined && (m.spread ?? 1) > query.maxSpread)
      return false;
    const mid = m.midpoint ?? m.yesPrice ?? 0.5;
    if (query.priceMin !== undefined && mid < query.priceMin) return false;
    if (query.priceMax !== undefined && mid > query.priceMax) return false;
    if (query.newOnly && !m.isNew) return false;
    if (query.highMovement && Math.abs(m.oneDayPriceChange ?? 0) < 0.05)
      return false;
    if (query.watchlistOnly && !watchlist.has(m.conditionId)) return false;
    return true;
  });

  const dir = query.dir === "asc" ? 1 : -1;
  const key = (m: NormalizedMarket): number => {
    switch (query.sort) {
      case "liquidity":
        return m.liquidity;
      case "spread":
        return m.spread ?? 1;
      case "closeTime":
        return m.endDate ? new Date(m.endDate).getTime() : Infinity;
      case "change":
        return Math.abs(m.oneDayPriceChange ?? 0);
      case "signal":
        return bestSignal.get(m.conditionId)?.score ?? -1;
      case "price":
        return m.midpoint ?? 0;
      default:
        return m.volume24h;
    }
  };
  rows.sort((a, b) => (key(a) - key(b)) * dir);
  return rows.slice(0, query.limit ?? 100);
}
