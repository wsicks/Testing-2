import { describe, expect, it } from "vitest";
import { evaluateTrade } from "@/lib/engine/risk/riskEngine";
import { makeBook, makeMarket, makePortfolio, makeSettings } from "../helpers";

describe("risk engine — exit relaxation", () => {
  const held = makePortfolio({
    positions: [
      {
        tokenId: "tok-yes",
        mode: "paper",
        size: 100,
        avgPrice: 0.5,
        realizedPnl: 0,
        updatedAt: Date.now(),
      },
    ],
  });

  it("lets a risk-reducing SELL exit through a degraded market", () => {
    const a = evaluateTrade({
      proposal: {
        tokenId: "tok-yes",
        conditionId: "0xcond1",
        side: "SELL",
        orderType: "market",
        price: 0.45,
        size: 100,
        isExit: true,
      },
      portfolio: held,
      settings: makeSettings(),
      // wide spread + thin liquidity + no description + stale data: every
      // entry-blocking condition at once
      market: makeMarket({
        spread: 0.2,
        liquidity: 50,
        description: undefined,
        fetchedAt: Date.now() - 10 * 60_000,
      }),
      book: makeBook({ spread: 0.2 }),
    });
    expect(a.approved).toBe(true);
    // the problems are still surfaced — as warnings
    const warns = a.checks.filter((c) => !c.passed && c.severity === "warn");
    expect(warns.map((c) => c.name)).toEqual(
      expect.arrayContaining(["spread_limit", "liquidity_floor", "data_freshness"]),
    );
  });

  it("still blocks exits that oversell the held position", () => {
    const a = evaluateTrade({
      proposal: {
        tokenId: "tok-yes",
        side: "SELL",
        orderType: "market",
        price: 0.45,
        size: 500, // only 100 held
        isExit: true,
      },
      portfolio: held,
      settings: makeSettings(),
      market: makeMarket(),
      book: makeBook(),
    });
    expect(a.approved).toBe(false);
    expect(a.checks.find((c) => c.name === "position_available")?.passed).toBe(false);
  });

  it("does NOT relax entry-side BUYs", () => {
    const a = evaluateTrade({
      proposal: {
        tokenId: "tok-yes",
        side: "BUY",
        orderType: "limit",
        price: 0.56,
        size: 10,
        isExit: true, // nonsensical on a BUY — must be ignored
      },
      portfolio: makePortfolio(),
      settings: makeSettings(),
      market: makeMarket({ spread: 0.2 }),
      book: makeBook({ spread: 0.2 }),
    });
    expect(a.approved).toBe(false);
  });

  it("kill switch blocks even exits", () => {
    const a = evaluateTrade({
      proposal: {
        tokenId: "tok-yes",
        side: "SELL",
        orderType: "market",
        price: 0.45,
        size: 100,
        isExit: true,
      },
      portfolio: held,
      settings: makeSettings({ killSwitch: true }),
      market: makeMarket(),
      book: makeBook(),
    });
    expect(a.approved).toBe(false);
  });
});
