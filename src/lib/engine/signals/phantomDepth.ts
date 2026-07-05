// Strategy 17 — Phantom Depth.
//
// Depth that retreats when approached was never depth. Diffing two
// consecutive book snapshots against the trade tape between them separates
// the two honest explanations for vanished near-touch liquidity — it traded
// (prints account for it) or it was pulled — and only the UNEXPLAINED share
// counts as phantom. High phantom share means the displayed book overstates
// what a taker could actually get: every depth-gated strategy in this app
// is implicitly trusting numbers this screen distrusts.
//
// NEUTRAL, review-gated, and honest about its resolution: with ~30s between
// snapshots this detects PERSISTENT flicker, not HFT-grade spoofing — the
// check text says so.

import type { BookLevel, OrderBookData, RecentTrade, SignalContext, SignalResult, SignalStrategy } from "@/lib/types";
import { buildSignal, check, ramp } from "./helpers";

const NEAR_TOUCH = 0.03; // levels within 3c of the touch
const MIN_PREV_USD = 300; // ignore books that never showed real size

interface VanishResult {
  prevNearUsd: number;
  vanishedUsd: number;
  tradedUsd: number;
  phantomUsd: number;
  phantomShare: number;
}

/** USD near the touch on `side` of a snapshot */
function nearTouchUsd(levels: BookLevel[], touch: number | undefined, side: "bid" | "ask"): Map<number, number> {
  const out = new Map<number, number>();
  if (touch === undefined) return out;
  for (const l of levels) {
    const within = side === "bid" ? touch - l.price <= NEAR_TOUCH : l.price - touch <= NEAR_TOUCH;
    if (within) out.set(l.price, l.price * l.size);
  }
  return out;
}

/**
 * vanished near-touch notional between two snapshots, minus what the tape
 * explains. Price levels that IMPROVED (still present at equal/greater size)
 * are not vanished; levels the mid moved through are excluded (they were
 * consumed by definition of the move).
 */
export function phantomAnalysis(
  prev: OrderBookData,
  cur: OrderBookData,
  tape: RecentTrade[],
): VanishResult | null {
  if (prev.bestBid === undefined || prev.bestAsk === undefined) return null;
  const tradedUsd = tape
    .filter((t) => t.ts >= prev.ts && t.ts <= cur.ts)
    .reduce((a, t) => a + t.price * t.size, 0);

  let prevNearUsd = 0;
  let vanishedUsd = 0;
  for (const side of ["bid", "ask"] as const) {
    const prevLevels = nearTouchUsd(side === "bid" ? prev.bids : prev.asks, side === "bid" ? prev.bestBid : prev.bestAsk, side);
    const curLevels = new Map(
      (side === "bid" ? cur.bids : cur.asks).map((l) => [l.price, l.price * l.size]),
    );
    for (const [price, usd] of prevLevels) {
      prevNearUsd += usd;
      // if the touch moved THROUGH this level, the market consumed it — not phantom
      const sweptThrough =
        side === "bid"
          ? cur.bestBid !== undefined && cur.bestBid < price
          : cur.bestAsk !== undefined && cur.bestAsk > price;
      const remaining = curLevels.get(price) ?? 0;
      const gone = Math.max(0, usd - remaining);
      if (!sweptThrough) vanishedUsd += gone;
    }
  }
  if (prevNearUsd < MIN_PREV_USD) return null;
  const phantomUsd = Math.max(0, vanishedUsd - tradedUsd);
  return {
    prevNearUsd,
    vanishedUsd,
    tradedUsd,
    phantomUsd,
    phantomShare: phantomUsd / prevNearUsd,
  };
}

export const phantomDepthSignal: SignalStrategy = {
  id: "phantom_depth",
  label: "Phantom Depth",
  description:
    "Diffs consecutive book snapshots against the tape: near-touch liquidity that vanished without trading was never available. Protective screen — discounts displayed depth, never trades.",

  run(ctx: SignalContext): SignalResult | null {
    const { market, book, prevBook, trades, now } = ctx;
    if (market.outcomeType !== "binary" || !book || !prevBook) return null;
    const gapMs = book.ts - prevBook.ts;
    if (gapMs < 10_000 || gapMs > 5 * 60_000) return null; // need adjacent scans
    const res = phantomAnalysis(prevBook, book, trades ?? []);
    if (!res || res.phantomShare < 0.5) return null;

    return buildSignal({
      strategy: this.id,
      strategyLabel: this.label,
      market,
      direction: "NEUTRAL",
      score: 25 + 55 * ramp(res.phantomShare, 0.5, 1),
      summary: `PHANTOM DEPTH: $${Math.round(res.phantomUsd)} of $${Math.round(res.prevNearUsd)} near-touch liquidity vanished in ${(gapMs / 1000).toFixed(0)}s with only $${Math.round(res.tradedUsd)} printed — ${(res.phantomShare * 100).toFixed(0)}% of the displayed book was not available to trade against`,
      checks: [
        check("phantom_share", true,
          `vanished $${Math.round(res.vanishedUsd)} − printed $${Math.round(res.tradedUsd)} = $${Math.round(res.phantomUsd)} unexplained (${(res.phantomShare * 100).toFixed(0)}% of prior near-touch depth)`,
          res.phantomShare, 0.5),
        check("resolution_caveat", false,
          `snapshots ${(gapMs / 1000).toFixed(0)}s apart detect PERSISTENT flicker, not HFT-grade spoofing — protective screen: depth-gated strategies should distrust this book`),
      ],
      now,
      ttlMs: 5 * 60_000,
      meta: {
        signalType: "phantom_depth",
        ...res,
        snapshotGapMs: gapMs,
        effectiveDepthUsd: Math.round(res.prevNearUsd - res.phantomUsd),
      },
    });
  },
};
