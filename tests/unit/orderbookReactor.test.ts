import { describe, expect, it } from "vitest";
import { analyzeBookReactor } from "@/lib/engine/micro/orderbookReactor";
import { makeBook } from "../helpers";

const now = Date.now();

describe("orderbook reactor", () => {
  it("detects unexplained vanished depth as quote fragility", () => {
    const prev = makeBook({
      bids: [{ price: 0.54, size: 1000 }],
      asks: [{ price: 0.56, size: 1000 }],
      bidDepthUsd: 540,
      askDepthUsd: 560,
      ts: now - 30_000,
    });
    const cur = makeBook({
      bids: [{ price: 0.54, size: 100 }],
      asks: [{ price: 0.56, size: 1000 }],
      bidDepthUsd: 54,
      askDepthUsd: 560,
      ts: now,
    });
    const snap = analyzeBookReactor({ previous: prev, book: cur, trades: [], now });

    expect(snap.vanishedBidUsd).toBeGreaterThan(400);
    expect(snap.quoteStability).toBeLessThan(0.7);
    expect(snap.spoofRisk).toBeGreaterThan(0.3);
    expect(snap.notes).toContain("vanishing_depth");
  });

  it("uses tape to avoid over-penalizing traded-through depth", () => {
    const prev = makeBook({
      bids: [{ price: 0.54, size: 1000 }],
      bidDepthUsd: 540,
      ts: now - 30_000,
    });
    const cur = makeBook({
      bids: [{ price: 0.54, size: 100 }],
      bidDepthUsd: 54,
      ts: now,
    });
    const snap = analyzeBookReactor({
      previous: prev,
      book: cur,
      trades: [{ side: "SELL", price: 0.54, size: 900, ts: now - 5_000 }],
      now,
    });

    expect(snap.unexplainedVanishUsd).toBeLessThan(5);
    expect(snap.quoteStability).toBeGreaterThan(0.95);
  });
});
