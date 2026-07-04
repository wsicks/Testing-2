// Volatility/trend regime classifier for a probability series.
//
//   calm     — low bar-to-bar volatility, negligible drift → mean-reversion OK
//   trending — persistent drift dominates noise → momentum OK
//   chaotic  — high volatility without persistent drift → stand aside
//
// The autopilot policy uses this to gate which strategy styles may act.

import type { PricePoint } from "@/lib/types";

export type Regime = "calm" | "trending" | "chaotic" | "unknown";

export interface RegimeResult {
  regime: Regime;
  /** std-dev of bar-to-bar changes */
  volatility: number;
  /** net drift over the window, price units */
  drift: number;
  /** |drift| / (vol · √bars): trend persistence à la t-statistic */
  trendStrength: number;
  bars: number;
}

export function classifyRegime(series: PricePoint[], window = 48): RegimeResult {
  const ys = series.slice(-window).map((s) => s.p);
  if (ys.length < 12) {
    return { regime: "unknown", volatility: 0, drift: 0, trendStrength: 0, bars: ys.length };
  }
  const diffs: number[] = [];
  for (let i = 1; i < ys.length; i++) diffs.push(ys[i] - ys[i - 1]);
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const varc =
    diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, diffs.length - 1);
  const vol = Math.sqrt(varc);
  const drift = ys[ys.length - 1] - ys[0];
  // zero-noise drift is a perfect trend, not a calm market
  const trendStrength =
    vol > 1e-9
      ? Math.abs(drift) / (vol * Math.sqrt(diffs.length))
      : Math.abs(drift) > 0.01
        ? 10
        : 0;

  let regime: Regime;
  if (vol < 0.004 && trendStrength < 1) regime = "calm";
  else if (trendStrength >= 1.5) regime = "trending";
  else if (vol >= 0.015) regime = "chaotic";
  else regime = "calm";

  return { regime, volatility: vol, drift, trendStrength, bars: ys.length };
}

/** which regimes each strategy style is allowed to trade in */
export const STRATEGY_REGIME_FIT: Record<string, Regime[]> = {
  dislocation: ["calm"], // mean reversion needs a stable anchor
  microstructure: ["calm", "trending"], // flow-following, short horizon
  price_movement: ["trending"], // momentum wants persistence
  liquidity_spread: ["calm", "trending", "chaotic"], // informational
  complement_check: ["calm", "trending"],
  cross_market: ["calm", "trending", "chaotic"],
  closing_soon: ["calm", "trending", "chaotic"],
};

export function regimeAllows(strategy: string, regime: Regime): boolean {
  if (regime === "unknown") return false;
  const fit = STRATEGY_REGIME_FIT[strategy];
  return fit ? fit.includes(regime) : true;
}
