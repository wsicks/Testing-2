// Strategy 5 — Closing-soon scanner.
// Finds markets near resolution and highlights liquidity, spread, remaining
// uncertainty and settlement risk. Informational: direction is always NEUTRAL.

import type { SignalContext, SignalResult, SignalStrategy } from "@/lib/types";
import { buildSignal, check, ramp } from "./helpers";

export function resolutionClarity(description: string | undefined): {
  level: "low" | "medium" | "high";
  reason: string;
} {
  if (!description || description.length < 80) {
    return { level: "low", reason: "Resolution text missing or very short" };
  }
  const d = description.toLowerCase();
  const hasRule = d.includes("resolve to") || d.includes("will resolve");
  const hasSource =
    d.includes("resolution source") || d.includes("official") || d.includes("according to");
  const hedged =
    d.includes("50-50") || d.includes("discretion") || d.includes("ambigu");
  if (hasRule && hasSource && !hedged)
    return { level: "high", reason: "Explicit rule and resolution source stated" };
  if (hasRule)
    return {
      level: "medium",
      reason: hedged ? "Rule stated but includes hedge/discretion language" : "Rule stated, source unclear",
    };
  return { level: "low", reason: "No explicit resolution rule found" };
}

export const closingSoonSignal: SignalStrategy = {
  id: "closing_soon",
  label: "Closing Soon",
  description:
    "Surfaces markets near resolution with liquidity, spread, uncertainty and settlement-risk context.",

  run(ctx: SignalContext): SignalResult | null {
    const { market, settings, now } = ctx;
    if (!market.endDate) return null;
    const msLeft = new Date(market.endDate).getTime() - now;
    const hoursLeft = msLeft / 3_600_000;
    if (hoursLeft <= 0 || hoursLeft > settings.closingSoonHours) return null;

    const mid = market.midpoint ?? market.yesPrice ?? 0.5;
    // 0 at the boundaries, 1 at 50c — how unresolved the market still is
    const uncertainty = 1 - Math.abs(mid - 0.5) * 2;
    const clarity = resolutionClarity(market.description);

    const checks = [
      check(
        "closing_window",
        true,
        `Closes in ${hoursLeft.toFixed(1)}h (window ${settings.closingSoonHours}h)`,
        hoursLeft,
        settings.closingSoonHours,
      ),
      check(
        "liquidity_floor",
        market.liquidity >= settings.minLiquidityUsd,
        `Liquidity $${Math.round(market.liquidity).toLocaleString()} vs min $${settings.minLiquidityUsd.toLocaleString()} — exits get harder near close`,
        market.liquidity,
        settings.minLiquidityUsd,
      ),
      check(
        "spread_sane",
        (market.spread ?? 1) <= settings.maxSpread,
        `Spread ${((market.spread ?? 1) * 100).toFixed(1)}c vs max ${(settings.maxSpread * 100).toFixed(1)}c`,
        market.spread,
        settings.maxSpread,
      ),
      check(
        "settlement_clarity",
        clarity.level !== "low",
        `Resolution clarity: ${clarity.level.toUpperCase()} — ${clarity.reason}`,
      ),
    ];

    const score =
      40 * ramp(hoursLeft, settings.closingSoonHours, 1) +
      35 * uncertainty +
      25 * ramp(Math.log10(Math.max(1, market.volume24h)), 3, 6);

    return buildSignal({
      strategy: this.id,
      strategyLabel: this.label,
      market,
      direction: "NEUTRAL",
      score,
      summary: `Closes in ${hoursLeft.toFixed(1)}h at ${(mid * 100).toFixed(0)}c — uncertainty ${(uncertainty * 100).toFixed(0)}%, clarity ${clarity.level}`,
      checks,
      now,
      ttlMs: 30 * 60_000,
      meta: { hoursLeft, uncertainty, clarity: clarity.level },
    });
  },
};
