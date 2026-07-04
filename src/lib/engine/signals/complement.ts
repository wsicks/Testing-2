// Strategy 3 — Complement probability check.
// For binary YES/NO markets, checks whether implied prices create an abnormal
// sum after fees and slippage. Surfaces the anomaly for review; execution is
// only possible after the risk engine independently approves a trade.

import type { SignalContext, SignalResult, SignalStrategy } from "@/lib/types";
import { buildSignal, check, ramp } from "./helpers";

export const complementSignal: SignalStrategy = {
  id: "complement_check",
  label: "Complement Probability",
  description:
    "Checks YES+NO implied price sum against 1.00 after fees and slippage. Flags abnormal sums for review — never executes on its own.",

  run(ctx: SignalContext): SignalResult | null {
    const { market, settings, now } = ctx;
    if (market.yesPrice === undefined || market.noPrice === undefined) return null;
    if (market.outcomes.length !== 2) return null;

    const sum = market.yesPrice + market.noPrice;
    const deviation = sum - 1;
    const costBuffer =
      settings.feeRateBps / 10_000 +
      settings.slippageBps / 10_000 +
      (market.spread ?? 0.01);
    const abnormal = Math.abs(deviation) > costBuffer;
    if (!abnormal) return null; // normal pricing — nothing to report

    const checks = [
      check(
        "abnormal_sum",
        true,
        `YES ${(market.yesPrice * 100).toFixed(1)}c + NO ${(market.noPrice * 100).toFixed(1)}c = ${(sum * 100).toFixed(1)}c (deviation ${(deviation * 100).toFixed(1)}c vs cost buffer ${(costBuffer * 100).toFixed(1)}c)`,
        Math.abs(deviation),
        costBuffer,
      ),
      check(
        "liquidity_floor",
        market.liquidity >= settings.minLiquidityUsd,
        `Liquidity $${Math.round(market.liquidity).toLocaleString()} vs min $${settings.minLiquidityUsd.toLocaleString()}`,
        market.liquidity,
        settings.minLiquidityUsd,
      ),
      check(
        "spread_sane",
        (market.spread ?? 1) <= settings.maxSpread,
        `Spread ${((market.spread ?? 1) * 100).toFixed(1)}c vs max ${(settings.maxSpread * 100).toFixed(1)}c — wide spreads fake complement anomalies`,
        market.spread,
        settings.maxSpread,
      ),
      check(
        "risk_engine_approval",
        false,
        "Execution requires an independent risk-engine approval — this signal only surfaces the anomaly.",
      ),
    ];

    // sum > 1: outcomes collectively overpriced (sell-side anomaly);
    // sum < 1: collectively underpriced (buy-side anomaly).
    const excess = Math.abs(deviation) - costBuffer;
    const score = 40 + 60 * ramp(excess, 0, 0.05);

    return buildSignal({
      strategy: this.id,
      strategyLabel: this.label,
      market,
      direction: "NEUTRAL",
      score,
      summary: `YES+NO = ${(sum * 100).toFixed(1)}c, ${(Math.abs(excess) * 100).toFixed(1)}c beyond cost buffer — ${deviation > 0 ? "overpriced" : "underpriced"} pair, review required`,
      checks,
      now,
      ttlMs: 5 * 60_000,
      meta: { sum, deviation, costBuffer, excess },
    });
  },
};
