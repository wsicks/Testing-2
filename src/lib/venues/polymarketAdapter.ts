// Polymarket venue adapter — wraps the existing Gamma/CLOB/Data-API modules
// behind the shared VenueAdapter contract. Polymarket keeps its raw condition
// ids as internal keys for backward compatibility.

import { SCANNER_EVENT_LIMIT } from "@/lib/constants";
import { fetchActiveMarkets } from "@/lib/polymarket/gamma";
import { fetchOrderBook } from "@/lib/polymarket/clob";
import { fetchRecentTrades } from "@/lib/polymarket/dataapi";
import type { VenueCapabilities } from "@/lib/types";
import type { HttpOpts } from "@/lib/polymarket/http";
import { recordSourceFailure, recordSourceSuccess } from "./sourceStatus";
import type { SourceMetaStatic, VenueAdapter } from "./types";

export const POLYMARKET_META: SourceMetaStatic = {
  name: "Polymarket (Gamma + CLOB + Data APIs)",
  licenseNote:
    "Official Polymarket public APIs per Polymarket terms. Event-market outcome tokens on Polygon.",
  updateFrequency: "REST polling 15s cache + public market websocket for the selected market",
  rateLimitNote: "Cached per endpoint; one Gamma request covers the full scan universe",
  dataClass: "tradable",
};

export const POLYMARKET_CAPABILITIES: VenueCapabilities = {
  publicData: true,
  orderBooks: true,
  candles: true, // derived OHLC from CLOB price history
  trades: true,
  paperTrading: true,
  liveTrading: true, // adapter exists; locked behind env + settings + terms + arming
  referenceOnly: false,
};

export const polymarketAdapter: VenueAdapter = {
  venueId: "polymarket",
  venueName: "Polymarket",
  capabilities: POLYMARKET_CAPABILITIES,
  meta: POLYMARKET_META,
  async listMarkets(opts?: HttpOpts) {
    try {
      const markets = await fetchActiveMarkets({ limit: SCANNER_EVENT_LIMIT }, opts);
      recordSourceSuccess("polymarket");
      return markets;
    } catch (err) {
      recordSourceFailure("polymarket", err);
      throw err;
    }
  },
  async getOrderBook(tokenId: string, opts?: HttpOpts) {
    try {
      const book = await fetchOrderBook(tokenId, opts);
      recordSourceSuccess("polymarket");
      return book;
    } catch (err) {
      recordSourceFailure("polymarket", err);
      throw err;
    }
  },
  async getTrades(conditionId: string, opts?: HttpOpts) {
    try {
      const trades = await fetchRecentTrades(conditionId, 30, opts);
      recordSourceSuccess("polymarket");
      return trades;
    } catch (err) {
      recordSourceFailure("polymarket", err);
      throw err;
    }
  },
};
