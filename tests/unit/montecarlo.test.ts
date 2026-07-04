import { describe, expect, it } from "vitest";
import { runMonteCarlo } from "@/lib/engine/montecarlo/monteCarlo";
import type { MonteCarloConfig } from "@/lib/types";

const base: MonteCarloConfig = {
  winRate: 0.52,
  avgWinPct: 40,
  avgLossPct: 45,
  positionPct: 1,
  numTrades: 200,
  numPaths: 500,
  initialCapital: 10_000,
  seed: 7,
};

describe("monte carlo simulator", () => {
  it("is deterministic under a fixed seed", () => {
    const a = runMonteCarlo(base);
    const b = runMonteCarlo(base);
    expect(a.finalEquityPercentiles).toEqual(b.finalEquityPercentiles);
    expect(a.riskOfRuin).toBe(b.riskOfRuin);
  });

  it("produces ordered percentiles and bounded risk of ruin", () => {
    const r = runMonteCarlo(base);
    const p = r.finalEquityPercentiles;
    expect(p.p5).toBeLessThanOrEqual(p.p25);
    expect(p.p25).toBeLessThanOrEqual(p.p50);
    expect(p.p50).toBeLessThanOrEqual(p.p75);
    expect(p.p75).toBeLessThanOrEqual(p.p95);
    expect(r.riskOfRuin).toBeGreaterThanOrEqual(0);
    expect(r.riskOfRuin).toBeLessThanOrEqual(1);
    expect(r.worst5PctOutcome).toBeLessThanOrEqual(p.p5);
    expect(r.isRiskDisplay).toBe(true);
  });

  it("shows oversizing a negative-edge system increases ruin risk", () => {
    const negEdge = { ...base, winRate: 0.45, numTrades: 400 };
    const small = runMonteCarlo({ ...negEdge, positionPct: 1 });
    const huge = runMonteCarlo({ ...negEdge, positionPct: 25 });
    expect(huge.riskOfRuin).toBeGreaterThan(small.riskOfRuin);
    expect(huge.maxDrawdownPercentiles.p50).toBeGreaterThan(
      small.maxDrawdownPercentiles.p50,
    );
  });

  it("keeps drawdown percentiles within [0,1]", () => {
    const r = runMonteCarlo(base);
    expect(r.maxDrawdownPercentiles.p95).toBeLessThanOrEqual(1);
    expect(r.maxDrawdownPercentiles.p5).toBeGreaterThanOrEqual(0);
  });
});
