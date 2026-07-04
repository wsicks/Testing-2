// Venue registry: the market-carrying venues behind the VenueAdapter
// contract, plus source metadata for the reference-only feeds. Adding a venue
// = one adapter module + one entry here; scanner, detail routing, sources
// panel and health chips pick it up automatically.

import type { SourceStatus, VenueId } from "@/lib/types";
import { coinbaseAdapter } from "./coinbase";
import { COINGECKO_CAPABILITIES, COINGECKO_META } from "./coingecko";
import { kalshiAdapter } from "./kalshi";
import { polymarketAdapter } from "./polymarketAdapter";
import { sourceStatus } from "./sourceStatus";
import type { VenueAdapter } from "./types";

/** venues that contribute markets to the scanner */
export const MARKET_VENUES: VenueAdapter[] = [
  polymarketAdapter,
  kalshiAdapter,
  coinbaseAdapter,
];

export function getVenueAdapter(venueId: VenueId): VenueAdapter | undefined {
  return MARKET_VENUES.find((v) => v.venueId === venueId);
}

/** venue that owns an outcome-token id (prefix routing) */
export function venueForToken(tokenId: string): VenueId {
  if (tokenId.startsWith("ks:")) return "kalshi";
  if (tokenId.startsWith("cb:")) return "coinbase";
  return "polymarket";
}

/** venue that owns an internal market key */
export function venueForMarketKey(conditionId: string): VenueId {
  if (conditionId.startsWith("ks:")) return "kalshi";
  if (conditionId.startsWith("cb:")) return "coinbase";
  return "polymarket";
}

/** transparency records for every external source, incl. reference-only */
export function allSourceStatuses(): SourceStatus[] {
  return [
    sourceStatus("polymarket", polymarketAdapter.meta),
    sourceStatus("kalshi", kalshiAdapter.meta),
    sourceStatus("coinbase", coinbaseAdapter.meta),
    sourceStatus("coingecko", COINGECKO_META),
  ];
}

export const REFERENCE_CAPABILITIES = { coingecko: COINGECKO_CAPABILITIES };
