// Flow Toxicity Index (Feature Forge #14) — classifies recent public tape
// flow from measurable structure only:
//
//   informed      one-sided, size-concentrated, bursty — someone knows/thinks
//                 they know something and is paying to act on it
//   market_making alternating sides with uniform small sizes
//   noise         balanced, small, unclustered retail churn
//   mixed         nothing dominates — most tapes, honestly
//
// The label is a structural READ of the tape, not a claim about who is
// trading or whether they are right. Confidence reflects sample size and
// how decisively the metrics separate.

import type { RecentTrade } from "@/lib/types";

export type FlowClass = "informed" | "market_making" | "noise" | "mixed";

export interface FlowToxicity {
  classification: FlowClass;
  confidence: number; // 0–1
  trades: number;
  /** signed aggressor imbalance: (buys − sells) / total, USD-weighted */
  imbalance: number;
  /** share of tape notional in the top 3 prints */
  sizeConcentration: number;
  /** Fano factor of inter-trade gaps (>1 = clustered/bursty arrivals) */
  burstiness: number;
  /** share of adjacent prints that flip side (high = MM-like alternation) */
  alternation: number;
  spanMinutes: number;
}

export function classifyFlow(trades: RecentTrade[]): FlowToxicity | null {
  if (trades.length < 12) return null;
  const rows = [...trades].sort((a, b) => a.ts - b.ts);
  const notionals = rows.map((t) => t.price * t.size);
  const total = notionals.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;

  const buyUsd = rows.reduce((a, t) => a + (t.side === "BUY" ? t.price * t.size : 0), 0);
  const imbalance = (2 * buyUsd - total) / total;

  const top3 = [...notionals].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
  const sizeConcentration = top3 / total;

  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++) gaps.push(Math.max(0, rows[i].ts - rows[i - 1].ts));
  const gMean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const gVar = gaps.reduce((a, b) => a + (b - gMean) ** 2, 0) / gaps.length;
  const burstiness = gMean > 0 ? gVar / gMean ** 2 : 0; // CV² ≈ Fano-style clustering

  let flips = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i].side !== rows[i - 1].side) flips += 1;
  const alternation = flips / (rows.length - 1);

  const spanMinutes = (rows[rows.length - 1].ts - rows[0].ts) / 60_000;

  // decision surface — thresholds are stated, not tuned on outcomes
  const oneSided = Math.abs(imbalance) >= 0.5;
  const concentrated = sizeConcentration >= 0.5;
  const bursty = burstiness >= 2;
  const alternating = alternation >= 0.6;
  const uniform = sizeConcentration <= 0.3;

  let classification: FlowClass = "mixed";
  let strength = 0;
  if (oneSided && (concentrated || bursty)) {
    classification = "informed";
    strength = (Math.abs(imbalance) + Math.max(sizeConcentration, Math.min(1, burstiness / 4))) / 2;
  } else if (alternating && uniform) {
    classification = "market_making";
    strength = (alternation + (1 - sizeConcentration)) / 2;
  } else if (!oneSided && !concentrated && !bursty) {
    classification = "noise";
    strength = 1 - Math.max(Math.abs(imbalance), sizeConcentration, Math.min(1, burstiness / 4));
  }

  const sampleFactor = Math.min(1, rows.length / 40);
  return {
    classification,
    confidence: Number((strength * sampleFactor).toFixed(2)),
    trades: rows.length,
    imbalance: Number(imbalance.toFixed(3)),
    sizeConcentration: Number(sizeConcentration.toFixed(3)),
    burstiness: Number(burstiness.toFixed(2)),
    alternation: Number(alternation.toFixed(3)),
    spanMinutes: Number(spanMinutes.toFixed(1)),
  };
}
