// Strategy 13 — Deadline Curvature (Feature Forge #8).
//
// A TERMINAL threshold market's fair probability must curve nonlinearly as
// the deadline approaches: with spot away from the strike, P collapses
// toward 0/1 at an accelerating rate as τ shrinks. Books that decay
// linearly lag the model curve. This strategy is INFORMATIONAL (NEUTRAL,
// human review required): the model curve holds spot and vol constant — a
// stated simplification, so it diagnoses shape divergence rather than
// asserting fair value. Touch contracts are excluded for the same reason
// they are excluded from ECL: spot alone cannot price the period extreme.
//
// DeadlineCurvatureScore ≈ |model − market| · timeCompression · liquidity
// · ruleClarity / spreadPenalty (per spec), clamped to the 0–100 scale.

import type { SignalContext, SignalResult, SignalStrategy } from "@/lib/types";
import { parseCryptoThreshold } from "../crossvenue/threshold";
import { clarityScore, cryptoShadowProb } from "./ecl";
import { resolutionClarity } from "./closingSoon";
import { buildSignal, check, ramp } from "./helpers";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export const deadlineCurvatureSignal: SignalStrategy = {
  id: "deadline_curvature",
  label: "Deadline Curvature",
  description:
    "Flags terminal threshold markets whose price path decays linearly while the model probability curve is convex near the deadline. Informational — human review required.",

  run(ctx: SignalContext): SignalResult | null {
    const { market, book, history, reference, settings, now } = ctx;
    if (market.outcomeType !== "binary" || !market.endDate) return null;
    const th = parseCryptoThreshold(market.question, market.endDate);
    if (!th || th.kind !== "terminal") return null;
    if (!reference?.spot || !reference.realizedVolDaily) return null;

    const daysLeft = (new Date(market.endDate).getTime() - now) / 86_400_000;
    if (daysLeft <= 0 || daysLeft > 14) return null; // curvature matters near the deadline

    const mid = book?.midpoint ?? market.midpoint ?? market.yesPrice;
    const spread = book?.spread ?? market.spread ?? 0.05;
    if (mid === undefined) return null;

    // model curve at τ, τ/2, τ/4 (spot & vol held constant — stated)
    const p = (tau: number) =>
      cryptoShadowProb(reference.spot!, th.threshold, reference.realizedVolDaily!, tau, th.direction);
    const pNow = p(daysLeft);
    const pHalf = p(daysLeft / 2);
    const pQuarter = p(daysLeft / 4);
    // convexity of the model curve (how much certainty accelerates)
    const modelCurvature = Math.abs(pQuarter - pHalf) - Math.abs(pHalf - pNow);
    const gap = pNow - mid;

    // market path linearity: fit check on recent history (needs ≥5 points)
    let pathLinear: boolean | undefined;
    if (history && history.length >= 5) {
      const recent = history.slice(-10);
      const first = recent[0].p, last = recent[recent.length - 1].p;
      const step = (last - first) / (recent.length - 1);
      const maxDev = Math.max(
        ...recent.map((pt, i) => Math.abs(pt.p - (first + step * i))),
      );
      pathLinear = maxDev < 0.02; // ±2c of a straight line
    }

    const timeCompression = clamp01(1 - daysLeft / 14);
    const clarity = resolutionClarity(market.description, market.resolutionSource);
    const ruleClarity = clarityScore(clarity.level);
    const liquidityScore = clamp01(market.liquidity / Math.max(1, settings.minLiquidityUsd * 4));

    const rawScore =
      (100 * Math.abs(gap) * (1 + 5 * Math.max(0, modelCurvature)) * timeCompression * liquidityScore * ruleClarity) /
      Math.max(0.01, spread) / 3;

    if (Math.abs(gap) < 0.05 && !pathLinear) return null; // nothing to show

    const freshMs = reference.spotFreshnessMs ?? Infinity;
    const checks = [
      check("model_market_gap", Math.abs(gap) >= 0.05,
        `model (spot $${reference.spot!.toLocaleString()}, ${(reference.realizedVolDaily! * 100).toFixed(1)}%/d vol, ${daysLeft.toFixed(1)}d) says ${(pNow * 100).toFixed(0)}% vs market ${(mid * 100).toFixed(0)}%`,
        Math.abs(gap), 0.05),
      check("curve_shape", modelCurvature > 0.01 || pathLinear === true,
        `model curve accelerates ${(modelCurvature * 100).toFixed(1)}c per half-life${pathLinear !== undefined ? `; recent market path ${pathLinear ? "IS ~linear (lagging)" : "already curves"}` : "; market path unknown (no history)"}`),
      check("reference_freshness", freshMs <= 5_000,
        `Coinbase spot ${(freshMs / 1000).toFixed(1)}s old (max 5s)`, freshMs / 1000, 5),
      check("model_assumptions", false,
        "curve holds spot and realized vol constant — a shape diagnostic, not fair value. Human review required."),
    ];

    return buildSignal({
      strategy: this.id,
      strategyLabel: this.label,
      market,
      direction: "NEUTRAL",
      score: 20 + 60 * ramp(rawScore, 0, 60),
      summary: `DEADLINE CURVATURE: model ${(pNow * 100).toFixed(0)}% vs market ${(mid * 100).toFixed(0)}% with ${daysLeft.toFixed(1)}d left — ${pathLinear ? "market path is ~linear while the model curve is convex" : "shape divergence near deadline"}`,
      checks,
      now,
      ttlMs: 15 * 60_000,
      meta: {
        signalType: "deadline_curvature",
        threshold: th.threshold,
        direction: th.direction,
        daysLeft,
        modelProbNow: pNow,
        modelProbHalf: pHalf,
        modelProbQuarter: pQuarter,
        modelCurvature,
        marketMid: mid,
        gap,
        pathLinear,
        spot: reference.spot,
        volDaily: reference.realizedVolDaily,
      },
    });
  },
};
