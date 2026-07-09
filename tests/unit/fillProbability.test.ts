import { describe, expect, it } from "vitest";
import { estimateLimitFillProbability } from "@/lib/engine/execution/fillProbability";
import { analyzeBookReactor } from "@/lib/engine/micro/orderbookReactor";
import { makeBook } from "../helpers";

const now = Date.now();

describe("fill probability", () => {
  it("treats crossing orders as near-certain fills", () => {
    const book = makeBook({ bestBid: 0.54, bestAsk: 0.56, spread: 0.02 });
    const est = estimateLimitFillProbability({
      proposal: { side: "BUY", orderType: "limit", price: 0.56, size: 10 },
      book,
      now,
    });

    expect(est.probability).toBeGreaterThan(0.9);
    expect(est.reasons).toContain("crosses_touch");
  });

  it("penalizes passive orders with no opposite flow and fragile quotes", () => {
    const prev = makeBook({
      bids: [{ price: 0.54, size: 1000 }],
      bidDepthUsd: 540,
      ts: now - 30_000,
    });
    const book = makeBook({
      bids: [{ price: 0.54, size: 100 }],
      bestBid: 0.54,
      bestAsk: 0.56,
      spread: 0.02,
      bidDepthUsd: 54,
      ts: now,
    });
    const reactor = analyzeBookReactor({ previous: prev, book, trades: [], now });
    const est = estimateLimitFillProbability({
      proposal: { side: "BUY", orderType: "limit", price: 0.55, size: 200 },
      book,
      reactor,
      trades: [],
      ttlMs: 60_000,
      now,
    });

    expect(est.probability).toBeLessThan(0.35);
    expect(est.adverseSelectionRisk).toBeGreaterThan(0.25);
    expect(est.reasons).toContain("no_recent_opposite_flow");
  });
});
