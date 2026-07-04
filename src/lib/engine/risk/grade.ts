// Quick per-market risk grade + tradability status for the scanner table.
// Deterministic, explainable: each grade lists the factors that produced it.

import type { NormalizedMarket } from "@/lib/types";
import { resolutionClarity } from "../signals/closingSoon";

export type RiskGrade = "A" | "B" | "C" | "D";
export type Tradability = "tradable" | "caution" | "avoid";

export interface MarketGrade {
  grade: RiskGrade;
  tradability: Tradability;
  factors: string[];
}

export function gradeMarket(m: NormalizedMarket, maxSpread = 0.03): MarketGrade {
  const factors: string[] = [];
  let score = 0;

  if (m.liquidity >= 50_000) score += 3;
  else if (m.liquidity >= 10_000) score += 2;
  else if (m.liquidity >= 2_000) score += 1;
  else factors.push("thin liquidity");

  const spread = m.spread ?? 1;
  if (spread <= 0.01) score += 3;
  else if (spread <= maxSpread) score += 2;
  else if (spread <= maxSpread * 2) score += 1;
  else factors.push("wide spread");

  if (m.volume24h >= 50_000) score += 2;
  else if (m.volume24h >= 5_000) score += 1;
  else factors.push("low volume");

  const clarity = resolutionClarity(m.description, m.resolutionSource);
  if (clarity.level === "high") score += 2;
  else if (clarity.level === "medium") score += 1;
  else factors.push("unclear resolution rules");

  const mid = m.midpoint ?? 0.5;
  if (mid < 0.02 || mid > 0.98) {
    score -= 2;
    factors.push("price at boundary");
  }

  const grade: RiskGrade =
    score >= 8 ? "A" : score >= 6 ? "B" : score >= 4 ? "C" : "D";
  const tradability: Tradability =
    grade === "D" || spread > maxSpread * 2
      ? "avoid"
      : grade === "C" || spread > maxSpread
        ? "caution"
        : "tradable";
  if (factors.length === 0) factors.push("all screens passed");
  return { grade, tradability, factors };
}
