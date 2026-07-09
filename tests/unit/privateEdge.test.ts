import { describe, expect, it } from "vitest";
import {
  PRIVATE_EDGE_MIN_SAMPLES,
  privateEdgeProfiles,
  privateEdgeVerdict,
} from "@/lib/alpha/privateEdge";
import type { AlphaOutcome } from "@/lib/alpha/types";
import type { SignalResult } from "@/lib/types";
import { makeMarket, makeSettings } from "../helpers";

const now = Date.now();

function outcome(overrides: Partial<AlphaOutcome> = {}): AlphaOutcome {
  return {
    id: `o-${Math.random()}`,
    featureId: "microstructure",
    signalId: "sig",
    conditionId: "0xcond1",
    direction: "BUY_YES",
    entryMid: 0.5,
    spreadAtSignal: 0.01,
    bookAgeMsAtSignal: 5_000,
    tradable: true,
    wasProposed: true,
    createdAt: now,
    buckets: {
      b5m: { drift: 0.04, at: now + 5 * 60_000 },
      b1h: { drift: 0.03, at: now + 60 * 60_000 },
    },
    ...overrides,
  };
}

function signal(overrides: Partial<SignalResult> = {}): SignalResult {
  return {
    id: "sig",
    strategy: "microstructure",
    strategyLabel: "Microstructure",
    conditionId: "0xcond1",
    direction: "BUY_YES",
    score: 82,
    status: "proposed",
    summary: "test",
    checks: [],
    createdAt: now,
    expiresAt: now + 60_000,
    meta: { modelWinProb: 0.62 },
    ...overrides,
  };
}

describe("private edge profiles", () => {
  it("shrinks success rates with a Bayesian prior and measures net edge", () => {
    const rows = Array.from({ length: PRIVATE_EDGE_MIN_SAMPLES }, (_, i) =>
      outcome({ buckets: { b5m: { drift: 0.03 }, b1h: { drift: i < 9 ? 0.03 : -0.01 } } }),
    );
    const [profile] = privateEdgeProfiles(rows);

    expect(profile.sampleReady).toBe(true);
    expect(profile.netWins).toBe(9);
    expect(profile.posteriorNetWinProb).toBeCloseTo(11 / 16, 4);
    expect(profile.avgNetDrift1h).toBeGreaterThan(0);
    expect(profile.notes).toContain("positive_net_drift");
  });

  it("learns fast decay when short-horizon drift vanishes by one hour", () => {
    const rows = Array.from({ length: 20 }, () =>
      outcome({ buckets: { b5m: { drift: 0.04 }, b1h: { drift: 0.004 } } }),
    );
    const [profile] = privateEdgeProfiles(rows);

    expect(profile.halfLifeMs).toBeLessThan(25 * 60_000);
    expect(profile.staleAfterMs).toBeLessThan(40 * 60_000);
    expect(profile.notes).toContain("fast_decay");
  });

  it("blocks a profile that no longer clears current book friction", () => {
    const rows = Array.from({ length: 24 }, () =>
      outcome({ buckets: { b5m: { drift: 0.025 }, b1h: { drift: 0.02 } } }),
    );
    const [profile] = privateEdgeProfiles(rows);
    const verdict = privateEdgeVerdict({
      profile,
      signal: signal(),
      market: makeMarket({ spread: 0.08 }),
      settings: makeSettings(),
      now,
      modelWinProbability: 0.62,
    });

    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toContain("private edge net economics");
  });
});
