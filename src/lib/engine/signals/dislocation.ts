// Strategy 6 — Kalman fair-value dislocation.
// Filters the market's own price series into a latent fair-value estimate and
// flags prints that sit several innovation-sigmas away from it. Direction is
// mean-reverting: price rich vs fair value → BUY_NO, cheap → BUY_YES. The
// filtered fair value doubles as the win-probability estimate handed to the
// risk engine, so sizing is model-driven rather than asserted.

import type { SignalContext, SignalResult, SignalStrategy } from "@/lib/types";
import { kalmanFilter } from "../micro/kalman";
import { classifyRegime } from "../micro/regime";
import { buildSignal, check, ramp } from "./helpers";

const Z_ENTRY = 2.0;

export const dislocationSignal: SignalStrategy = {
  id: "dislocation",
  label: "Fair-Value Dislocation",
  description:
    "Kalman-filters the price series into a fair-value estimate and flags prints >2σ from it. Mean-reversion logic — only valid in calm regimes.",

  run(ctx: SignalContext): SignalResult | null {
    const { market, history, settings, now } = ctx;
    if (!history || history.length < 12) return null;
    const kf = kalmanFilter(history);
    if (!kf) return null;

    const price = market.midpoint ?? market.yesPrice ?? history[history.length - 1].p;
    // dislocation of the CURRENT market price vs filtered fair value,
    // normalized by the filter's innovation scale
    const sigma = Math.sqrt(kf.rUsed);
    const z = sigma > 0 ? (price - kf.fairValue) / sigma : 0;
    if (Math.abs(z) < Z_ENTRY) return null;

    const regime = classifyRegime(history);
    const spread = market.spread ?? 0.02;
    // dislocation must clear round-trip costs to be actionable
    const dislocationC = Math.abs(price - kf.fairValue);
    const costBuffer = spread + settings.feeRateBps / 10_000 + settings.slippageBps / 10_000;

    const checks = [
      check(
        "dislocation_sigma",
        Math.abs(z) >= Z_ENTRY,
        `Price ${(price * 100).toFixed(1)}c vs fair ${(kf.fairValue * 100).toFixed(1)}c → z = ${z.toFixed(2)} (entry ±${Z_ENTRY})`,
        Math.abs(z),
        Z_ENTRY,
      ),
      check(
        "clears_costs",
        dislocationC > costBuffer,
        `Dislocation ${(dislocationC * 100).toFixed(1)}c vs cost buffer ${(costBuffer * 100).toFixed(1)}c (spread + fees + slippage)`,
        dislocationC,
        costBuffer,
      ),
      check(
        "calm_regime",
        regime.regime === "calm",
        `Regime ${regime.regime.toUpperCase()} (vol ${(regime.volatility * 100).toFixed(2)}c/bar, trend strength ${regime.trendStrength.toFixed(2)}) — mean reversion needs a stable anchor`,
        regime.trendStrength,
      ),
      check(
        "liquidity_floor",
        market.liquidity >= settings.minLiquidityUsd,
        `Liquidity $${Math.round(market.liquidity).toLocaleString()} vs min $${settings.minLiquidityUsd.toLocaleString()}`,
        market.liquidity,
        settings.minLiquidityUsd,
      ),
      check(
        "not_boundary",
        price > 0.05 && price < 0.95 && kf.fairValue > 0.05 && kf.fairValue < 0.95,
        `Price and fair value inside the 5–95c band`,
        price,
      ),
    ];

    // rich → fade with NO; cheap → take YES
    const direction = z > 0 ? "BUY_NO" : "BUY_YES";
    const score =
      45 * ramp(Math.abs(z), Z_ENTRY, 4.5) +
      35 * ramp(dislocationC - costBuffer, 0, 0.05) +
      20 * (regime.regime === "calm" ? 1 : 0);

    return buildSignal({
      strategy: this.id,
      strategyLabel: this.label,
      market,
      direction,
      score,
      summary: `Price ${(price * 100).toFixed(1)}c is ${z > 0 ? "rich" : "cheap"} vs Kalman fair ${(kf.fairValue * 100).toFixed(1)}c (z ${z.toFixed(2)}, regime ${regime.regime})`,
      checks,
      now,
      ttlMs: 10 * 60_000,
      meta: {
        fairValue: kf.fairValue,
        zScore: z,
        dislocation: dislocationC,
        costBuffer,
        regime: regime.regime,
        volatility: regime.volatility,
        // win-probability estimate for the risk engine: the model's fair value
        // for the side being bought
        modelWinProb: direction === "BUY_YES" ? kf.fairValue : 1 - kf.fairValue,
      },
    });
  },
};
