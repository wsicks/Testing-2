import { describe, expect, it } from "vitest";
import { liquiditySpreadSignal } from "@/lib/engine/signals/liquiditySpread";
import { priceMovementSignal } from "@/lib/engine/signals/priceMovement";
import { complementSignal } from "@/lib/engine/signals/complement";
import { crossMarketSignal, findRelated, termOverlap } from "@/lib/engine/signals/crossMarket";
import { closingSoonSignal, resolutionClarity } from "@/lib/engine/signals/closingSoon";
import { runAllStrategies, STRATEGIES } from "@/lib/engine/signals/registry";
import { makeBook, makeMarket, makeSettings } from "../helpers";

const now = Date.now();
const settings = makeSettings();

describe("liquidity/spread signal", () => {
  it("scores a tight, deep market as tradable with all checks passing", () => {
    const sig = liquiditySpreadSignal.run({
      market: makeMarket({ spread: 0.008, liquidity: 200_000, volume24h: 300_000 }),
      book: makeBook(),
      settings,
      now,
    });
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("NEUTRAL"); // tradability, not a call
    expect(sig!.score).toBeGreaterThan(60);
    expect(sig!.checks.every((c) => c.passed)).toBe(true);
    expect(sig!.status).toBe("proposed");
  });

  it("rejects a wide-spread market with an explicit failing check", () => {
    const sig = liquiditySpreadSignal.run({
      market: makeMarket({ spread: 0.12, liquidity: 800, volume24h: 200 }),
      settings,
      now,
    });
    expect(sig).not.toBeNull();
    expect(sig!.status).toBe("rejected");
    const spreadCheck = sig!.checks.find((c) => c.name === "spread_tight");
    expect(spreadCheck?.passed).toBe(false);
    expect(spreadCheck?.detail).toContain("Spread");
  });
});

describe("price movement signal", () => {
  it("returns null when nothing moved", () => {
    const sig = priceMovementSignal.run({
      market: makeMarket({ oneDayPriceChange: 0.01, oneHourPriceChange: 0.001 }),
      settings,
      now,
    });
    expect(sig).toBeNull();
  });

  it("follows momentum when volume supports the move", () => {
    const sig = priceMovementSignal.run({
      market: makeMarket({ oneDayPriceChange: 0.15, oneHourPriceChange: 0.04, volume24h: 500_000 }),
      settings,
      now,
    });
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("BUY_YES");
    expect(sig!.meta?.meanReversionRisk).toBeLessThan(0.6);
  });

  it("stays NEUTRAL when volume does not support the move", () => {
    const sig = priceMovementSignal.run({
      market: makeMarket({ oneDayPriceChange: -0.2, volume24h: 500 }),
      settings,
      now,
    });
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("NEUTRAL");
    expect(sig!.checks.find((c) => c.name === "volume_support")?.passed).toBe(false);
  });
});

describe("complement probability check", () => {
  it("returns null when YES+NO ≈ 1 within costs", () => {
    const sig = complementSignal.run({
      market: makeMarket({ yesPrice: 0.55, noPrice: 0.455, spread: 0.02 }),
      settings,
      now,
    });
    expect(sig).toBeNull();
  });

  it("flags an abnormal sum but never self-approves execution", () => {
    const sig = complementSignal.run({
      market: makeMarket({ yesPrice: 0.62, noPrice: 0.46, spread: 0.005 }),
      settings,
      now,
    });
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("NEUTRAL");
    // execution gate must always be a failing check → status rejected (review)
    expect(sig!.checks.find((c) => c.name === "risk_engine_approval")?.passed).toBe(false);
    expect(sig!.status).toBe("rejected");
    expect(sig!.meta?.deviation).toBeCloseTo(0.08, 5);
  });
});

describe("cross-market scanner", () => {
  const anchor = makeMarket({
    conditionId: "0xa",
    eventSlug: "world-cup-2026",
    negRisk: true,
    question: "Will Spain win the 2026 World Cup?",
    yesPrice: 0.4,
  });
  const sibling = makeMarket({
    conditionId: "0xb",
    eventSlug: "world-cup-2026",
    question: "Will France win the 2026 World Cup?",
    yesPrice: 0.75,
  });

  it("computes term overlap", () => {
    expect(termOverlap("Will Spain win the 2026 World Cup?", "Will France win the 2026 World Cup?")).toBeGreaterThan(0.4);
  });

  it("finds same-event relations", () => {
    const rel = findRelated(anchor, [anchor, sibling]);
    expect(rel).toHaveLength(1);
    expect(rel[0].basis).toBe("same_event");
  });

  it("flags same-event sum inconsistency but always requires human review", () => {
    const sig = crossMarketSignal.run({
      market: anchor,
      relatedMarkets: [anchor, sibling],
      settings,
      now,
    });
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("NEUTRAL");
    // never assume arbitrage: resolution check is always unverified
    expect(sig!.checks.find((c) => c.name === "resolution_rules_verified")?.passed).toBe(false);
    expect(sig!.status).toBe("rejected");
    expect(sig!.meta?.groupSum).toBeCloseTo(1.15, 5);
  });

  it("returns null with no related markets", () => {
    const other = makeMarket({ conditionId: "0xc", question: "Entirely unrelated bill passage?", eventSlug: "other" });
    expect(
      crossMarketSignal.run({ market: anchor, relatedMarkets: [other], settings, now }),
    ).toBeNull();
  });
});

describe("closing-soon scanner", () => {
  it("ignores markets outside the window", () => {
    const sig = closingSoonSignal.run({
      market: makeMarket({ endDate: new Date(now + 90 * 86_400_000).toISOString() }),
      settings,
      now,
    });
    expect(sig).toBeNull();
  });

  it("surfaces near-close markets with uncertainty + clarity context", () => {
    const sig = closingSoonSignal.run({
      market: makeMarket({ endDate: new Date(now + 5 * 3_600_000).toISOString(), midpoint: 0.5 }),
      settings,
      now,
    });
    expect(sig).not.toBeNull();
    expect(sig!.meta?.uncertainty).toBeCloseTo(1, 2);
    expect(sig!.checks.find((c) => c.name === "settlement_clarity")).toBeDefined();
  });

  it("grades resolution clarity from description text", () => {
    expect(resolutionClarity(undefined).level).toBe("low");
    expect(resolutionClarity("short").level).toBe("low");
    expect(
      resolutionClarity(
        "This market will resolve to 'Yes' if X happens. The resolution source is the official report.",
      ).level,
    ).toBe("high");
  });
});

describe("registry", () => {
  it("registers all ten strategies", () => {
    expect(STRATEGIES.map((s) => s.id)).toEqual([
      "liquidity_spread",
      "price_movement",
      "complement_check",
      "cross_market",
      "closing_soon",
      "dislocation",
      "microstructure",
      "reference_price",
      "venue_divergence",
      "ecl",
    ]);
  });

  it("runs every strategy without cross-strategy crashes", () => {
    const out = runAllStrategies({
      market: makeMarket(),
      book: makeBook(),
      relatedMarkets: [makeMarket()],
      settings,
      now,
    });
    expect(Array.isArray(out)).toBe(true);
    for (const s of out) {
      expect(s.checks.length).toBeGreaterThan(0);
      expect(s.summary.length).toBeGreaterThan(0);
    }
  });
});
