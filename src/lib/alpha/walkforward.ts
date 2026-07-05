// Purged walk-forward replay — the Alpha Foundry's BACKTEST stage.
//
// Point-in-time by construction: a replay rule receives ONLY bars up to the
// decision time. The timeline splits into sequential folds with a purge
// (embargo) gap of one horizon around each fold boundary so an outcome can
// never straddle folds and leak. Costs are charged on every simulated entry.
// Results report per-fold AND per-category performance plus two overfit
// tripwires from the spec: a single lucky trade or a single lucky market
// carrying the total.
//
// Only price-replayable features have rules here. Wallet/reference-driven
// strategies cannot be honestly replayed from price bars alone — they carry
// their burden through forward paper evidence instead, and the prosecutor
// knows the difference.

import type { PricePoint } from "@/lib/types";
import { kalmanFilter } from "../engine/micro/kalman";
import { classifyRegime } from "../engine/micro/regime";

export interface ReplayRule {
  featureId: string;
  label: string;
  minBars: number;
  /** decide at bar index i using ONLY bars[0..i] — never look ahead */
  decide(bars: PricePoint[]): "BUY_YES" | "BUY_NO" | null;
  assumptions: string[];
}

export interface ReplaySeries {
  marketId: string;
  category: string;
  bars: PricePoint[]; // oldest first
}

export interface FoldStat {
  fold: number;
  n: number;
  avgNet: number;
  winRate: number;
}

export interface WalkForwardResult {
  featureId: string;
  resolution: string;
  horizonBars: number;
  purgeBars: number;
  frictionC: number;
  outcomes: number;
  markets: number;
  avgNet: number;
  winRate: number;
  positiveFolds: number;
  folds: FoldStat[];
  categories: { category: string; n: number; avgNet: number }[];
  /** best single simulated trade's share of gross positive drift */
  luckyConcentration: number;
  /** best single market's share of gross positive drift */
  singleMarketShare: number;
  assumptions: string[];
  ranAt: number;
  isHistoricalSimulation: true;
}

interface SimTrade {
  marketId: string;
  category: string;
  t: number;
  net: number;
  fold: number;
}

export interface WalkForwardOptions {
  folds?: number;
  /** forward-return horizon in bars */
  horizonBars?: number;
  /** friction charged per simulated entry, in probability points */
  frictionC: number;
  resolution: string;
  ranAt: number;
}

export function walkForwardReplay(
  rule: ReplayRule,
  series: ReplaySeries[],
  opts: WalkForwardOptions,
): WalkForwardResult {
  const folds = opts.folds ?? 4;
  const horizon = opts.horizonBars ?? 6;
  const purge = horizon; // embargo one horizon around each fold boundary

  // fold boundaries over the union time range
  const allTs = series.flatMap((s) => s.bars.map((b) => b.t));
  const t0 = Math.min(...allTs, Infinity);
  const t1 = Math.max(...allTs, -Infinity);
  const span = Math.max(1, t1 - t0);
  const foldOf = (t: number) => Math.min(folds - 1, Math.floor(((t - t0) / span) * folds));

  const trades: SimTrade[] = [];
  for (const s of series) {
    const bars = s.bars;
    if (bars.length < rule.minBars + horizon + 1) continue;
    const barSecs = Math.max(1, (bars[bars.length - 1].t - bars[0].t) / Math.max(1, bars.length - 1));
    let cooldownUntil = -Infinity;
    for (let i = rule.minBars; i < bars.length - horizon; i++) {
      const t = bars[i].t;
      if (t < cooldownUntil) continue;
      const fold = foldOf(t);
      // purge: skip decisions whose horizon would cross a fold boundary
      const boundaryT = t0 + ((fold + 1) * span) / folds;
      if (boundaryT - t < purge * barSecs) continue;
      const dir = rule.decide(bars.slice(0, i + 1));
      if (!dir) continue;
      const raw = bars[i + horizon].p - bars[i].p;
      const drift = dir === "BUY_YES" ? raw : -raw;
      trades.push({
        marketId: s.marketId,
        category: s.category,
        t,
        net: drift - opts.frictionC,
        fold,
      });
      cooldownUntil = t + horizon * barSecs; // no overlapping outcomes per market
    }
  }

  const foldStats: FoldStat[] = [];
  for (let f = 0; f < folds; f++) {
    const rows = trades.filter((x) => x.fold === f);
    foldStats.push({
      fold: f,
      n: rows.length,
      avgNet: rows.length ? rows.reduce((a, b) => a + b.net, 0) / rows.length : 0,
      winRate: rows.length ? rows.filter((x) => x.net > 0).length / rows.length : 0,
    });
  }

  const byCat = new Map<string, SimTrade[]>();
  for (const x of trades) byCat.set(x.category, [...(byCat.get(x.category) ?? []), x]);
  const byMkt = new Map<string, number>();
  for (const x of trades) byMkt.set(x.marketId, (byMkt.get(x.marketId) ?? 0) + Math.max(0, x.net));

  const grossPositive = trades.reduce((a, b) => a + Math.max(0, b.net), 0);
  const bestTrade = Math.max(0, ...trades.map((x) => x.net));
  const bestMarket = Math.max(0, ...byMkt.values());

  return {
    featureId: rule.featureId,
    resolution: opts.resolution,
    horizonBars: horizon,
    purgeBars: purge,
    frictionC: opts.frictionC,
    outcomes: trades.length,
    markets: new Set(trades.map((x) => x.marketId)).size,
    avgNet: trades.length ? trades.reduce((a, b) => a + b.net, 0) / trades.length : 0,
    winRate: trades.length ? trades.filter((x) => x.net > 0).length / trades.length : 0,
    positiveFolds: foldStats.filter((f) => f.n >= 5 && f.avgNet > 0).length,
    folds: foldStats,
    categories: [...byCat.entries()]
      .map(([category, rows]) => ({
        category,
        n: rows.length,
        avgNet: rows.reduce((a, b) => a + b.net, 0) / rows.length,
      }))
      .sort((a, b) => b.n - a.n),
    luckyConcentration: grossPositive > 0 ? Math.min(1, bestTrade / grossPositive) : trades.length ? 1 : 0,
    singleMarketShare: grossPositive > 0 ? Math.min(1, bestMarket / grossPositive) : trades.length ? 1 : 0,
    assumptions: [
      `point-in-time replay over ${opts.resolution} bars — decisions see only prior bars`,
      `friction ${(opts.frictionC * 100).toFixed(1)}c charged per entry (half-spread + slippage estimate)`,
      `${folds} sequential folds, ${purge}-bar purge at boundaries, ${horizon}-bar cooldown per market`,
      ...rule.assumptions,
    ],
    ranAt: opts.ranAt,
    isHistoricalSimulation: true,
  };
}

// ── Replay rules for price-replayable features ───────────────────────────────

const KALMAN_WINDOW = 48;

export const REPLAY_RULES: Record<string, ReplayRule> = {
  dislocation: {
    featureId: "dislocation",
    label: "Kalman fair-value dislocation",
    minBars: 24,
    assumptions: [
      "replays the strategy's Kalman core on a rolling 48-bar window with the same 2σ entry and calm-regime gate; book depth/tape gates cannot be replayed from price bars and are omitted",
    ],
    decide(bars) {
      const window = bars.slice(-KALMAN_WINDOW);
      if (window.length < 12) return null;
      const kf = kalmanFilter(window);
      if (!kf) return null;
      const price = window[window.length - 1].p;
      const sigma = Math.sqrt(kf.rUsed);
      const z = sigma > 0 ? (price - kf.fairValue) / sigma : 0;
      if (Math.abs(z) < 2) return null;
      if (classifyRegime(window).regime !== "calm") return null;
      return z > 0 ? "BUY_NO" : "BUY_YES"; // mean reversion
    },
  },
  price_movement: {
    featureId: "price_movement",
    label: "Momentum continuation",
    minBars: 25,
    assumptions: [
      "momentum proxy: 24-bar price change ≥ 8c continues; the live strategy's volume-support gate cannot be replayed from price bars and is omitted (replay is HARDER to pass on noise, easier on illiquid drift — read per-category results)",
    ],
    decide(bars) {
      const last = bars[bars.length - 1].p;
      const prev = bars[bars.length - 25].p;
      const change = last - prev;
      if (Math.abs(change) < 0.08) return null;
      if (last <= 0.05 || last >= 0.95) return null; // boundary lottery guard
      return change > 0 ? "BUY_YES" : "BUY_NO";
    },
  },
};

export function replayableFeatures(): string[] {
  return Object.keys(REPLAY_RULES);
}
