import { DEFAULT_SETTINGS } from "@/lib/constants";
import type {
  AppSettings,
  NormalizedMarket,
  OrderBookData,
  PortfolioState,
} from "@/lib/types";

export function makeMarket(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    conditionId: "0xcond1",
    venueId: "polymarket",
    venueMarketId: "0xcond1",
    outcomeType: "binary",
    tradable: true,
    referenceOnly: false,
    question: "Will the test market resolve yes?",
    description:
      "This market will resolve to 'Yes' if the test condition is met according to the official resolution source, the Example Bureau of Testing. Otherwise it will resolve to 'No'.",
    category: "Testing",
    tags: ["Testing"],
    endDate: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    active: true,
    closed: false,
    negRisk: false,
    liquidity: 50_000,
    volume24h: 120_000,
    volumeTotal: 800_000,
    outcomes: [
      { tokenId: "tok-yes", label: "Yes", price: 0.55 },
      { tokenId: "tok-no", label: "No", price: 0.45 },
    ],
    yesTokenId: "tok-yes",
    noTokenId: "tok-no",
    yesPrice: 0.55,
    noPrice: 0.45,
    bestBid: 0.54,
    bestAsk: 0.56,
    spread: 0.02,
    midpoint: 0.55,
    oneDayPriceChange: 0.01,
    oneHourPriceChange: 0.002,
    source: "gamma",
    fetchedAt: Date.now(),
    ...overrides,
  };
}

export function makeBook(overrides: Partial<OrderBookData> = {}): OrderBookData {
  return {
    tokenId: "tok-yes",
    bids: [
      { price: 0.54, size: 500 },
      { price: 0.53, size: 800 },
      { price: 0.5, size: 2000 },
    ],
    asks: [
      { price: 0.56, size: 400 },
      { price: 0.57, size: 900 },
      { price: 0.6, size: 2500 },
    ],
    bestBid: 0.54,
    bestAsk: 0.56,
    midpoint: 0.55,
    spread: 0.02,
    bidDepthUsd: 0.54 * 500 + 0.53 * 800 + 0.5 * 2000,
    askDepthUsd: 0.56 * 400 + 0.57 * 900 + 0.6 * 2500,
    ts: Date.now(),
    source: "clob",
    ...overrides,
  };
}

export function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

export function makePortfolio(overrides: Partial<PortfolioState> = {}): PortfolioState {
  return {
    mode: "paper",
    cash: 10_000,
    totalValue: 10_000,
    exposure: 0,
    positions: [],
    exposureByMarket: {},
    exposureByCategory: {},
    exposureByVenue: {},
    realizedPnl: 0,
    unrealizedPnl: 0,
    dailyPnl: 0,
    dailyRealizedPnl: 0,
    allTimePnl: 0,
    closedTrades: 0,
    isSample: false,
    ...overrides,
  };
}

/** minimal Response-like fetch stub */
export function stubFetch(
  routes: { match: (url: string) => boolean; body: unknown; status?: number }[],
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const r = routes.find((x) => x.match(url));
    if (!r) {
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
