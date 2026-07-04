import { describe, expect, it } from "vitest";
import {
  momentumStrategy,
  runBacktest,
} from "@/lib/engine/backtest/backtester";
import type { BacktestConfig, PricePoint } from "@/lib/types";

const HOUR = 3600;
const start = 1_700_000_000;

function series(prices: number[]): PricePoint[] {
  return prices.map((p, i) => ({ t: start + i * HOUR, p }));
}

const cfg: BacktestConfig = {
  strategyId: "momentum",
  tokenIds: ["tok"],
  from: start,
  to: start + 300 * HOUR,
  initialCapital: 10_000,
  positionPct: 2,
  entryThreshold: 50,
  holdBars: 10,
  targetPct: 15,
  stopPct: 10,
  feeRateBps: 0,
  slippageBps: 0,
  spreadAssumption: 0,
};

// 20 flat bars, then a steady climb — momentum triggers during the climb
const trending = series([
  ...Array.from({ length: 20 }, () => 0.4),
  ...Array.from({ length: 40 }, (_, i) => 0.4 + (i + 1) * 0.01),
]);

describe("backtester", () => {
  it("generates trades on a trending series and labels results as simulation", () => {
    const r = runBacktest(cfg, [{ tokenId: "tok", marketTitle: "trend", points: trending }]);
    expect(r.isHistoricalSimulation).toBe(true);
    expect(r.label).toContain("HISTORICAL SIMULATION");
    expect(r.trades.length).toBeGreaterThan(0);
    expect(r.trades[0].side).toBe("BUY");
    expect(r.assumptions.join(" ")).toContain("no look-ahead");
  });

  it("prevents look-ahead: entries execute at the NEXT bar's price", () => {
    const r = runBacktest(cfg, [{ tokenId: "tok", points: trending }]);
    const first = r.trades[0];
    // the entry price (no costs configured) must equal a bar in the series at
    // the entry timestamp — i.e. the bar AFTER the signal bar
    const entryBar = trending.find((p) => p.t === first.entryTs);
    expect(entryBar).toBeDefined();
    expect(first.entryPrice).toBeCloseTo(entryBar!.p, 10);
    // signal needs a >4c move over 12 bars; at the entry bar's PREDECESSOR the
    // window must already satisfy it (the signal came from bar t-1)
    const idx = trending.findIndex((p) => p.t === first.entryTs);
    const sigWindow = trending.slice(0, idx); // data available at decision time
    expect(momentumStrategy(sigWindow)).toBe(1);
  });

  it("applies spread and slippage costs against the trader", () => {
    const withCosts = runBacktest(
      { ...cfg, spreadAssumption: 0.02, slippageBps: 100 },
      [{ tokenId: "tok", points: trending }],
    );
    const noCosts = runBacktest(cfg, [{ tokenId: "tok", points: trending }]);
    expect(withCosts.trades[0].entryPrice).toBeGreaterThan(noCosts.trades[0].entryPrice);
    expect(withCosts.stats.totalReturnPct).toBeLessThan(noCosts.stats.totalReturnPct);
  });

  it("respects stop exits", () => {
    // climb to trigger entry, then crash
    const crash = series([
      ...Array.from({ length: 20 }, () => 0.5),
      ...Array.from({ length: 14 }, (_, i) => 0.5 + (i + 1) * 0.012),
      ...Array.from({ length: 20 }, (_, i) => 0.67 - (i + 1) * 0.03),
    ]);
    const r = runBacktest({ ...cfg, holdBars: 100 }, [{ tokenId: "tok", points: crash }]);
    expect(r.trades.some((t) => t.exitReason === "stop")).toBe(true);
  });

  it("produces no trades on flat series and returns a sane empty result", () => {
    const flat = series(Array.from({ length: 100 }, () => 0.5));
    const r = runBacktest(cfg, [{ tokenId: "tok", points: flat }]);
    expect(r.trades).toHaveLength(0);
    expect(r.stats.totalReturnPct).toBe(0);
    expect(r.equityCurve[r.equityCurve.length - 1].equity).toBe(cfg.initialCapital);
  });

  it("compounds equity across chronologically-ordered trades", () => {
    const r = runBacktest(cfg, [{ tokenId: "tok", points: trending }]);
    for (let i = 1; i < r.equityCurve.length; i++) {
      expect(r.equityCurve[i].t).toBeGreaterThanOrEqual(r.equityCurve[i - 1].t);
    }
    const finalEquity = r.equityCurve[r.equityCurve.length - 1].equity;
    const pnlSum = r.trades.reduce((a, t) => a + t.pnl, 0);
    expect(finalEquity).toBeCloseTo(cfg.initialCapital + pnlSum, 1);
  });
});
