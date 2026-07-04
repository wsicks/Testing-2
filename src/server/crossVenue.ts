// Cross-venue link cache + reference-price feed. Links rebuild at most once
// per minute over the merged market universe; CoinGecko reference prices
// refresh on a 60s cache and are reference-only by construction.

import { buildCrossVenueLinks } from "@/lib/engine/crossvenue/mapper";
import { fetchCoinGeckoPrices } from "@/lib/venues/coingecko";
import type { CrossVenueLink, ReferencePrice } from "@/lib/types";
import { cached } from "./cache";
import { getMarkets } from "./marketData";
import { measureSync } from "./perf";

export async function getCrossVenueLinks(): Promise<CrossVenueLink[]> {
  return cached("crossvenue:links", 60_000, async () => {
    const { markets } = await getMarkets();
    return measureSync("hot.crossvenue_map", () => buildCrossVenueLinks(markets));
  });
}

export async function getReferencePrices(): Promise<ReferencePrice[]> {
  return cached("reference:coingecko", 60_000, async () => {
    try {
      return await fetchCoinGeckoPrices();
    } catch {
      return [];
    }
  });
}
