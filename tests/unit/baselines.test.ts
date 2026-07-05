import { describe, expect, it } from "vitest";
import { mmAbsenceSignal } from "@/lib/engine/signals/mmAbsence";
import { liquidityVacuumSignal, usdToMove } from "@/lib/engine/signals/liquidityVacuum";
import { DEFAULT_ALPHA } from "@/lib/constants";
import type { WalletMarketEntry } from "@/lib/alpha/types";
import { skillForDimension } from "@/lib/alpha/score";
import { makeBook, makeMarket, makeSettings } from "../helpers";

const now = Date.now();
const settings = makeSettings();

function smartStance(overrides: Partial<WalletMarketEntry> = {}): WalletMarketEntry {
  return {
    walletId: "0xabc",
    displayName: "Proven-Wallet",
    label: "smart_specialist",
    side: "YES",
    avgEntryPrice: 0.55,
    sizeUsd: 400,
    lastTradeTs: now - 30 * 60_000,
    entries: 2,
    stillHolding: true,
    exiting: false,
    dimensionSkill: skillForDimension(
      "cat:crypto",
      Array.from({ length: 30 }, (_, i) => ({
        pnl: i % 3 === 0 ? -8 : 14, initialValue: 50, shares: 100,
        win: i % 3 !== 0, closedAt: now - i * 86_400_000, dimensions: ["cat:crypto"],
      })),
    ),
    forward: { samples: 15, avgDrift1h: 0.04, avgDrift5s: 0.002, updatedAt: now },
    ...overrides,
  };
}

describe("market maker absence", () => {
  const blownOutMarket = makeMarket({ spread: 0.06, bestBid: 0.52, bestAsk: 0.58 });
  const blownOutBook = makeBook({ bestBid: 0.52, bestAsk: 0.58, spread: 0.06 });
  const baseline = { spreadEma: 0.012, liquidityEma: 60_000, samples: 40 };

  it("returns null without an established baseline (cold start is silent)", () => {
    expect(
      mmAbsenceSignal.run({ market: blownOutMarket, book: blownOutBook, settings, now, alpha: DEFAULT_ALPHA }),
    ).toBeNull();
    expect(
      mmAbsenceSignal.run({
        market: blownOutMarket, book: blownOutBook, settings, now, alpha: DEFAULT_ALPHA,
        baseline: { ...baseline, samples: 5 },
      }),
    ).toBeNull();
  });

  it("returns null when the spread is normal for THIS market", () => {
    const wideButNormal = { spreadEma: 0.055, liquidityEma: 60_000, samples: 40 };
    expect(
      mmAbsenceSignal.run({
        market: blownOutMarket, book: blownOutBook, settings, now,
        alpha: DEFAULT_ALPHA, baseline: wideButNormal,
      }),
    ).toBeNull();
  });

  it("emits a NEUTRAL observation on a blowout without a positioned wallet", () => {
    const sig = mmAbsenceSignal.run({
      market: blownOutMarket, book: blownOutBook, settings, now,
      alpha: DEFAULT_ALPHA, baseline,
    });
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("NEUTRAL");
    expect(sig!.status).toBe("rejected"); // directional_evidence fails → review
    expect(sig!.meta?.spreadRatio as number).toBeGreaterThan(2.5);
  });

  it("goes directional with a proven positioned wallet whose edge clears the blown-out spread", () => {
    const sig = mmAbsenceSignal.run({
      market: blownOutMarket, book: blownOutBook, settings, now,
      alpha: DEFAULT_ALPHA, baseline,
      walletIntel: { entries: [smartStance()], crowdSameSide: 1, updatedAt: now - 60_000 },
    });
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("BUY_YES");
    expect(sig!.meta?.walletId).toBe("0xabc");
    // 4c measured edge vs 3c half-spread + 0.5c slippage → edge check passes
    expect(sig!.checks.find((c) => c.name === "edge_vs_current_spread")?.passed).toBe(true);
  });

  it("stale data self-rejects — a stale blowout may already be refilled", () => {
    const sig = mmAbsenceSignal.run({
      market: { ...blownOutMarket, fetchedAt: now - 120_000 },
      book: blownOutBook, settings, now, alpha: DEFAULT_ALPHA, baseline,
    });
    expect(sig!.checks.find((c) => c.name === "data_freshness")?.passed).toBe(false);
    expect(sig!.status).toBe("rejected");
  });
});

describe("liquidity vacuum", () => {
  it("walks the book to price a 1c move", () => {
    const asks = [
      { price: 0.56, size: 100 }, // $56 inside 1c
      { price: 0.565, size: 100 }, // $56.5 inside 1c
      { price: 0.58, size: 5_000 }, // beyond +1c
    ];
    expect(usdToMove(asks, 0.56, 0.01, "up")).toBeCloseTo(0.56 * 100 + 0.565 * 100, 2);
  });

  it("flags an active market resting on air; never executable", () => {
    const market = makeMarket({ volume24h: 80_000 });
    const book = makeBook({
      bids: [{ price: 0.54, size: 100 }, { price: 0.5, size: 5_000 }],
      asks: [{ price: 0.56, size: 120 }, { price: 0.6, size: 5_000 }],
      bestBid: 0.54,
      bestAsk: 0.56,
    });
    const sig = liquidityVacuumSignal.run({ market, book, settings, now });
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("NEUTRAL");
    expect(sig!.status).toBe("rejected"); // execution_blocked always fails
    expect(sig!.meta?.usdToLift1c as number).toBeLessThan(200);
  });

  it("stays silent for genuinely deep books and quiet markets", () => {
    const deep = liquidityVacuumSignal.run({
      market: makeMarket({ volume24h: 80_000 }),
      book: makeBook(), // default helper book is deep near the touch
      settings,
      now,
    });
    expect(deep).toBeNull();
    const quiet = liquidityVacuumSignal.run({
      market: makeMarket({ volume24h: 500 }),
      book: makeBook({ asks: [{ price: 0.56, size: 10 }], bids: [{ price: 0.54, size: 10 }] }),
      settings,
      now,
    });
    expect(quiet).toBeNull();
  });
});
