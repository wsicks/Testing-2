// Strategy 2 — Price movement signal.
// Tracks large short-term probability moves and reports velocity, volatility
// and mean-reversion risk. Direction follows momentum only when volume
// supports the move; otherwise the signal stays NEUTRAL.

import type { SignalContext, SignalResult, SignalStrategy } from "@/lib/types";
import { buildSignal, check, diffVolatility, ramp } from "./helpers";

const MOVE_1H_MIN = 0.03;
const MOVE_24H_MIN = 0.08;

export const priceMovementSignal: SignalStrategy = {
  id: "price_movement",
  label: "Price Movement",
  description:
    "Flags large short-term probability moves with velocity, volatility and mean-reversion risk context.",

  run(ctx: SignalContext): SignalResult | null {
    const { market, history, settings, now } = ctx;
    // probability-move logic only exists for binary outcome tokens — on an
    // asset row (Coinbase spot) a "0.09 move" is 9 DOLLARS-ish, not 9 points
    if (market.outcomeType !== "binary") return null;
    const move1h = market.oneHourPriceChange ?? 0;
    const move24h = market.oneDayPriceChange ?? 0;
    if (market.oneHourPriceChange === undefined && market.oneDayPriceChange === undefined)
      return null;

    const bigMove =
      Math.abs(move1h) >= MOVE_1H_MIN || Math.abs(move24h) >= MOVE_24H_MIN;
    if (!bigMove) return null; // nothing noteworthy — no signal at all

    const prices = (history ?? []).map((p) => p.p);
    const vol = diffVolatility(prices);
    const velocity = Math.abs(move1h); // price units per hour
    const volumeSupport = market.volume24h >= 10_000;
    const mid = market.midpoint ?? market.yesPrice ?? 0.5;
    const nearBoundary = mid < 0.05 || mid > 0.95;
    // large move + weak volume + high bar-to-bar volatility ⇒ likely to revert
    const meanReversionRisk =
      (volumeSupport ? 0 : 0.4) +
      0.4 * ramp(vol, 0.005, 0.05) +
      0.2 * ramp(Math.abs(move1h), 0.03, 0.15);

    const checks = [
      check(
        "significant_move",
        true,
        `Δ1h ${(move1h * 100).toFixed(1)}c, Δ24h ${(move24h * 100).toFixed(1)}c`,
        Math.abs(move24h),
        MOVE_24H_MIN,
      ),
      check(
        "volume_support",
        volumeSupport,
        `24h volume $${Math.round(market.volume24h).toLocaleString()} ${volumeSupport ? "supports" : "does NOT support"} the move (min $10,000)`,
        market.volume24h,
        10_000,
      ),
      check(
        "not_boundary",
        !nearBoundary,
        nearBoundary
          ? `Price ${(mid * 100).toFixed(1)}c is near a boundary — moves there are low-information`
          : `Price ${(mid * 100).toFixed(1)}c is inside the tradable band`,
        mid,
      ),
      check(
        "mean_reversion_risk",
        meanReversionRisk < 0.6,
        `Mean-reversion risk ${(meanReversionRisk * 100).toFixed(0)}% (volatility ${vol.toFixed(4)}, velocity ${(velocity * 100).toFixed(1)}c/h)`,
        meanReversionRisk,
        0.6,
      ),
      check(
        "liquidity_floor",
        market.liquidity >= settings.minLiquidityUsd,
        `Liquidity $${Math.round(market.liquidity).toLocaleString()} vs min $${settings.minLiquidityUsd.toLocaleString()}`,
        market.liquidity,
        settings.minLiquidityUsd,
      ),
    ];

    const dominantMove = Math.abs(move1h) >= MOVE_1H_MIN ? move1h : move24h;
    const direction =
      meanReversionRisk >= 0.6 || !volumeSupport
        ? "NEUTRAL"
        : dominantMove > 0
          ? "BUY_YES"
          : "BUY_NO";

    const score =
      50 * ramp(Math.abs(move24h), MOVE_24H_MIN, 0.25) +
      25 * ramp(Math.abs(move1h), MOVE_1H_MIN, 0.12) +
      25 * (1 - meanReversionRisk);

    return buildSignal({
      strategy: this.id,
      strategyLabel: this.label,
      market,
      direction,
      score,
      summary: `Move Δ24h ${(move24h * 100).toFixed(1)}c (Δ1h ${(move1h * 100).toFixed(1)}c), MR risk ${(meanReversionRisk * 100).toFixed(0)}%`,
      checks,
      now,
      ttlMs: 10 * 60_000,
      meta: { move1h, move24h, velocity, volatility: vol, meanReversionRisk },
    });
  },
};
