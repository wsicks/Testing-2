// 1-D Kalman filter over a market's probability series.
//
// Model: latent fair probability x follows a random walk with process noise Q;
// observed prices y = x + measurement noise R. The filter yields a smoothed
// fair-value estimate and — more usefully — a normalized innovation (z-score)
// that measures how far the latest print sits from where the filtered state
// says it "should" be. Large |z| = dislocation; the sign says which way.

import type { PricePoint } from "@/lib/types";

export interface KalmanState {
  /** filtered fair-value estimate */
  x: number;
  /** state variance */
  p: number;
}

export interface KalmanResult {
  /** filtered fair value after the last observation */
  fairValue: number;
  /** last innovation (observation - prediction) */
  innovation: number;
  /** innovation normalized by its predicted std-dev */
  zScore: number;
  /** filtered series (same length as input) */
  filtered: number[];
  /** stationary-ish measurement noise estimate used */
  rUsed: number;
}

/**
 * Run the filter over a price series. Q and R default to values suited to
 * 30-minute prediction-market bars; R is floored by the series' own bar-to-bar
 * variance so the filter self-scales to each market's noise level.
 */
export function kalmanFilter(
  series: PricePoint[],
  opts: { q?: number; r?: number } = {},
): KalmanResult | null {
  const ys = series.map((s) => s.p).filter((p) => Number.isFinite(p));
  if (ys.length < 8) return null;

  // empirical bar noise → measurement variance floor
  let sum = 0;
  let sum2 = 0;
  for (let i = 1; i < ys.length; i++) {
    const d = ys[i] - ys[i - 1];
    sum += d;
    sum2 += d * d;
  }
  const n = ys.length - 1;
  const empVar = Math.max(1e-6, sum2 / n - (sum / n) ** 2);

  const q = opts.q ?? empVar * 0.15; // slow-moving latent state
  const r = opts.r ?? empVar * 0.85; // most bar noise is measurement noise

  let x = ys[0];
  let p = r;
  const filtered: number[] = [x];
  let innovation = 0;
  let z = 0;

  for (let i = 1; i < ys.length; i++) {
    // predict
    const xPred = x;
    const pPred = p + q;
    // update
    const s = pPred + r; // innovation variance
    innovation = ys[i] - xPred;
    z = innovation / Math.sqrt(s);
    const k = pPred / s;
    x = xPred + k * innovation;
    p = (1 - k) * pPred;
    filtered.push(x);
  }

  return {
    fairValue: clamp01(x),
    innovation,
    zScore: z,
    filtered,
    rUsed: r,
  };
}

function clamp01(v: number): number {
  return Math.min(0.999, Math.max(0.001, v));
}
