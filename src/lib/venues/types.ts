// Venue adapter contract. Each venue lives behind this interface; execution
// logic is NEVER shared between venues — live order paths have one adapter
// per venue (src/server/liveAdapter.ts, kalshiLive.ts, coinbaseLive.ts) and a
// signal on one venue is never assumed tradable on another without explicit
// mapping, liquidity/fee/settlement checks, and user approval.

import type {
  NormalizedCandle,
  NormalizedMarket,
  OrderBookData,
  RecentTrade,
  VenueCapabilities,
  VenueId,
} from "@/lib/types";
import type { HttpOpts } from "@/lib/polymarket/http";

export interface SourceMetaStatic {
  name: string;
  licenseNote: string;
  updateFrequency: string;
  rateLimitNote: string;
  dataClass: "tradable" | "reference" | "delayed" | "estimated";
}

export interface VenueAdapter {
  venueId: VenueId;
  venueName: string;
  capabilities: VenueCapabilities;
  meta: SourceMetaStatic;

  /** normalized active markets (or reference products) */
  listMarkets(opts?: HttpOpts): Promise<NormalizedMarket[]>;
  /** order book for an outcome token / product id */
  getOrderBook?(tokenId: string, opts?: HttpOpts): Promise<OrderBookData>;
  /** public trade tape for a market */
  getTrades?(venueMarketId: string, opts?: HttpOpts): Promise<RecentTrade[]>;
  /** OHLCV bars; resolutionMin ∈ {1,5,15,60,240,1440} */
  getCandles?(
    venueMarketId: string,
    resolutionMin: number,
    fromSec: number,
    toSec: number,
    opts?: HttpOpts,
  ): Promise<NormalizedCandle[]>;
}
