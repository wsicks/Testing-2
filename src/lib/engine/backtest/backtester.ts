// Backtesting engine — bar-by-bar historical simulation over CLOB price
// history. Look-ahead is prevented structurally: the strategy sees only bars
// [0..i] and execution happens at bar i+1's price. All results are labeled
// HISTORICAL SIMULATION and include the full cost model in `assumptions`.

import type {
  BacktestConfig,
  BacktestResult,
  BacktestTrade,
  PricePoint,
} from "@/lib/types";

export type BarStrategy = (window: PricePoint[]) => -1 | 0 | 1;

const LOOKBACK = 12;

/** momentum: follow a sustained move over the lookback window */
export const momentumStrategy: BarStrategy = (window) => {
  if (window.length < LOOKBACK + 1) return 0;
  const now = window[window.length - 1].p;
  const then = window[window.length - 1 - LOOKBACK].p;
  const move = now - then;
  if (now < 0.05 || now > 0.95) return 0;
  if (move > 0.04) return 1;
  if (move < -0.04) return -1;
  return 0;
};

/** mean reversion: fade a sharp short-term spike */
export const meanReversionStrategy: BarStrategy = (window) => {
  if (window.length < LOOKBACK + 1) return 0;
  const now = window[window.length - 1].p;
  const short = window[window.length - 4]?.p ?? now;
  const jump = now - short;
  if (now < 0.08 || now > 0.92) return 0;
  if (jump > 0.06) return -1;
  if (jump < -0.06) return 1;
  return 0;
};

/** closing drift: follow price momentum toward a boundary late in the series */
export const closingDriftStrategy: BarStrategy = (window) => {
  if (window.length < LOOKBACK + 1) return 0;
  const now = window[window.length - 1].p;
  const then = window[window.length - 1 - LOOKBACK].p;
  if (now > 0.8 && now < 0.97 && now - then > 0.02) return 1;
  if (now < 0.2 && now > 0.03 && now - then < -0.02) return -1;
  return 0;
};

export const BACKTEST_STRATEGIES: Record<
  BacktestConfig["strategyId"],
  { label: string; fn: BarStrategy; note: string }
> = {
  momentum: {
    label: "Momentum",
    fn: momentumStrategy,
    note: "Enters in the direction of a >4c move over the lookback window.",
  },
  mean_reversion: {
    label: "Mean Reversion",
    fn: meanReversionStrategy,
    note: "Fades sharp >6c short-term spikes.",
  },
  closing_drift: {
    label: "Closing Drift",
    fn: closingDriftStrategy,
    note: "Follows drift toward a boundary above 80c / below 20c.",
  },
};

export interface SeriesInput {
  tokenId: string;
  marketTitle?: string;
  points: PricePoint[];
}

interface OpenTrade {
  tokenId: string;
  marketTitle?: string;
  dir: 1 | -1;
  entryTs: number;
  entryIdx: number;
  entryPrice: number; // cost-adjusted
  size: number; // shares
  stake: number; // USD at risk basis
}

export function runBacktest(
  config: BacktestConfig,
  series: SeriesInput[],
): BacktestResult {
  const strat = BACKTEST_STRATEGIES[config.strategyId];
  const halfSpread = config.spreadAssumption / 2;
  const slip = config.slippageBps / 10_000;
  const feeRate = config.feeRateBps / 10_000;

  const trades: BacktestTrade[] = [];
  let feesPaid = 0;

  // 1) generate trades per series with next-bar execution (no look-ahead)
  for (const s of series) {
    const pts = s.points.filter((p) => p.t >= config.from && p.t <= config.to);
    if (pts.length < LOOKBACK + 3) continue;
    let open: OpenTrade | null = null;

    for (let i = LOOKBACK; i < pts.length - 1; i++) {
      const windowBars = pts.slice(0, i + 1); // ONLY past + current bar
      const next = pts[i + 1]; // execution bar

      if (!open) {
        const dir = strat.fn(windowBars);
        if (dir !== 0) {
          // buying YES (dir=1) pays ask-ish; buying NO (dir=-1) modeled as
          // shorting the YES price with mirrored costs
          const rawEntry = next.p;
          const entryPrice = rawEntry + dir * (halfSpread + slip);
          if (entryPrice > 0.005 && entryPrice < 0.995) {
            open = {
              tokenId: s.tokenId,
              marketTitle: s.marketTitle,
              dir,
              entryTs: next.t,
              entryIdx: i + 1,
              entryPrice,
              size: 0, // sized later against equity at entry time
              stake: 0,
            };
            feesPaid += 0; // fee applied at sizing time below
          }
        }
        continue;
      }

      // manage open trade — exit checks use the execution bar's price
      const barsHeld = i + 1 - open.entryIdx;
      const raw = next.p;
      const pnlPct = (open.dir * (raw - open.entryPrice)) / open.entryPrice;
      let exitReason: BacktestTrade["exitReason"] | null = null;
      if (pnlPct >= config.targetPct / 100) exitReason = "target";
      else if (pnlPct <= -config.stopPct / 100) exitReason = "stop";
      else if (barsHeld >= config.holdBars) exitReason = "time";

      if (exitReason) {
        const exitPrice = raw - open.dir * (halfSpread + slip);
        trades.push({
          tokenId: open.tokenId,
          marketTitle: open.marketTitle,
          side: open.dir === 1 ? "BUY" : "SELL",
          entryTs: open.entryTs,
          exitTs: next.t,
          entryPrice: open.entryPrice,
          exitPrice,
          size: 0,
          pnl: 0, // filled in during the equity pass
          returnPct: (open.dir * (exitPrice - open.entryPrice)) / open.entryPrice,
          exitReason,
        });
        open = null;
      }
    }
    if (open) {
      const last = pts[pts.length - 1];
      const exitPrice = last.p - open.dir * (halfSpread + slip);
      trades.push({
        tokenId: open.tokenId,
        marketTitle: open.marketTitle,
        side: open.dir === 1 ? "BUY" : "SELL",
        entryTs: open.entryTs,
        exitTs: last.t,
        entryPrice: open.entryPrice,
        exitPrice,
        size: 0,
        pnl: 0,
        returnPct: (open.dir * (exitPrice - open.entryPrice)) / open.entryPrice,
        exitReason: "series_end",
      });
    }
  }

  // 2) equity pass — trades applied chronologically by exit time, sized at
  //    positionPct of equity at entry, with per-side fees
  trades.sort((a, b) => a.exitTs - b.exitTs);
  let equity = config.initialCapital;
  const equityCurve: { t: number; equity: number }[] = [
    { t: config.from, equity },
  ];
  const drawdownCurve: { t: number; dd: number }[] = [{ t: config.from, dd: 0 }];
  let peak = equity;
  let wins = 0;
  let losses = 0;
  let winSum = 0;
  let lossSum = 0;

  for (const tr of trades) {
    const stake = equity * (config.positionPct / 100);
    const shares = tr.entryPrice > 0 ? stake / tr.entryPrice : 0;
    const fees = stake * feeRate + shares * tr.exitPrice * feeRate;
    const pnl = tr.returnPct * stake - fees;
    tr.size = Number(shares.toFixed(2));
    tr.pnl = Number(pnl.toFixed(2));
    feesPaid += fees;
    equity += pnl;
    peak = Math.max(peak, equity);
    equityCurve.push({ t: tr.exitTs, equity: Number(equity.toFixed(2)) });
    drawdownCurve.push({
      t: tr.exitTs,
      dd: peak > 0 ? Number((((peak - equity) / peak) * 100).toFixed(2)) : 0,
    });
    if (pnl >= 0) {
      wins += 1;
      winSum += pnl;
    } else {
      losses += 1;
      lossSum += -pnl;
    }
  }
  equityCurve.push({ t: config.to, equity: Number(equity.toFixed(2)) });
  drawdownCurve.push({
    t: config.to,
    dd: peak > 0 ? Number((((peak - equity) / peak) * 100).toFixed(2)) : 0,
  });

  const n = trades.length;
  return {
    label: `HISTORICAL SIMULATION — ${strat.label}`,
    config,
    equityCurve,
    drawdownCurve,
    trades,
    stats: {
      totalReturnPct: Number(
        (((equity - config.initialCapital) / config.initialCapital) * 100).toFixed(2),
      ),
      maxDrawdownPct: Math.max(...drawdownCurve.map((d) => d.dd), 0),
      trades: n,
      wins,
      losses,
      winRate: n > 0 ? Number(((wins / n) * 100).toFixed(1)) : 0,
      avgWin: wins > 0 ? Number((winSum / wins).toFixed(2)) : 0,
      avgLoss: losses > 0 ? Number((lossSum / losses).toFixed(2)) : 0,
      profitFactor: lossSum > 0 ? Number((winSum / lossSum).toFixed(2)) : wins > 0 ? Infinity : 0,
      feesPaid: Number(feesPaid.toFixed(2)),
    },
    assumptions: [
      `Strategy: ${strat.label} — ${strat.note}`,
      `Execution at NEXT bar's price (no look-ahead).`,
      `Spread assumption: ${(config.spreadAssumption * 100).toFixed(1)}c round-trip half-spread each side.`,
      `Slippage: ${config.slippageBps}bps each side. Fees: ${config.feeRateBps}bps each side.`,
      `Position size: ${config.positionPct}% of equity at entry, compounding.`,
      `Fills assumed complete at modeled price — real books may be thinner.`,
      `Exits: target +${config.targetPct}%, stop -${config.stopPct}%, time ${config.holdBars} bars.`,
    ],
    isHistoricalSimulation: true,
  };
}
