// CoinGecko reference adapter — free public API, REFERENCE-ONLY.
// Never tradable, never feeds execution: prices inform signals and sanity
// checks (e.g. cross-checking Coinbase spot) and are clearly labeled.

import { COINGECKO_API_URL, COINGECKO_IDS } from "@/lib/constants";
import { getJson, type HttpOpts } from "@/lib/polymarket/http";
import type { ReferencePrice, VenueCapabilities } from "@/lib/types";
import { recordSourceFailure, recordSourceSuccess } from "./sourceStatus";
import type { SourceMetaStatic } from "./types";

export const COINGECKO_META: SourceMetaStatic = {
  name: "CoinGecko (free public API)",
  licenseNote:
    "Free CoinGecko API per their terms; attribution required; reference-only — never used for execution or executable-liquidity claims.",
  updateFrequency: "~60s (upstream cache) — polled with 60s local cache",
  rateLimitNote: "Free tier ≈10–30 req/min; single batched request per refresh",
  dataClass: "reference",
};

export const COINGECKO_CAPABILITIES: VenueCapabilities = {
  publicData: true,
  orderBooks: false,
  candles: false,
  trades: false,
  paperTrading: false,
  liveTrading: false,
  referenceOnly: true,
};

const SYMBOLS: Record<string, string> = {
  bitcoin: "BTC",
  ethereum: "ETH",
  solana: "SOL",
  dogecoin: "DOGE",
  ripple: "XRP",
};

interface CgSimplePrice {
  [id: string]: {
    usd?: number;
    usd_24h_vol?: number;
    usd_24h_change?: number;
    last_updated_at?: number;
  };
}

export async function fetchCoinGeckoPrices(opts: HttpOpts = {}): Promise<ReferencePrice[]> {
  try {
    const res = await getJson<CgSimplePrice>(
      `${COINGECKO_API_URL}/simple/price?ids=${COINGECKO_IDS.join(",")}` +
        `&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true`,
      opts,
    );
    recordSourceSuccess("coingecko");
    const now = Date.now();
    const out: ReferencePrice[] = [];
    for (const [id, v] of Object.entries(res)) {
      if (v.usd === undefined) continue;
      const ts = (v.last_updated_at ?? Math.floor(now / 1000)) * 1000;
      out.push({
        source: "coingecko",
        symbol: SYMBOLS[id] ?? id.toUpperCase(),
        price: v.usd,
        change24hPct: v.usd_24h_change !== undefined ? v.usd_24h_change / 100 : undefined,
        volume24h: v.usd_24h_vol,
        ts,
        freshnessMs: now - ts,
      });
    }
    return out;
  } catch (err) {
    recordSourceFailure("coingecko", err);
    throw err;
  }
}
