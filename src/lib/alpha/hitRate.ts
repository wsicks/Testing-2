// Measured per-strategy hit rates from the outcome archive — the honest
// answer to "what is this strategy's win rate?".
//
// A "win" is a captured 1h direction-adjusted drift > 0; a "net win" clears
// that row's own friction estimate (half its spread at signal time + 50bps
// slippage). The Wilson lower bound is the number the governor trusts: with
// 12 wins in 20 samples the point estimate says 60% but the 95% floor says
// ~39% — small samples never get credit for a win rate they haven't proven.

import type { AlphaOutcome } from "./types";

export interface StrategyHitRate {
  strategy: string;
  /** outcomes with a captured 1h drift */
  n: number;
  wins: number;
  /** wins / n — the point estimate */
  hitRate: number;
  /** 95% Wilson lower bound — the proven floor of the hit rate */
  wilsonLo: number;
  /** wins clearing the row's own friction (half-spread + 50bps) */
  netWins: number;
  netHitRate: number;
  avgDrift1h: number;
}

/** Wilson score interval lower bound (z=1.96 ⇒ 95%) */
export function wilsonLower(wins: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (center - margin) / denom);
}

const SLIPPAGE_EST = 0.005;

export function strategyHitRates(outcomes: AlphaOutcome[]): StrategyHitRate[] {
  const acc = new Map<
    string,
    { n: number; wins: number; netWins: number; driftSum: number }
  >();
  for (const o of outcomes) {
    const d = o.buckets.b1h?.drift;
    if (d === undefined) continue;
    const a = acc.get(o.featureId) ?? { n: 0, wins: 0, netWins: 0, driftSum: 0 };
    a.n += 1;
    a.driftSum += d;
    if (d > 0) a.wins += 1;
    const friction = (o.spreadAtSignal ?? 0.02) / 2 + SLIPPAGE_EST;
    if (d > friction) a.netWins += 1;
    acc.set(o.featureId, a);
  }
  return [...acc.entries()]
    .map(([strategy, a]) => ({
      strategy,
      n: a.n,
      wins: a.wins,
      hitRate: a.n > 0 ? a.wins / a.n : 0,
      wilsonLo: Number(wilsonLower(a.wins, a.n).toFixed(4)),
      netWins: a.netWins,
      netHitRate: a.n > 0 ? a.netWins / a.n : 0,
      avgDrift1h: a.n > 0 ? Number((a.driftSum / a.n).toFixed(4)) : 0,
    }))
    .sort((x, y) => y.wilsonLo - x.wilsonLo || y.n - x.n);
}
