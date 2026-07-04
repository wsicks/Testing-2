import { describe, expect, it } from "vitest";
import { kalmanFilter } from "@/lib/engine/micro/kalman";
import {
  bookImbalance,
  computeMicroMetrics,
  microPrice,
  tapeImbalance,
} from "@/lib/engine/micro/microstructure";
import { classifyRegime, regimeAllows } from "@/lib/engine/micro/regime";
import type { PricePoint, RecentTrade } from "@/lib/types";
import { makeBook } from "../helpers";

const HOUR = 3600;
const t0 = 1_700_000_000;
const series = (ps: number[]): PricePoint[] => ps.map((p, i) => ({ t: t0 + i * HOUR, p }));

describe("kalman fair-value filter", () => {
  it("tracks a stable series with near-zero z-score", () => {
    const kf = kalmanFilter(series(Array.from({ length: 50 }, (_, i) => 0.5 + 0.002 * Math.sin(i))));
    expect(kf).not.toBeNull();
    expect(kf!.fairValue).toBeGreaterThan(0.45);
    expect(kf!.fairValue).toBeLessThan(0.55);
    expect(Math.abs(kf!.zScore)).toBeLessThan(2);
  });

  it("flags a sudden dislocation with a large innovation z-score", () => {
    const calm = Array.from({ length: 40 }, () => 0.5);
    const kf = kalmanFilter(series([...calm, 0.62]));
    expect(kf).not.toBeNull();
    expect(kf!.zScore).toBeGreaterThan(2);
    // the filter should NOT have fully chased the outlier
    expect(kf!.fairValue).toBeLessThan(0.58);
  });

  it("requires a minimum history", () => {
    expect(kalmanFilter(series([0.5, 0.51]))).toBeNull();
  });
});

describe("microstructure metrics", () => {
  it("computes the Stoikov micro-price weighted toward the heavier side", () => {
    // bid 0.54×500, ask 0.56×400 → bid-heavy: micro-price above mid
    const mp = microPrice(makeBook());
    expect(mp).toBeDefined();
    expect(mp!).toBeGreaterThan(0.55);
  });

  it("computes signed book imbalance within the band", () => {
    const imb = bookImbalance(makeBook());
    expect(imb).toBeGreaterThan(-1);
    expect(imb).toBeLessThan(1);
    const bidHeavy = makeBook({
      bids: [{ price: 0.54, size: 100_000 }],
      asks: [{ price: 0.56, size: 100 }],
    });
    expect(bookImbalance(bidHeavy)).toBeGreaterThan(0.9);
  });

  it("normalizes tape direction to the YES token", () => {
    const now = Date.now();
    const trades: RecentTrade[] = [
      { side: "BUY", price: 0.5, size: 100, ts: now, outcome: "Yes" },
      { side: "BUY", price: 0.5, size: 100, ts: now, outcome: "No" }, // = YES sell
    ];
    const t = tapeImbalance(trades, 3_600_000, now);
    expect(t.imbalance).toBeCloseTo(0, 6);
    expect(t.used).toBe(2);
  });

  it("produces a bounded composite pressure score", () => {
    const m = computeMicroMetrics(makeBook(), []);
    expect(m).not.toBeNull();
    expect(Math.abs(m!.pressure)).toBeLessThanOrEqual(1);
  });
});

describe("regime classifier", () => {
  it("labels a flat series calm", () => {
    const r = classifyRegime(series(Array.from({ length: 48 }, () => 0.5)));
    expect(r.regime).toBe("calm");
  });

  it("labels persistent drift trending", () => {
    const r = classifyRegime(series(Array.from({ length: 48 }, (_, i) => 0.3 + i * 0.008)));
    expect(r.regime).toBe("trending");
    expect(r.trendStrength).toBeGreaterThan(1.5);
  });

  it("labels high noise without drift chaotic", () => {
    const r = classifyRegime(
      series(Array.from({ length: 48 }, (_, i) => 0.5 + (i % 2 === 0 ? 0.03 : -0.03))),
    );
    expect(r.regime).toBe("chaotic");
  });

  it("gates strategies by regime fit", () => {
    expect(regimeAllows("dislocation", "calm")).toBe(true);
    expect(regimeAllows("dislocation", "trending")).toBe(false);
    expect(regimeAllows("price_movement", "trending")).toBe(true);
    expect(regimeAllows("anything", "unknown")).toBe(false);
  });
});
