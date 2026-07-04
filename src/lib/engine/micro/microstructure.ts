// Order-book & tape microstructure metrics.
//
// - micro-price (Stoikov): size-weighted top-of-book price; where the book
//   "leans". Divergence from mid is a short-horizon directional pressure read.
// - book imbalance: (bid depth − ask depth) / total within a band of mid.
// - tape imbalance: signed aggressor volume over the recent public trades.
// All pure functions; unit-tested offline.

import type { OrderBookData, RecentTrade } from "@/lib/types";

export interface MicroMetrics {
  microPrice: number;
  mid: number;
  /** microPrice − mid, price units; positive = buy pressure */
  microDivergence: number;
  /** −1..1 within `band` of mid; positive = bid-heavy book */
  bookImbalance: number;
  /** −1..1; positive = aggressive buyers dominated the tape */
  tapeImbalance: number;
  tapeVolumeUsd: number;
  tradesUsed: number;
  /** composite −1..1 pressure score */
  pressure: number;
}

export function microPrice(book: OrderBookData): number | undefined {
  const bb = book.bids[0];
  const ba = book.asks[0];
  if (!bb || !ba) return undefined;
  const total = bb.size + ba.size;
  if (total <= 0) return undefined;
  // heavier bid size pushes the micro-price toward the ask (buy pressure)
  return (bb.price * ba.size + ba.price * bb.size) / total;
}

export function bookImbalance(book: OrderBookData, band = 0.05): number {
  const mid = book.midpoint;
  if (mid === undefined) return 0;
  let bid = 0;
  let ask = 0;
  for (const l of book.bids) if (mid - l.price <= band) bid += l.price * l.size;
  for (const l of book.asks) if (l.price - mid <= band) ask += l.price * l.size;
  const total = bid + ask;
  return total > 0 ? (bid - ask) / total : 0;
}

export function tapeImbalance(
  trades: RecentTrade[],
  windowMs = 60 * 60_000,
  now = Date.now(),
): { imbalance: number; volumeUsd: number; used: number } {
  let buy = 0;
  let sell = 0;
  let used = 0;
  for (const t of trades) {
    if (now - t.ts > windowMs) continue;
    const usd = t.price * t.size;
    // normalize aggressor direction to the YES token: a BUY of "No" is
    // equivalent selling pressure on YES
    const isYesBuy =
      (t.side === "BUY" && t.outcome !== "No") ||
      (t.side === "SELL" && t.outcome === "No");
    if (isYesBuy) buy += usd;
    else sell += usd;
    used += 1;
  }
  const total = buy + sell;
  return {
    imbalance: total > 0 ? (buy - sell) / total : 0,
    volumeUsd: total,
    used,
  };
}

export function computeMicroMetrics(
  book: OrderBookData,
  trades: RecentTrade[] = [],
  now = Date.now(),
): MicroMetrics | null {
  const mp = microPrice(book);
  const mid = book.midpoint;
  if (mp === undefined || mid === undefined) return null;
  const spread = Math.max(0.001, book.spread ?? 0.01);
  const imb = bookImbalance(book);
  const tape = tapeImbalance(trades, 60 * 60_000, now);
  const microDivergence = mp - mid;

  // composite: micro divergence scaled by spread, book lean, tape lean
  const pressure = clamp(
    0.45 * clamp(microDivergence / (spread / 2), -1, 1) +
      0.3 * imb +
      0.25 * tape.imbalance,
    -1,
    1,
  );

  return {
    microPrice: mp,
    mid,
    microDivergence,
    bookImbalance: imb,
    tapeImbalance: tape.imbalance,
    tapeVolumeUsd: tape.volumeUsd,
    tradesUsed: tape.used,
    pressure,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
