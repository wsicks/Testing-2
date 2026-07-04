// Derived series helpers: OHLC candles from sparse price points (Polymarket
// price history, Kalshi trade tape) and realized volatility from candles.

import type { NormalizedCandle, PricePoint } from "@/lib/types";

/** bucket a sorted point series into OHLC candles (gaps are skipped) */
export function pointsToCandles(
  points: PricePoint[],
  resolutionSec: number,
): NormalizedCandle[] {
  if (!points.length) return [];
  const buckets = new Map<number, NormalizedCandle>();
  for (const p of points) {
    const t = Math.floor(p.t / resolutionSec) * resolutionSec;
    const b = buckets.get(t);
    if (!b) {
      buckets.set(t, { t, o: p.p, h: p.p, l: p.p, c: p.p, v: 0 });
    } else {
      b.h = Math.max(b.h, p.p);
      b.l = Math.min(b.l, p.p);
      b.c = p.p;
    }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

/**
 * Daily realized volatility from candles: std-dev of per-bar log returns,
 * scaled by √(bars per day).
 */
export function realizedVolDaily(candles: NormalizedCandle[]): number | undefined {
  if (candles.length < 12) return undefined;
  const rets: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i - 1].c > 0 && candles[i].c > 0) {
      rets.push(Math.log(candles[i].c / candles[i - 1].c));
    }
  }
  if (rets.length < 10) return undefined;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varc = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  const barSec = candles[1].t - candles[0].t;
  const barsPerDay = barSec > 0 ? 86_400 / barSec : 24;
  return Math.sqrt(varc) * Math.sqrt(barsPerDay);
}
