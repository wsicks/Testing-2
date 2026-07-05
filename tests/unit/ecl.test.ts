import { describe, expect, it } from "vitest";
import {
  binaryEntropy,
  clarityScore,
  cryptoShadowProb,
  eclSignal,
} from "@/lib/engine/signals/ecl";
import { makeBook, makeMarket, makeSettings } from "../helpers";

const now = Date.now();
const settings = makeSettings();

// the canonical setup: BTC threshold market minutes from close, spot already
// through the threshold, market still priced like it's uncertain
function btcContext(overrides: Partial<Parameters<typeof eclSignal.run>[0]> = {}) {
  const market = makeMarket({
    question: "Will BTC be above $100,000 at 4:00 PM ET?",
    endDate: new Date(now + 8 * 60_000).toISOString(), // 8 minutes left
    yesPrice: 0.75,
    bestBid: 0.74,
    bestAsk: 0.76,
    spread: 0.02,
    midpoint: 0.75,
  });
  return {
    market,
    book: makeBook({
      bids: [{ price: 0.74, size: 2_000 }],
      asks: [{ price: 0.76, size: 2_000 }],
      bestBid: 0.74,
      bestAsk: 0.76,
      midpoint: 0.75,
      spread: 0.02,
      bidDepthUsd: 1_480,
      askDepthUsd: 1_520,
    }),
    reference: {
      spot: 100_480,
      spotSource: "coinbase:BTC-USD",
      spotFreshnessMs: 500,
      realizedVolDaily: 0.02,
    },
    settings,
    now,
    ...overrides,
  };
}

describe("ECL math", () => {
  it("binary entropy peaks at 50% and collapses toward certainty", () => {
    expect(binaryEntropy(0.5)).toBeCloseTo(Math.log(2), 6);
    expect(binaryEntropy(0.95)).toBeLessThan(binaryEntropy(0.6));
    expect(binaryEntropy(0.01)).toBeCloseTo(binaryEntropy(0.99), 6);
  });

  it("shadow probability collapses when spot is through the threshold near close", () => {
    // $100,480 vs $100k, 8 min left, 2%/day vol → near-certain
    const p = cryptoShadowProb(100_480, 100_000, 0.02, 8 / 1440, "above");
    expect(p).toBeGreaterThan(0.95);
    // symmetric: "below" is the complement view
    const pBelow = cryptoShadowProb(100_480, 100_000, 0.02, 8 / 1440, "below");
    expect(pBelow).toBeLessThan(0.05);
    // far from threshold with time left → genuinely uncertain
    const pFar = cryptoShadowProb(100_000, 100_000, 0.03, 5, "above");
    expect(pFar).toBeGreaterThan(0.3);
    expect(pFar).toBeLessThan(0.6);
  });

  it("clips to [0.01, 0.99]", () => {
    expect(cryptoShadowProb(200_000, 100_000, 0.01, 0.001, "above")).toBe(0.99);
  });

  it("maps clarity levels onto the 0.90 gate", () => {
    expect(clarityScore("high")).toBeGreaterThanOrEqual(0.9);
    expect(clarityScore("medium")).toBeLessThan(0.9);
  });
});

describe("ECL signal", () => {
  it("fires on the canonical repricing-debt setup with all gates passing", () => {
    const sig = eclSignal.run(btcContext());
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("BUY_YES");
    expect(sig!.status).toBe("proposed"); // every gate passed
    expect(sig!.score).toBeGreaterThan(12);
    const meta = sig!.meta!;
    expect(meta.pShadow as number).toBeGreaterThan(0.9);
    expect(meta.entropyGap as number).toBeGreaterThan(0.2);
    expect(meta.edgeAfterCost as number).toBeGreaterThan(0.05);
    // crippled sizing: never above $25
    expect(meta.suggestedTestUsd as number).toBeLessThanOrEqual(25);
    const exit = meta.exitPlan as { partialExitAt: number; fullExitAt: number };
    expect(exit.partialExitAt).toBeGreaterThan(0.76);
    expect(exit.fullExitAt).toBeGreaterThan(exit.partialExitAt);
  });

  it("self-rejects on stale reference data (freshness gate)", () => {
    const sig = eclSignal.run(
      btcContext({
        reference: {
          spot: 100_480,
          spotSource: "coinbase:BTC-USD",
          spotFreshnessMs: 8_000,
          realizedVolDaily: 0.02,
        },
      }),
    );
    expect(sig).not.toBeNull();
    expect(sig!.checks.find((c) => c.name === "source_freshness")?.passed).toBe(false);
    expect(sig!.status).toBe("rejected");
  });

  it("self-rejects on a wide spread even with a real edge", () => {
    const ctx = btcContext();
    ctx.market = { ...ctx.market, bestBid: 0.7, bestAsk: 0.78, spread: 0.08 };
    ctx.book = makeBook({
      bids: [{ price: 0.7, size: 2_000 }],
      asks: [{ price: 0.78, size: 2_000 }],
      bestBid: 0.7,
      bestAsk: 0.78,
      midpoint: 0.74,
      spread: 0.08,
    });
    const sig = eclSignal.run(ctx);
    expect(sig).not.toBeNull();
    expect(sig!.checks.find((c) => c.name === "spread_gate")?.passed).toBe(false);
    expect(sig!.status).toBe("rejected");
  });

  it("self-rejects on unclear resolution rules", () => {
    const ctx = btcContext();
    ctx.market = { ...ctx.market, description: "tbd", resolutionSource: undefined };
    const sig = eclSignal.run(ctx);
    expect(sig!.checks.find((c) => c.name === "rule_clarity")?.passed).toBe(false);
    expect(sig!.status).toBe("rejected");
  });

  it("stays silent when the market has already repriced (no edge)", () => {
    const ctx = btcContext();
    ctx.market = { ...ctx.market, bestBid: 0.97, bestAsk: 0.985, midpoint: 0.978 };
    ctx.book = makeBook({
      bids: [{ price: 0.97, size: 2_000 }],
      asks: [{ price: 0.985, size: 2_000 }],
      bestBid: 0.97,
      bestAsk: 0.985,
      midpoint: 0.978,
      spread: 0.015,
    });
    expect(eclSignal.run(ctx)).toBeNull();
  });

  it("refuses to model touch ('reach') markets from spot alone — an earlier touch can't be ruled out", () => {
    const ctx = btcContext({
      reference: {
        spot: 63_000, // below the level: touch NOT provable from current spot
        spotSource: "coinbase:BTC-USD",
        spotFreshnessMs: 500,
        realizedVolDaily: 0.02,
      },
    });
    ctx.market = {
      ...ctx.market,
      question: "Will Bitcoin reach $72,500 in July?",
      endDate: new Date(now + 20 * 86_400_000).toISOString(),
    };
    // a terminal model would scream BUY_NO here; the honest answer is silence
    expect(eclSignal.run(ctx)).toBeNull();
  });

  it("fires on a touch market only when the touch is provable from current spot", () => {
    const ctx = btcContext({
      reference: {
        spot: 73_100, // beyond the level right now → touch proven
        spotSource: "coinbase:BTC-USD",
        spotFreshnessMs: 500,
        realizedVolDaily: 0.02,
      },
    });
    ctx.market = {
      ...ctx.market,
      question: "Will Bitcoin reach $72,500 in July?",
      endDate: new Date(now + 20 * 86_400_000).toISOString(),
    };
    const sig = eclSignal.run(ctx);
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("BUY_YES");
    expect(sig!.meta!.pShadow as number).toBeCloseTo(0.99, 2);
    expect(String(sig!.meta!.shadowSource)).toContain("beyond touch level");
  });

  it("uses a collapsed cross-venue partner as the shadow when no crypto reference exists", () => {
    const market = makeMarket({
      conditionId: "0xevt",
      question: "Will the ruling be announced by Friday?",
      yesPrice: 0.6,
      bestBid: 0.59,
      bestAsk: 0.61,
      spread: 0.02,
      midpoint: 0.6,
    });
    const partner = {
      ...makeMarket({
        conditionId: "ks:KXRULING",
        question: "Ruling announced by Friday?",
        yesPrice: 0.95,
        fetchedAt: now - 400,
      }),
      venueId: "kalshi" as const,
      venueMarketId: "KXRULING",
    };
    const sig = eclSignal.run({
      market,
      book: makeBook({
        bids: [{ price: 0.59, size: 2_000 }],
        asks: [{ price: 0.61, size: 2_000 }],
        bestBid: 0.59,
        bestAsk: 0.61,
        midpoint: 0.6,
        spread: 0.02,
        bidDepthUsd: 1_200,
        askDepthUsd: 1_200,
      }),
      crossLinks: [
        {
          id: "l1",
          sourceVenueId: "polymarket",
          sourceMarketId: "0xevt",
          sourceTitle: market.question,
          targetVenueId: "kalshi",
          targetMarketId: "ks:KXRULING",
          targetTitle: partner.question,
          matchStatus: "strong_candidate",
          matchScore: 0.85,
          dimensions: [],
          updatedAt: now,
        },
      ],
      relatedMarkets: [partner],
      settings,
      now,
    });
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("BUY_YES");
    expect((sig!.meta!.shadowSource as string)).toContain("kalshi");
    expect(sig!.meta!.pShadow as number).toBeCloseTo(0.95, 2);
  });

  it("never fires from weak cross-venue candidates", () => {
    const market = makeMarket({ conditionId: "0xevt", yesPrice: 0.6 });
    const sig = eclSignal.run({
      market,
      book: makeBook(),
      crossLinks: [
        {
          id: "l1",
          sourceVenueId: "polymarket",
          sourceMarketId: "0xevt",
          sourceTitle: "x",
          targetVenueId: "kalshi",
          targetMarketId: "ks:X",
          targetTitle: "y",
          matchStatus: "weak_candidate",
          matchScore: 0.5,
          dimensions: [],
          updatedAt: now,
        },
      ],
      relatedMarkets: [],
      settings,
      now,
    });
    expect(sig).toBeNull();
  });
});
