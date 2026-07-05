import { describe, expect, it } from "vitest";
import { confluenceMatrix, driftByPriceProfile } from "@/lib/alpha/evidenceLab";
import { phantomAnalysis, phantomDepthSignal } from "@/lib/engine/signals/phantomDepth";
import type { AlphaOutcome } from "@/lib/alpha/types";
import type { OrderBookData } from "@/lib/types";
import { makeBook, makeMarket, makeSettings } from "../helpers";

const now = Date.now();
const settings = makeSettings();

function outcome(
  featureId: string,
  conditionId: string,
  createdAt: number,
  d1h: number,
  opts: Partial<AlphaOutcome> = {},
): AlphaOutcome {
  return {
    id: `${featureId}:${conditionId}:${createdAt}`,
    featureId,
    signalId: "s",
    conditionId,
    direction: "BUY_YES",
    entryMid: 0.5,
    tradable: true,
    wasProposed: true,
    createdAt,
    buckets: { b1h: { drift: d1h, at: createdAt }, b24h: { drift: d1h * 1.2, at: createdAt } },
    ...opts,
  };
}

describe("confluence matrix", () => {
  it("measures joint lift when two strategies co-fire, gated by sample size", () => {
    const rows: AlphaOutcome[] = [];
    // strategy A alone: +1c avg; strategy B alone: +1c avg
    for (let i = 0; i < 20; i++) rows.push(outcome("a", `solo_a${i}`, now + i, 0.01));
    for (let i = 0; i < 20; i++) rows.push(outcome("b", `solo_b${i}`, now + i, 0.01));
    // co-fired markets: both capture +4c — the combination adds information
    for (let i = 0; i < 10; i++) {
      rows.push(outcome("a", `joint${i}`, now + i * 1000, 0.04));
      rows.push(outcome("b", `joint${i}`, now + i * 1000 + 60_000, 0.04));
    }
    const m = confluenceMatrix(rows);
    const cell = m.cells.find((c) => c.a === "a" && c.b === "b")!;
    expect(cell).toBeDefined();
    expect(cell.n).toBe(10);
    expect(cell.jointAvg1h).toBeCloseTo(0.04, 3);
    // solo averages include the joint rows too: (20*0.01 + 10*0.04)/30 = 0.02
    expect(cell.soloAvgA).toBeCloseTo(0.02, 3);
    expect(cell.lift).toBeCloseTo(0.02, 3);
  });

  it("ignores pairs outside the window or below the sample gate", () => {
    const rows: AlphaOutcome[] = [
      outcome("a", "m1", now, 0.05),
      outcome("b", "m1", now + 60 * 60_000, 0.05), // 1h later — outside window
      outcome("a", "m2", now, 0.05),
      outcome("b", "m2", now + 60_000, 0.05), // joint but only 1 sample
    ];
    expect(confluenceMatrix(rows).cells).toHaveLength(0);
  });

  it("same-strategy repeat firings never pair with themselves", () => {
    const rows: AlphaOutcome[] = [];
    for (let i = 0; i < 20; i++) rows.push(outcome("a", "m1", now + i * 10_000, 0.02));
    expect(confluenceMatrix(rows).cells).toHaveLength(0);
  });
});

describe("drift-by-price profile", () => {
  it("recovers RAW market drift regardless of signal direction", () => {
    const rows: AlphaOutcome[] = [
      // cheap market drifting DOWN 2c raw; a BUY_NO signal captures +2c adjusted
      outcome("a", "m1", now, 0.02, { entryMid: 0.05, direction: "BUY_NO", buckets: { b24h: { drift: 0.02, at: now } } }),
      // expensive market drifting UP 2c raw via BUY_YES
      outcome("a", "m2", now, 0.02, { entryMid: 0.95, buckets: { b24h: { drift: 0.02, at: now } } }),
    ];
    const p = driftByPriceProfile(rows);
    expect(p.buckets[0].avgRawDrift24h).toBeCloseTo(-0.02, 4); // longshot drifted down
    expect(p.buckets[9].avgRawDrift24h).toBeCloseTo(0.02, 4); // favorite drifted up
    expect(p.totalSamples).toBe(2);
    expect(p.note).toContain("biased slice");
  });
});

describe("phantom depth", () => {
  const prev: OrderBookData = makeBook({
    bids: [{ price: 0.54, size: 2_000 }],
    asks: [{ price: 0.56, size: 2_000 }],
    bestBid: 0.54,
    bestAsk: 0.56,
    ts: now - 30_000,
  });

  it("counts vanished near-touch depth minus the tape as phantom", () => {
    const cur = makeBook({
      bids: [{ price: 0.54, size: 100 }],
      asks: [{ price: 0.56, size: 100 }],
      bestBid: 0.54,
      bestAsk: 0.56,
      ts: now,
    });
    // no trades printed — everything that vanished is phantom
    const r = phantomAnalysis(prev, cur, [])!;
    expect(r.prevNearUsd).toBeCloseTo(0.54 * 2000 + 0.56 * 2000, 0);
    expect(r.tradedUsd).toBe(0);
    expect(r.phantomShare).toBeGreaterThan(0.9);
  });

  it("depth explained by prints is NOT phantom", () => {
    const cur = makeBook({
      bids: [{ price: 0.54, size: 100 }],
      asks: [{ price: 0.56, size: 2_000 }],
      bestBid: 0.54,
      bestAsk: 0.56,
      ts: now,
    });
    const tape = [{ side: "SELL" as const, price: 0.54, size: 1_900, ts: now - 10_000 }];
    const r = phantomAnalysis(prev, cur, tape)!;
    expect(r.tradedUsd).toBeCloseTo(0.54 * 1900, 0);
    expect(r.phantomShare).toBeLessThan(0.05);
  });

  it("levels the touch swept THROUGH are consumed, not phantom", () => {
    const cur = makeBook({
      bids: [{ price: 0.5, size: 500 }], // bid collapsed below the old level
      asks: [{ price: 0.56, size: 2_000 }],
      bestBid: 0.5,
      bestAsk: 0.56,
      ts: now,
    });
    const r = phantomAnalysis(prev, cur, [])!;
    // the 0.54 bid was swept through (best bid now 0.50) — excluded
    expect(r.vanishedUsd).toBeLessThan(0.56 * 2000 * 0.01 + 1); // only ask side could count, unchanged here → ~0
  });

  it("signal fires review-gated on high phantom share and stays silent without prevBook", () => {
    const market = makeMarket();
    const cur = makeBook({
      bids: [{ price: 0.54, size: 50 }],
      asks: [{ price: 0.56, size: 50 }],
      bestBid: 0.54,
      bestAsk: 0.56,
      ts: now,
    });
    const sig = phantomDepthSignal.run({ market, book: cur, prevBook: prev, trades: [], settings, now });
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("NEUTRAL");
    expect(sig!.status).toBe("rejected"); // resolution_caveat always fails
    expect(sig!.meta?.phantomShare as number).toBeGreaterThan(0.5);
    expect(phantomDepthSignal.run({ market, book: cur, settings, now })).toBeNull();
  });
});
