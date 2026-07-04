// Strategy 8 — Reference-price signal (cross-venue).
// For crypto-threshold event markets, compares the venue's implied
// probability against what fresh Coinbase spot + realized volatility imply
// about reaching the threshold before close. Purely informational: direction
// is NEUTRAL, reference data can never execute anything, and stale reference
// data self-rejects the signal.

import type { SignalContext, SignalResult, SignalStrategy } from "@/lib/types";
import { parseCryptoThreshold } from "../crossvenue/threshold";
import { buildSignal, check, ramp } from "./helpers";

/** Φ(x) via Abramowitz–Stegun — good to ~1e-5, plenty for a rough estimate */
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}

export const referencePriceSignal: SignalStrategy = {
  id: "reference_price",
  label: "Reference Price",
  description:
    "Compares a crypto-threshold event market against fresh Coinbase spot + realized volatility. Informational only — reference data never executes.",

  run(ctx: SignalContext): SignalResult | null {
    const { market, reference, settings, now } = ctx;
    if (market.outcomeType !== "binary") return null;
    const th = parseCryptoThreshold(market.question, market.endDate);
    if (!th) return null;
    if (!reference?.spot) return null;

    const spot = reference.spot;
    const freshMs = reference.spotFreshnessMs ?? Infinity;
    const requiredMove = (th.threshold - spot) / spot; // signed
    const daysLeft = market.endDate
      ? Math.max(0.01, (new Date(market.endDate).getTime() - now) / 86_400_000)
      : undefined;
    const volDaily = reference.realizedVolDaily;

    // rough reachability under a drift-free normal walk (stated assumption)
    let modelProb: number | undefined;
    if (daysLeft !== undefined && volDaily !== undefined && volDaily > 0) {
      const z = requiredMove / (volDaily * Math.sqrt(daysLeft));
      const pAbove = 1 - normCdf(z);
      modelProb = th.direction === "above" ? pAbove : 1 - pAbove;
    }
    const implied = market.yesPrice;
    const gap =
      modelProb !== undefined && implied !== undefined ? implied - modelProb : undefined;

    const checks = [
      check(
        "reference_freshness",
        freshMs <= 5_000,
        `Coinbase spot is ${(freshMs / 1000).toFixed(1)}s old (max 5s for crypto-linked signals)`,
        freshMs / 1000,
        5,
      ),
      check(
        "threshold_parsed",
        true,
        `${th.asset} ${th.direction} $${th.threshold.toLocaleString()} — spot $${spot.toLocaleString()} (${(requiredMove * 100).toFixed(1)}% move required)`,
        Math.abs(requiredMove),
      ),
      check(
        "volatility_available",
        volDaily !== undefined,
        volDaily !== undefined
          ? `Realized vol ${(volDaily * 100).toFixed(2)}%/day over recent candles`
          : "No realized-volatility estimate — reachability not computed",
        volDaily,
      ),
      check(
        "model_assumptions",
        false,
        "Reachability uses a drift-free normal-walk approximation — a rough gauge, not a fair value. Human review required.",
      ),
      check(
        "liquidity_floor",
        market.liquidity >= settings.minLiquidityUsd,
        `Liquidity $${Math.round(market.liquidity).toLocaleString()} vs min $${settings.minLiquidityUsd.toLocaleString()}`,
        market.liquidity,
        settings.minLiquidityUsd,
      ),
    ];

    const score =
      30 +
      40 * ramp(Math.abs(gap ?? 0), 0.05, 0.3) +
      30 * ramp(1 - Math.min(1, freshMs / 5_000), 0, 1);

    return buildSignal({
      strategy: this.id,
      strategyLabel: this.label,
      market,
      direction: "NEUTRAL",
      score,
      summary:
        `${th.asset} spot $${spot.toLocaleString()} vs threshold $${th.threshold.toLocaleString()} (${(requiredMove * 100).toFixed(1)}% ${requiredMove >= 0 ? "up" : "down"} needed` +
        (daysLeft !== undefined ? `, ${daysLeft.toFixed(1)}d left` : "") +
        `)${gap !== undefined ? ` — market ${(100 * (implied ?? 0)).toFixed(0)}% vs walk-model ${(100 * (modelProb ?? 0)).toFixed(0)}%` : ""}`,
      checks,
      now,
      ttlMs: 5 * 60_000,
      meta: {
        asset: th.asset,
        threshold: th.threshold,
        direction: th.direction,
        spot,
        spotSource: reference.spotSource,
        spotFreshnessMs: freshMs,
        requiredMovePct: requiredMove,
        daysLeft,
        realizedVolDaily: volDaily,
        walkModelProb: modelProb,
        impliedProb: implied,
        gap,
      },
    });
  },
};
