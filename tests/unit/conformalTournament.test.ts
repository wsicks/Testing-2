import { describe, expect, it } from "vitest";
import { conformalEdgePass, conformalInterval } from "@/lib/engine/risk/conformal";
import { strategyTournament } from "@/lib/engine/autopilot/tournament";
import type { StrategyHitRate } from "@/lib/alpha/hitRate";
import type { PrivateEdgeProfile } from "@/lib/alpha/privateEdge";

describe("conformal edge bands", () => {
  it("builds a lower confidence edge from residuals", () => {
    const band = conformalInterval([0.02, 0.021, 0.019, 0.018, 0.023], 0.02, 0.2);

    expect(band.lower).toBeLessThan(0.02);
    expect(band.upper).toBeGreaterThan(0.02);
    expect(band.n).toBe(5);
  });

  it("blocks when the conformal lower bound does not clear the edge requirement", () => {
    const out = conformalEdgePass(
      Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 0.02 : -0.01)),
      0,
      0.1,
    );

    expect(out.allow).toBe(false);
    expect(out.reason).toContain("does not clear");
  });
});

describe("strategy tournament", () => {
  it("promotes only strategies with samples, hit floor, and private edge", () => {
    const hit: StrategyHitRate = {
      strategy: "winner",
      n: 80,
      wins: 60,
      hitRate: 0.75,
      wilsonLo: 0.64,
      netWins: 52,
      netHitRate: 0.65,
      avgDrift1h: 0.04,
    };
    const edge = {
      strategy: "winner",
      n: 80,
      sampleReady: true,
      hitRate: 0.75,
      netHitRate: 0.65,
      wilsonNetLo: 0.55,
      avgNetDrift1h: 0.03,
      edgeCents: 3,
      executionPenalty: 0.1,
    } as PrivateEdgeProfile;
    const [entry] = strategyTournament([hit], [edge]);

    expect(entry.strategy).toBe("winner");
    expect(entry.tier).toBe("promote");
    expect(entry.score).toBeGreaterThanOrEqual(70);
    expect(entry.reasons).toContain("positive_private_edge");
  });
});
