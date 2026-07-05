// Multi-venue tests: Kalshi/Coinbase normalizers (fixtures verified against
// the live APIs), the crypto-threshold parser, the cross-venue mapper's
// conservative statuses, both cross-venue signals, and the venue-aware risk
// engine branches.

import { describe, expect, it } from "vitest";
import {
  kalshiPrice,
  normalizeKalshiBook,
  normalizeKalshiMarket,
} from "@/lib/venues/kalshi";
import {
  normalizeCoinbaseBook,
  normalizeCoinbaseProduct,
} from "@/lib/venues/coinbase";
import { parseCryptoThreshold, parseUsdAmount } from "@/lib/engine/crossvenue/threshold";
import { buildCrossVenueLinks, compareMarkets } from "@/lib/engine/crossvenue/mapper";
import { referencePriceSignal } from "@/lib/engine/signals/referencePrice";
import { venueDivergenceSignal } from "@/lib/engine/signals/venueDivergence";
import { evaluateTrade } from "@/lib/engine/risk/riskEngine";
import type { NormalizedMarket } from "@/lib/types";
import { makeBook, makeMarket, makePortfolio, makeSettings } from "../helpers";

const now = Date.now();

// fixture matching the live *_dollars/_fp response shape
const KS_MARKET = {
  ticker: "KXOAIANTH-40-ANTH",
  event_ticker: "KXOAIANTH-40",
  market_type: "binary",
  title: "Will Open AI or Anthropic IPO first?",
  yes_sub_title: "Anthropic",
  status: "active",
  close_time: "2040-01-01T04:59:00Z",
  rules_primary: "If Anthropic confirms an IPO first, before Jan 1, 2040, then the market resolves to Yes.",
  yes_bid_dollars: "0.8000",
  yes_ask_dollars: "0.8300",
  no_bid_dollars: "0.1700",
  last_price_dollars: "0.8000",
  volume_24h_fp: "1863.33",
  volume_fp: "40000.00",
  liquidity_dollars: "0.0000",
  open_interest_fp: "40034.27",
};
const KS_EVENT = {
  event_ticker: "KXOAIANTH-40",
  title: "Will OpenAI or Anthropic IPO first?",
  category: "Financials",
  settlement_sources: [{ name: "Securities and Exchange Commission", url: "https://www.sec.gov/" }],
};

describe("kalshi normalization", () => {
  it("parses dollars fields and derives prefixed internal ids", () => {
    const m = normalizeKalshiMarket(KS_MARKET, KS_EVENT, now);
    expect(m).not.toBeNull();
    expect(m!.conditionId).toBe("ks:KXOAIANTH-40-ANTH");
    expect(m!.venueId).toBe("kalshi");
    expect(m!.yesTokenId).toBe("ks:KXOAIANTH-40-ANTH:yes");
    expect(m!.bestBid).toBeCloseTo(0.8, 6);
    expect(m!.bestAsk).toBeCloseTo(0.83, 6);
    expect(m!.spread).toBeCloseTo(0.03, 6);
    expect(m!.yesPrice).toBeCloseTo(0.8, 6);
    expect(m!.resolutionSource).toBe("Securities and Exchange Commission");
    expect(m!.volume24h).toBeCloseTo(1863.33, 2);
    // resting liquidity is 0 → open-interest notional proxy
    expect(m!.liquidity).toBeCloseTo(40034.27 * 0.8, 1);
    expect(m!.outcomeType).toBe("binary");
    expect(m!.tradable).toBe(true);
  });

  it("supports legacy integer-cent fields", () => {
    expect(kalshiPrice(undefined, 83)).toBeCloseTo(0.83, 6);
    expect(kalshiPrice("0.8300", 12)).toBeCloseTo(0.83, 6); // dollars win
  });

  it("skips multivariate combo legs", () => {
    expect(
      normalizeKalshiMarket({ ...KS_MARKET, mve_collection_ticker: "KXMVE-X" }, KS_EVENT, now),
    ).toBeNull();
  });

  it("derives YES asks from NO bids in the order book", () => {
    const book = normalizeKalshiBook(
      {
        orderbook_fp: {
          yes_dollars: [["0.6300", "300.00"], ["0.8000", "2103.36"]],
          no_dollars: [["0.1400", "2028.78"], ["0.1700", "254.41"]],
        },
      },
      "ks:KXOAIANTH-40-ANTH:yes",
      now,
    );
    expect(book.bestBid).toBeCloseTo(0.8, 6); // highest yes bid
    expect(book.bestAsk).toBeCloseTo(0.83, 6); // 1 - highest no bid (0.17)
    expect(book.bids[0].size).toBeCloseTo(2103.36, 2);
    expect(book.asks[0].size).toBeCloseTo(254.41, 2);
  });
});

describe("coinbase normalization", () => {
  const CB_PRODUCT = {
    product_id: "BTC-USD",
    price: "63315.44",
    price_percentage_change_24h: "1.08",
    volume_24h: "3270.79",
    base_name: "Bitcoin",
    quote_increment: "0.01",
    quote_min_size: "1",
    status: "online",
  };

  it("normalizes spot products as asset-type markets", () => {
    const m = normalizeCoinbaseProduct(CB_PRODUCT, now);
    expect(m).not.toBeNull();
    expect(m!.conditionId).toBe("cb:BTC-USD");
    expect(m!.outcomeType).toBe("asset");
    expect(m!.yesPrice).toBeCloseTo(63315.44, 2);
    expect(m!.volume24h).toBeCloseTo(3270.79 * 63315.44, 0);
    expect(m!.referenceOnly).toBe(false);
    expect(m!.endDate).toBeUndefined();
  });

  it("normalizes the pricebook", () => {
    const book = normalizeCoinbaseBook(
      {
        pricebook: {
          bids: [{ price: "63312", size: "0.0015" }, { price: "63310", size: "0.02" }],
          asks: [{ price: "63313.35", size: "0.018" }, { price: "63314", size: "0.02" }],
        },
      },
      "cb:BTC-USD",
      now,
    );
    expect(book.bestBid).toBeCloseTo(63312, 2);
    expect(book.bestAsk).toBeCloseTo(63313.35, 2);
    expect(book.spread).toBeCloseTo(1.35, 2);
  });
});

describe("crypto threshold parser", () => {
  it("parses $100k-style thresholds with direction", () => {
    const th = parseCryptoThreshold("Will Bitcoin be above $100,000 on July 31?");
    expect(th).toEqual(
      expect.objectContaining({ asset: "BTC", threshold: 100_000, direction: "above", coinbaseProduct: "BTC-USD" }),
    );
    expect(parseUsdAmount("dip under $1.5m")).toBe(1_500_000);
  });

  it("distinguishes touch ('reach/hit/dip') from terminal ('above at close') contracts", () => {
    expect(parseCryptoThreshold("Will Bitcoin be above $100,000 on July 31?")?.kind).toBe("terminal");
    expect(parseCryptoThreshold("Will Bitcoin reach $72,500 in July?")).toEqual(
      expect.objectContaining({ direction: "above", kind: "touch" }),
    );
    expect(parseCryptoThreshold("Will BTC dip under $50,000 in August?")).toEqual(
      expect.objectContaining({ direction: "below", kind: "touch" }),
    );
  });

  it("past-tense touch phrasings parse identically to present tense", () => {
    // "have reached" is the SAME touch contract as "reach" — a tense change
    // must never silently flip a touch into a terminal (that mispricing is
    // exactly the touch/terminal house rule)
    expect(parseCryptoThreshold("Will Bitcoin have reached $150,000 by December 31?")).toEqual(
      expect.objectContaining({ direction: "above", kind: "touch" }),
    );
    expect(parseCryptoThreshold("Will ETH have dropped below $2,000 by September?")).toEqual(
      expect.objectContaining({ direction: "below", kind: "touch" }),
    );
    expect(parseCryptoThreshold("Will SOL have fallen under $100 this month?")).toEqual(
      expect.objectContaining({ direction: "below", kind: "touch" }),
    );
    expect(parseCryptoThreshold("Will BTC have dipped under $80,000 in October?")).toEqual(
      expect.objectContaining({ direction: "below", kind: "touch" }),
    );
  });

  it("returns null on ambiguity or implausible prices", () => {
    expect(parseCryptoThreshold("Will Bitcoin move this year?")).toBeNull(); // no threshold
    expect(parseCryptoThreshold("Will BTC be between $90k and $100k?")).toBeNull(); // no direction word... has neither above/below
    expect(parseCryptoThreshold("Will ETH be above $5?")).toBeNull(); // implausible
  });
});

describe("cross-venue mapper", () => {
  const pmBtc = makeMarket({
    conditionId: "0xbtc",
    question: "Will Bitcoin be above $100,000 on December 31?",
    endDate: new Date(now + 30 * 86_400_000).toISOString(),
    yesPrice: 0.4,
    volume24h: 50_000,
  });
  const ksBtc: NormalizedMarket = {
    ...makeMarket({
      conditionId: "ks:KXBTC-100K",
      question: "Bitcoin above $100,000 by December 31?",
      endDate: new Date(now + 30 * 86_400_000 + 3_600_000).toISOString(),
      yesPrice: 0.52,
    }),
    venueId: "kalshi",
    venueMarketId: "KXBTC-100K",
    resolutionSource: "CF Benchmarks",
  };
  const cbBtc = normalizeCoinbaseProduct(
    { product_id: "BTC-USD", price: "63315", volume_24h: "3000", base_name: "Bitcoin" },
    now,
  )!;

  it("links event markets to spot as reference_only, never tradable-equivalent", () => {
    const link = compareMarkets(pmBtc, cbBtc, now);
    expect(link).not.toBeNull();
    expect(link!.matchStatus).toBe("reference_only");
    expect(link!.dimensions.find((d) => d.name === "instrument_class")?.comparable).toBe(false);
  });

  it("caps threshold-matched binaries at strong_candidate (never exact)", () => {
    const link = compareMarkets(pmBtc, ksBtc, now);
    expect(link).not.toBeNull();
    expect(link!.matchStatus).toBe("strong_candidate");
    expect(link!.divergence).toBeCloseTo(0.12, 6);
    // wording is always flagged non-comparable
    expect(link!.dimensions.find((d) => d.name === "resolution_wording")?.comparable).toBe(false);
  });

  it("flags disagreeing thresholds as conflict", () => {
    const ks90 = { ...ksBtc, question: "Bitcoin above $90,000 by December 31?" };
    const link = compareMarkets(pmBtc, ks90, now);
    expect(link!.matchStatus).toBe("conflict");
  });

  it("flags touch vs terminal at the same level as conflict — not the same contract", () => {
    const ksTouch = { ...ksBtc, question: "Bitcoin hits $100,000 by December 31?" };
    const link = compareMarkets(pmBtc, ksTouch, now);
    expect(link!.matchStatus).toBe("conflict");
    expect(link!.dimensions.find((d) => d.name === "threshold")?.comparable).toBe(false);
  });

  it("marks far-apart close times not_comparable", () => {
    const ksFar = {
      ...ksBtc,
      question: "Bitcoin above $100,000 by June 30?",
      endDate: new Date(now + 200 * 86_400_000).toISOString(),
    };
    const link = compareMarkets(pmBtc, ksFar, now);
    expect(link!.matchStatus).toBe("not_comparable");
  });

  it("buildCrossVenueLinks assembles the universe without same-venue links", () => {
    const links = buildCrossVenueLinks([pmBtc, ksBtc, cbBtc], now);
    expect(links.length).toBeGreaterThanOrEqual(3); // pm↔ks, pm↔cb, ks↔cb
    expect(links.every((l) => l.sourceVenueId !== l.targetVenueId)).toBe(true);
  });
});

describe("cross-venue signals", () => {
  const settings = makeSettings({ minLiquidityUsd: 1_000 });
  const market = makeMarket({
    question: "Will Bitcoin be above $100,000 on December 31?",
    endDate: new Date(now + 30 * 86_400_000).toISOString(),
    yesPrice: 0.4,
  });

  it("reference_price stays NEUTRAL, self-rejects on stale spot", () => {
    const fresh = referencePriceSignal.run({
      market,
      reference: { spot: 63_000, spotSource: "coinbase:BTC-USD", spotFreshnessMs: 900, realizedVolDaily: 0.03 },
      settings,
      now,
    });
    expect(fresh).not.toBeNull();
    expect(fresh!.direction).toBe("NEUTRAL");
    expect(fresh!.checks.find((c) => c.name === "model_assumptions")?.passed).toBe(false);
    expect(fresh!.status).toBe("rejected"); // model_assumptions always fails → review

    const stale = referencePriceSignal.run({
      market,
      reference: { spot: 63_000, spotFreshnessMs: 20_000 },
      settings,
      now,
    });
    expect(stale!.checks.find((c) => c.name === "reference_freshness")?.passed).toBe(false);
  });

  it("venue_divergence fires only on strong candidates clearing both venues' costs", () => {
    const other: NormalizedMarket = {
      ...makeMarket({ conditionId: "ks:X", yesPrice: 0.55, spread: 0.02 }),
      venueId: "kalshi",
      venueMarketId: "X",
    };
    const link = {
      id: "l1",
      sourceVenueId: "polymarket" as const,
      sourceMarketId: market.conditionId,
      sourceTitle: market.question,
      targetVenueId: "kalshi" as const,
      targetMarketId: "ks:X",
      targetTitle: other.question,
      matchStatus: "strong_candidate" as const,
      matchScore: 0.85,
      dimensions: [{ name: "close_time", comparable: true, note: "1h apart" }],
      divergence: 0.15,
      updatedAt: now,
    };
    const sig = venueDivergenceSignal.run({
      market: { ...market, spread: 0.02 },
      crossLinks: [link],
      relatedMarkets: [other],
      settings,
      now,
    });
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("NEUTRAL");
    expect(sig!.summary).toContain("CANDIDATE DISCREPANCY");
    expect(sig!.checks.find((c) => c.name === "resolution_rules_verified")?.passed).toBe(false);
    expect(sig!.status).toBe("rejected"); // always requires human review

    // weak candidates never fire
    const weak = venueDivergenceSignal.run({
      market,
      crossLinks: [{ ...link, matchStatus: "weak_candidate" as const }],
      relatedMarkets: [other],
      settings,
      now,
    });
    expect(weak).toBeNull();
  });
});

describe("venue-aware risk engine", () => {
  const settings = makeSettings();

  it("blocks orders on reference-only markets", () => {
    const a = evaluateTrade({
      proposal: { tokenId: "tok-yes", side: "BUY", orderType: "limit", price: 0.5, size: 10 },
      portfolio: makePortfolio(),
      settings,
      market: makeMarket({ referenceOnly: true }),
      book: makeBook(),
    });
    expect(a.approved).toBe(false);
    expect(a.checks.find((c) => c.name === "venue_tradability")?.passed).toBe(false);
  });

  it("evaluates asset (spot) proposals with relative spread and no Kelly", () => {
    const spot = 63_000;
    const a = evaluateTrade({
      proposal: { tokenId: "cb:BTC-USD", conditionId: "cb:BTC-USD", side: "BUY", orderType: "limit", price: spot, size: 0.001 },
      portfolio: makePortfolio(),
      settings,
      market: {
        ...makeMarket({
          conditionId: "cb:BTC-USD",
          liquidity: 200_000_000,
          spread: 1.35,
          midpoint: spot,
        }),
        venueId: "coinbase",
        venueMarketId: "BTC-USD",
        outcomeType: "asset",
      },
      book: makeBook({
        bids: [{ price: 62_999, size: 5 }],
        asks: [{ price: 63_001, size: 5 }],
        bestBid: 62_999,
        bestAsk: 63_001,
        midpoint: spot,
        spread: 2,
      }),
    });
    // $63 notional inside caps; relative spread tiny; no probability checks
    expect(a.approved).toBe(true);
    expect(a.kellyFraction).toBe(0);
    expect(a.expectedValueUsd).toBe(0);
    expect(a.checks.find((c) => c.name === "ev_model")).toBeDefined();
    expect(a.checks.find((c) => c.name === "price_bounds")?.passed).toBe(true);
    const spreadCheck = a.checks.find((c) => c.name === "spread_limit");
    expect(spreadCheck?.passed).toBe(true); // 2/63000 ≪ 3%
  });
});
