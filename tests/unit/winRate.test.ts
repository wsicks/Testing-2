import { describe, expect, it } from "vitest";
import { strategyHitRates, wilsonLower } from "@/lib/alpha/hitRate";
import {
  decideEntries,
  GOVERNOR_MIN_HIT_RATE,
  GOVERNOR_MIN_SAMPLES,
  type PolicyInput,
} from "@/lib/engine/autopilot/policy";
import { favoriteConvergenceSignal } from "@/lib/engine/signals/favoriteConvergence";
import type { AlphaOutcome } from "@/lib/alpha/types";
import type { SignalResult } from "@/lib/types";
import { DEFAULT_AUTOPILOT } from "@/lib/constants";
import { makeMarket, makePortfolio, makeSettings } from "../helpers";

const now = Date.now();
const settings = makeSettings();

function outcome(featureId: string, d1h: number | undefined, spread = 0.01): AlphaOutcome {
  return {
    id: `${featureId}:${Math.random()}`,
    featureId,
    signalId: "s",
    conditionId: "m",
    direction: "BUY_YES",
    entryMid: 0.5,
    spreadAtSignal: spread,
    tradable: true,
    wasProposed: true,
    createdAt: now,
    buckets: d1h === undefined ? {} : { b1h: { drift: d1h, at: now } },
  };
}

describe("hit rate measurement", () => {
  it("wilson lower bound punishes small samples", () => {
    // 12/20 = 60% point estimate but the proven floor is far lower
    expect(wilsonLower(12, 20)).toBeLessThan(0.42);
    // the same rate over 200 samples is nearly proven
    expect(wilsonLower(120, 200)).toBeGreaterThan(0.52);
    expect(wilsonLower(0, 0)).toBe(0);
  });

  it("separates gross wins from net wins that clear friction", () => {
    const rows = [
      outcome("a", 0.03, 0.01), // clears 0.5c half-spread + 0.5c slippage
      outcome("a", 0.005, 0.01), // positive but does NOT clear 1c friction
      outcome("a", -0.02, 0.01),
      outcome("a", undefined), // no capture — excluded from n
    ];
    const [hr] = strategyHitRates(rows);
    expect(hr.n).toBe(3);
    expect(hr.wins).toBe(2);
    expect(hr.netWins).toBe(1);
    expect(hr.hitRate).toBeCloseTo(2 / 3, 4);
  });
});

describe("hit-rate governor", () => {
  function policyInput(hitRates: PolicyInput["hitRates"]): PolicyInput {
    const market = makeMarket();
    const sig: SignalResult = {
      id: "sig1",
      strategy: "price_movement",
      strategyLabel: "Momentum",
      conditionId: market.conditionId,
      direction: "BUY_YES",
      score: 80,
      status: "proposed",
      summary: "test",
      checks: [],
      createdAt: now,
      expiresAt: now + 60_000,
    };
    return {
      signals: [sig],
      markets: new Map([[market.conditionId, market]]),
      regimes: new Map(),
      portfolio: makePortfolio(),
      settings,
      config: { ...DEFAULT_AUTOPILOT, mode: "paper", requireRegimeMatch: false },
      bandit: [],
      managed: [],
      session: { trades: 0, notionalUsd: 0, tradesLastHour: 0 },
      hitRates,
      now,
    };
  }

  it("blocks entries from strategies with a proven-bad hit rate", () => {
    const bad = strategyHitRates(
      Array.from({ length: 30 }, (_, i) => outcome("price_movement", i < 9 ? 0.02 : -0.02)),
    );
    expect(bad[0].n).toBeGreaterThanOrEqual(GOVERNOR_MIN_SAMPLES);
    expect(bad[0].hitRate).toBeLessThan(GOVERNOR_MIN_HIT_RATE);
    const out = decideEntries(policyInput(new Map(bad.map((h) => [h.strategy, h]))));
    expect(out.candidates).toHaveLength(0);
    expect(out.skips.some((s) => s.reason.includes("hit-rate governor"))).toBe(true);
  });

  it("lets unproven strategies keep exploring", () => {
    const thin = strategyHitRates(
      Array.from({ length: 5 }, () => outcome("price_movement", -0.02)),
    );
    const out = decideEntries(policyInput(new Map(thin.map((h) => [h.strategy, h]))));
    expect(out.candidates).toHaveLength(1);
  });

  it("boosts proven strategies above unproven ones in ranking", () => {
    // drifts large enough that avg drift clears the market's friction —
    // otherwise the net-economics gate (tested separately) blocks entries
    const proven = strategyHitRates(
      Array.from({ length: 100 }, (_, i) => outcome("price_movement", i < 70 ? 0.05 : -0.02)),
    );
    const withEvidence = decideEntries(policyInput(new Map(proven.map((h) => [h.strategy, h]))));
    const withoutEvidence = decideEntries(policyInput(new Map()));
    expect(withEvidence.candidates[0].rank).toBeGreaterThan(withoutEvidence.candidates[0].rank);
  });
});

describe("favorite convergence", () => {
  const favMarket = (over: Parameters<typeof makeMarket>[0] = {}) =>
    makeMarket({
      midpoint: 0.91,
      yesPrice: 0.91,
      bestBid: 0.905,
      bestAsk: 0.915,
      spread: 0.01,
      endDate: new Date(now + 3 * 86_400_000).toISOString(),
      ...over,
    });

  it("proposes buying the YES favorite with tight spread near close", () => {
    const sig = favoriteConvergenceSignal.run({ market: favMarket(), settings, now })!;
    expect(sig).not.toBeNull();
    expect(sig.direction).toBe("BUY_YES");
    expect(sig.status).toBe("proposed");
    const plan = sig.meta?.exitPlan as { partialExitAt: number; fullExitAt: number };
    expect(plan.fullExitAt).toBe(0.98);
    expect(plan.partialExitAt).toBeGreaterThan(0.915);
    expect(plan.partialExitAt).toBeLessThan(0.98);
  });

  it("buys the NO side when NO is the favorite", () => {
    const sig = favoriteConvergenceSignal.run({
      market: favMarket({ midpoint: 0.09, yesPrice: 0.09, bestBid: 0.085, bestAsk: 0.095 }),
      settings,
      now,
    })!;
    expect(sig.direction).toBe("BUY_NO");
    expect(sig.status).toBe("proposed");
  });

  it("self-rejects on a wide spread — the edge is smaller than the crossing", () => {
    const sig = favoriteConvergenceSignal.run({
      market: favMarket({ spread: 0.04, bestBid: 0.89, bestAsk: 0.93 }),
      settings,
      now,
    })!;
    expect(sig.status).toBe("rejected");
    expect(sig.checks.find((c) => c.name === "spread_gate")?.passed).toBe(false);
  });

  it("self-rejects when recent tape is dumping the favorite", () => {
    const sig = favoriteConvergenceSignal.run({
      market: favMarket(),
      trades: [
        { side: "SELL", price: 0.91, size: 900, ts: now - 60_000 },
        { side: "SELL", price: 0.905, size: 800, ts: now - 120_000 },
        { side: "BUY", price: 0.91, size: 100, ts: now - 180_000 },
      ],
      settings,
      now,
    })!;
    expect(sig.status).toBe("rejected");
    expect(sig.checks.find((c) => c.name === "no_adverse_flow")?.passed).toBe(false);
  });

  it("sees aggressive NO-token buying as flow AGAINST the YES favorite", () => {
    // buying NO = selling YES; a tape of pure NO buys is the collapse
    const sig = favoriteConvergenceSignal.run({
      market: favMarket(),
      trades: [
        { side: "BUY", price: 0.09, size: 900, ts: now - 60_000, outcome: "No" },
        { side: "BUY", price: 0.095, size: 800, ts: now - 120_000, outcome: "No" },
      ],
      settings,
      now,
    })!;
    expect(sig.status).toBe("rejected");
    expect(sig.checks.find((c) => c.name === "no_adverse_flow")?.passed).toBe(false);
  });

  it("self-rejects a bleeding favorite (adverse 24h momentum)", () => {
    const sig = favoriteConvergenceSignal.run({
      market: favMarket({ oneDayPriceChange: -0.06 }),
      settings,
      now,
    })!;
    expect(sig.status).toBe("rejected");
    expect(sig.checks.find((c) => c.name === "no_adverse_momentum")?.passed).toBe(false);
  });

  it("never fires mid-range, on asset rows, or without a deadline", () => {
    expect(
      favoriteConvergenceSignal.run({ market: favMarket({ midpoint: 0.55, yesPrice: 0.55 }), settings, now }),
    ).toBeNull();
    expect(
      favoriteConvergenceSignal.run({ market: favMarket({ outcomeType: "asset" }), settings, now }),
    ).toBeNull();
    expect(
      favoriteConvergenceSignal.run({ market: favMarket({ endDate: undefined }), settings, now }),
    ).toBeNull();
    // too far out: lockup dominates the tiny convergence room
    expect(
      favoriteConvergenceSignal.run({
        market: favMarket({ endDate: new Date(now + 60 * 86_400_000).toISOString() }),
        settings,
        now,
      }),
    ).toBeNull();
  });
});
