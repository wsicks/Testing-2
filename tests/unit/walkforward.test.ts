import { describe, expect, it } from "vitest";
import {
  REPLAY_RULES,
  replayableFeatures,
  walkForwardReplay,
  type ReplayRule,
  type ReplaySeries,
} from "@/lib/alpha/walkforward";
import { prosecute } from "@/server/alpha/prosecutor";
import { seedSourceRecords } from "@/lib/alpha/sources.seed";
import { evaluateExit } from "@/lib/engine/autopilot/exits";
import { DEFAULT_AUTOPILOT } from "@/lib/constants";
import { mulberry32 } from "@/lib/rng";
import type { ManagedPosition } from "@/lib/types";

const now = Date.now();
const HOUR = 3_600;

function bars(n: number, gen: (i: number) => number, t0 = 1_700_000_000): ReplaySeries["bars"] {
  return Array.from({ length: n }, (_, i) => ({ t: t0 + i * HOUR, p: Math.min(0.97, Math.max(0.03, gen(i))) }));
}

// a rule that buys whenever price < 0.5 — profits on mean-reverting series
const cheapRule: ReplayRule = {
  featureId: "test_rule",
  label: "buy cheap",
  minBars: 5,
  assumptions: ["test"],
  decide(b) {
    return b[b.length - 1].p < 0.45 ? "BUY_YES" : null;
  },
};

describe("purged walk-forward replay", () => {
  it("is point-in-time: the rule never sees future bars", () => {
    let maxSeen = 0;
    const spyRule: ReplayRule = {
      ...cheapRule,
      decide(b) {
        maxSeen = Math.max(maxSeen, b[b.length - 1].t);
        return null;
      },
    };
    const series = [{ marketId: "m1", category: "other", bars: bars(60, (i) => 0.5 + 0.01 * Math.sin(i)) }];
    walkForwardReplay(spyRule, series, { frictionC: 0.01, resolution: "test", ranAt: now });
    // last decidable bar is len-horizon-1; the horizon bars beyond it are never shown
    const lastBarT = series[0].bars[series[0].bars.length - 1].t;
    expect(maxSeen).toBeLessThan(lastBarT);
  });

  it("profits on mean reversion, charges friction, fills folds", () => {
    const rand = mulberry32(42);
    // oscillating series: dips below 0.45 revert to 0.5
    const series: ReplaySeries[] = Array.from({ length: 6 }, (_, m) => ({
      marketId: `m${m}`,
      category: m % 2 === 0 ? "crypto" : "politics",
      bars: bars(240, (i) => 0.5 + (i % 12 < 3 ? -0.08 : 0) + (rand() - 0.5) * 0.01),
    }));
    const res = walkForwardReplay(cheapRule, series, { frictionC: 0.005, resolution: "test-hourly", ranAt: now });
    expect(res.outcomes).toBeGreaterThan(20);
    expect(res.avgNet).toBeGreaterThan(0);
    expect(res.folds).toHaveLength(4);
    expect(res.positiveFolds).toBeGreaterThanOrEqual(3);
    expect(res.markets).toBe(6);
    expect(res.categories.map((c) => c.category).sort()).toEqual(["crypto", "politics"]);
    expect(res.singleMarketShare).toBeLessThan(0.5);
    expect(res.isHistoricalSimulation).toBe(true);
    // higher friction must strictly reduce net
    const costly = walkForwardReplay(cheapRule, series, { frictionC: 0.03, resolution: "t", ranAt: now });
    expect(costly.avgNet).toBeLessThan(res.avgNet);
  });

  it("flags a single lucky market carrying the result", () => {
    const flat: ReplaySeries[] = Array.from({ length: 4 }, (_, m) => ({
      marketId: `flat${m}`,
      category: "other",
      // dips that do NOT revert — losing trades after friction
      bars: bars(240, (i) => (i % 12 < 6 ? 0.44 : 0.44)),
    }));
    const lucky: ReplaySeries = {
      marketId: "lucky",
      category: "other",
      bars: bars(240, (i) => (i % 12 < 3 ? 0.4 : 0.6)), // huge reversion wins
    };
    const res = walkForwardReplay(cheapRule, [...flat, lucky], { frictionC: 0.005, resolution: "t", ranAt: now });
    expect(res.singleMarketShare).toBeGreaterThan(0.5);
  });

  it("exposes replay rules only for price-replayable features", () => {
    expect(replayableFeatures().sort()).toEqual(["dislocation", "price_movement"]);
    expect(REPLAY_RULES.dislocation.minBars).toBeGreaterThan(0);
  });
});

describe("prosecutor backtest gate", () => {
  const sources = seedSourceRecords(now);
  const emptyEvidence = {
    featureId: "dislocation", outcomes: 0, tradableOutcomes: 0, proposedOutcomes: 0,
    distinctMarkets: 0, distinctDays: 0, avgSpread: 0, staleShare: 0,
    luckyConcentration: 0, maxAdverseRun: 0, curve: [], firstAt: undefined, lastAt: undefined,
  };
  const base = {
    id: "dislocation", name: "d", thesis: "t", dataSources: ["polymarket_clob"],
    categoryScope: ["all"], status: "paper_testing" as const, killCriteria: "k",
    createdAt: now, updatedAt: now,
  };

  it("fails a replayable feature that has not run the backtest", () => {
    const v = prosecute({
      feature: base, evidence: emptyEvidence, recentEvidence: emptyEvidence,
      sources, slippageBps: 50, maxSpread: 0.03,
    });
    expect(v.tests.find((t) => t.name === "backtest_walk_forward")?.passed).toBe(false);
  });

  it("passes a replayable feature with a robust backtest, fails a lucky one", () => {
    const good = {
      ...base,
      lastBacktest: {
        featureId: "dislocation", resolution: "t", horizonBars: 6, purgeBars: 6,
        frictionC: 0.01, outcomes: 80, markets: 12, avgNet: 0.012, winRate: 0.6,
        positiveFolds: 4,
        folds: [0, 1, 2, 3].map((f) => ({ fold: f, n: 20, avgNet: 0.01, winRate: 0.6 })),
        categories: [], luckyConcentration: 0.2, singleMarketShare: 0.3,
        assumptions: [], ranAt: now, isHistoricalSimulation: true as const,
      },
    };
    const v = prosecute({
      feature: good, evidence: emptyEvidence, recentEvidence: emptyEvidence,
      sources, slippageBps: 50, maxSpread: 0.03,
    });
    expect(v.tests.find((t) => t.name === "backtest_walk_forward")?.passed).toBe(true);

    const lucky = { ...good, lastBacktest: { ...good.lastBacktest, singleMarketShare: 0.8 } };
    const v2 = prosecute({
      feature: lucky, evidence: emptyEvidence, recentEvidence: emptyEvidence,
      sources, slippageBps: 50, maxSpread: 0.03,
    });
    expect(v2.tests.find((t) => t.name === "backtest_walk_forward")?.passed).toBe(false);
  });

  it("passes non-replayable features on explicit forward-evidence grounds", () => {
    const wallet = { ...base, id: "wallet_shadow", dataSources: ["polymarket_data"] };
    const v = prosecute({
      feature: wallet, evidence: { ...emptyEvidence, featureId: "wallet_shadow" },
      recentEvidence: { ...emptyEvidence, featureId: "wallet_shadow" },
      sources, slippageBps: 50, maxSpread: 0.03,
    });
    const t = v.tests.find((x) => x.name === "backtest_walk_forward");
    expect(t?.passed).toBe(true);
    expect(t?.evidence).toContain("forward paper evidence");
  });
});

describe("mechanical exit plan (ECL partial exits)", () => {
  const pos: ManagedPosition = {
    tokenId: "tok", strategy: "ecl", mode: "paper",
    entryPrice: 0.76, size: 20, openedAt: now - 10 * 60_000, peakPrice: 0.76,
    endDate: new Date(now + 6 * 3_600_000).toISOString(),
    exitPlan: { partialAt: 0.86, fullAt: 0.9 },
  };
  const config = { ...DEFAULT_AUTOPILOT, targetPct: 12, stopPct: 8, flattenBeforeCloseMin: 30, maxHoldMin: 240 };

  it("takes the 50% tranche once at the partial level", () => {
    const d = evaluateExit(pos, 0.87, config, now);
    expect(d.action).toBe("partial_exit");
    expect(d.reason).toBe("plan_partial");
    expect(d.sellSize).toBe(10);
    // once partialDone, the same price holds (until full level)
    const d2 = evaluateExit({ ...pos, partialDone: true, size: 10 }, 0.87, config, now);
    expect(d2.action).toBe("hold");
  });

  it("exits the rest at the full level and beats the generic target", () => {
    const d = evaluateExit({ ...pos, partialDone: true, size: 10 }, 0.91, config, now);
    expect(d.action).toBe("exit");
    expect(d.reason).toBe("plan_full");
    // without a plan the same move would have hit the generic % target
    const noPlan = evaluateExit({ ...pos, exitPlan: undefined }, 0.91, config, now);
    expect(noPlan.reason).toBe("target");
  });

  it("never partial-exits a 1-share lot; stop still outranks the plan", () => {
    const tiny = evaluateExit({ ...pos, size: 1 }, 0.87, config, now);
    expect(tiny.action).toBe("hold"); // partial needs ≥2 shares; full level not reached
    const stopped = evaluateExit(pos, 0.69, config, now);
    expect(stopped.reason).toBe("stop");
  });
});
