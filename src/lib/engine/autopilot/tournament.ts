import type { StrategyHitRate } from "@/lib/alpha/hitRate";
import type { PrivateEdgeProfile } from "@/lib/alpha/privateEdge";

export interface StrategyTournamentEntry {
  strategy: string;
  score: number;
  tier: "promote" | "shadow" | "probation" | "retire";
  evidence: {
    samples: number;
    hitRate: number;
    netHitRate: number;
    wilsonLo: number;
    privateEdgeCents?: number;
    fillQuality?: number;
  };
  reasons: string[];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function strategyTournament(
  hitRates: StrategyHitRate[],
  privateEdges: PrivateEdgeProfile[] = [],
): StrategyTournamentEntry[] {
  const edgeByStrategy = new Map(privateEdges.map((edge) => [edge.strategy, edge]));
  const strategies = new Set([
    ...hitRates.map((h) => h.strategy),
    ...privateEdges.map((edge) => edge.strategy),
  ]);

  return [...strategies]
    .map((strategy) => {
      const hit = hitRates.find((h) => h.strategy === strategy);
      const edge = edgeByStrategy.get(strategy);
      const samples = Math.max(hit?.n ?? 0, edge?.n ?? 0);
      const sampleScore = clamp(Math.sqrt(samples / 80), 0, 1);
      const hitScore = hit ? clamp((hit.wilsonLo - 0.35) / 0.35, 0, 1) : 0.35;
      const netScore = hit ? clamp((hit.netHitRate - 0.35) / 0.35, 0, 1) : 0.35;
      const edgeScore = edge ? clamp((edge.avgNetDrift1h + 0.01) / 0.05, 0, 1) : 0.5;
      const fillQuality = edge ? clamp(1 - edge.executionPenalty, 0, 1) : 0.5;
      const score = Math.round(
        100 *
          (0.25 * sampleScore +
            0.25 * hitScore +
            0.2 * netScore +
            0.2 * edgeScore +
            0.1 * fillQuality),
      );
      const reasons: string[] = [];
      if (samples < 20) reasons.push("low_sample");
      if ((hit?.wilsonLo ?? 0) >= 0.5) reasons.push("proven_hit_floor");
      if ((edge?.avgNetDrift1h ?? 0) > 0) reasons.push("positive_private_edge");
      if ((edge?.executionPenalty ?? 0) > 0.35) reasons.push("execution_fragile");
      const tier: StrategyTournamentEntry["tier"] =
        samples >= 40 && score >= 70
          ? "promote"
          : samples >= 20 && score >= 50
            ? "shadow"
            : samples >= 20 && score < 35
              ? "retire"
              : "probation";

      return {
        strategy,
        score,
        tier,
        evidence: {
          samples,
          hitRate: hit?.hitRate ?? edge?.hitRate ?? 0,
          netHitRate: hit?.netHitRate ?? edge?.netHitRate ?? 0,
          wilsonLo: hit?.wilsonLo ?? edge?.wilsonNetLo ?? 0,
          privateEdgeCents: edge?.edgeCents,
          fillQuality,
        },
        reasons,
      };
    })
    .sort((a, b) => b.score - a.score || b.evidence.samples - a.evidence.samples);
}
