import { describe, expect, it } from "vitest";
import { scoreGem } from "@/server/morphish";
import type { SignalResult } from "@/lib/types";
import { makeMarket } from "../helpers";

const now = Date.now();

function sig(overrides: Partial<SignalResult> = {}): SignalResult {
  return {
    id: "s1",
    strategy: "ecl",
    strategyLabel: "Entropy Collapse Lag",
    conditionId: "0xcond1",
    direction: "BUY_YES",
    score: 70,
    status: "proposed",
    summary: "test",
    checks: [],
    createdAt: now,
    meta: { edgeAfterCost: 0.08, liquidityScore: 0.9, ruleClarity: 0.95, suggestedTestUsd: 20, currentPrice: 0.5 },
    ...overrides,
  };
}

describe("top gem gating", () => {
  const market = makeMarket({ spread: 0.02, fetchedAt: now - 5_000 });

  it("passes a clean, promoted, fresh candidate", () => {
    const gem = scoreGem({ sig: sig(), market, experimental: false, now });
    expect(gem.blocked).toBe(false);
    expect(gem.gemScore).toBeGreaterThan(0);
    expect(gem.edgeUsdAtTestSize).toBeGreaterThan(0);
    expect(gem.intensity).toBeGreaterThan(0);
  });

  it("blocks experimental features from ever being the gem", () => {
    const gem = scoreGem({ sig: sig(), market, experimental: true, now });
    expect(gem.blocked).toBe(true);
    expect(gem.blockReasons.join(" ")).toContain("experimental");
    expect(gem.gemScore).toBe(0);
  });

  it("blocks stale data, wide spread, low clarity and self-rejected signals", () => {
    const stale = scoreGem({
      sig: sig(), market: makeMarket({ fetchedAt: now - 120_000 }), experimental: false, now,
    });
    expect(stale.blockReasons.join(" ")).toContain("stale");

    const wide = scoreGem({
      sig: sig({ meta: { edgeAfterCost: 0.01, ruleClarity: 0.95, liquidityScore: 0.9 } }),
      market: makeMarket({ spread: 0.05, fetchedAt: now }),
      experimental: false, now,
    });
    expect(wide.blockReasons.join(" ")).toContain("spread");

    const unclear = scoreGem({
      sig: sig({ meta: { edgeAfterCost: 0.08, ruleClarity: 0.5, liquidityScore: 0.9 } }),
      market, experimental: false, now,
    });
    expect(unclear.blockReasons.join(" ")).toContain("clarity");

    const rejected = scoreGem({ sig: sig({ status: "rejected" }), market, experimental: false, now });
    expect(rejected.blocked).toBe(true);

    const neutral = scoreGem({ sig: sig({ direction: "NEUTRAL" }), market, experimental: false, now });
    expect(neutral.blocked).toBe(true);
  });

  it("blocks reference-only markets regardless of edge", () => {
    const gem = scoreGem({
      sig: sig(),
      market: makeMarket({ fetchedAt: now, spread: 0.02 }),
      experimental: false,
      now,
    });
    expect(gem.blocked).toBe(false);
    const ref = scoreGem({
      sig: sig(),
      market: { ...makeMarket({ fetchedAt: now, spread: 0.02 }), referenceOnly: true, tradable: false },
      experimental: false,
      now,
    });
    expect(ref.blocked).toBe(true);
    expect(ref.blockReasons.join(" ")).toContain("reference-only");
  });
});
