import { describe, expect, it } from "vitest";
import { evaluateTrade } from "@/lib/engine/risk/riskEngine";
import { cappedKelly, kellyFraction } from "@/lib/engine/risk/kelly";
import type { TradeProposal } from "@/lib/types";
import { makeBook, makeMarket, makePortfolio, makeSettings } from "../helpers";

const baseProposal: TradeProposal = {
  conditionId: "0xcond1",
  tokenId: "tok-yes",
  outcome: "Yes",
  category: "Testing",
  side: "BUY",
  orderType: "limit",
  price: 0.56,
  size: 50,
};

function evalWith(
  proposal: Partial<TradeProposal> = {},
  opts: {
    settings?: Parameters<typeof makeSettings>[0];
    portfolio?: Parameters<typeof makePortfolio>[0];
    market?: Parameters<typeof makeMarket>[0];
  } = {},
) {
  return evaluateTrade({
    proposal: { ...baseProposal, ...proposal },
    portfolio: makePortfolio(opts.portfolio),
    settings: makeSettings(opts.settings),
    market: makeMarket(opts.market),
    book: makeBook(),
  });
}

describe("kelly", () => {
  it("computes full kelly for a binary payoff", () => {
    // p=0.5 entry, q=0.6: b=1, f* = (0.6 - 0.4)/1 = 0.2
    expect(kellyFraction(0.6, 0.5)).toBeCloseTo(0.2, 6);
  });
  it("is zero without positive edge", () => {
    expect(kellyFraction(0.5, 0.5)).toBe(0);
    expect(kellyFraction(0.4, 0.5)).toBe(0);
  });
  it("caps conservatively", () => {
    // quarter kelly of 0.2 = 0.05, bounded by 1% max fraction → 0.01
    expect(cappedKelly(0.6, 0.5, 0.25, 0.01)).toBeCloseTo(0.01, 6);
    expect(cappedKelly(0.6, 0.5, 0.25, 0.5)).toBeCloseTo(0.05, 6);
  });
});

describe("risk engine — approval path", () => {
  it("approves a small, clean trade and explains it", () => {
    const a = evalWith({ size: 50, winProbability: 0.65 });
    expect(a.approved).toBe(true);
    expect(a.reasons[0]).toContain("Approved");
    expect(a.estCostUsd).toBeCloseTo(0.56 * 50, 2);
    expect(a.maxLossUsd).toBeCloseTo(a.estCostUsd, 2);
    expect(a.netEdge).toBeGreaterThan(0);
    expect(a.suggestedShares).toBeGreaterThan(0);
  });

  it("computes required edge from spread, fees and slippage", () => {
    const a = evalWith({}, { settings: { feeRateBps: 100, slippageBps: 100 } });
    // spread 0.02/2 + 0.01 + 0.01 = 0.03
    expect(a.requiredEdge).toBeCloseTo(0.03, 6);
  });
});

describe("risk engine — hard blocks", () => {
  it("blocks when the kill switch is engaged", () => {
    const a = evalWith({}, { settings: { killSwitch: true } });
    expect(a.approved).toBe(false);
    expect(a.reasons.join()).toContain("kill_switch");
  });

  it("blocks stale market data", () => {
    const a = evalWith({}, { market: { fetchedAt: Date.now() - 10 * 60_000 } });
    expect(a.approved).toBe(false);
    expect(a.checks.find((c) => c.name === "data_freshness")?.passed).toBe(false);
  });

  it("blocks wide spreads", () => {
    const a = evaluateTrade({
      proposal: baseProposal,
      portfolio: makePortfolio(),
      settings: makeSettings(),
      market: makeMarket({ spread: 0.2 }),
      book: makeBook({ spread: 0.2, bestBid: 0.45, bestAsk: 0.65 }),
    });
    expect(a.approved).toBe(false);
    expect(a.checks.find((c) => c.name === "spread_limit")?.passed).toBe(false);
  });

  it("blocks thin liquidity", () => {
    const a = evalWith({}, { market: { liquidity: 100 } });
    expect(a.checks.find((c) => c.name === "liquidity_floor")?.passed).toBe(false);
    expect(a.approved).toBe(false);
  });

  it("blocks ambiguous resolution text", () => {
    const a = evalWith({}, { market: { description: "tbd" } });
    expect(a.checks.find((c) => c.name === "resolution_clarity")?.passed).toBe(false);
    expect(a.approved).toBe(false);
  });

  it("blocks per-trade size above the cap", () => {
    const a = evalWith({ size: 5_000 }); // $2,800 ≫ min($250, 1% of $10k)
    expect(a.checks.find((c) => c.name === "trade_size_limit")?.passed).toBe(false);
    expect(a.approved).toBe(false);
  });

  it("blocks when the daily loss budget is exhausted", () => {
    const a = evalWith({}, { portfolio: { dailyRealizedPnl: -95 } });
    expect(a.checks.find((c) => c.name === "daily_loss_budget")?.passed).toBe(false);
    expect(a.approved).toBe(false);
  });

  it("blocks market-exposure concentration", () => {
    const a = evalWith(
      {},
      { portfolio: { exposureByMarket: { "0xcond1": 490 }, exposure: 490 } },
    );
    expect(a.checks.find((c) => c.name === "market_exposure")?.passed).toBe(false);
    expect(a.approved).toBe(false);
  });

  it("blocks category-exposure concentration", () => {
    const a = evalWith(
      {},
      { portfolio: { exposureByCategory: { Testing: 1_480 }, exposure: 1_480 } },
    );
    expect(a.checks.find((c) => c.name === "category_exposure")?.passed).toBe(false);
    expect(a.approved).toBe(false);
  });

  it("blocks buys without cash and sells without inventory", () => {
    const noCash = evalWith({}, { portfolio: { cash: 1 } });
    expect(noCash.checks.find((c) => c.name === "cash_available")?.passed).toBe(false);
    const noPos = evalWith({ side: "SELL" });
    expect(noPos.checks.find((c) => c.name === "position_available")?.passed).toBe(false);
    expect(noPos.approved).toBe(false);
  });

  it("blocks signal-attached trades below the score threshold", () => {
    const a = evalWith({ signalScore: 10 });
    expect(a.checks.find((c) => c.name === "signal_score")?.passed).toBe(false);
    expect(a.approved).toBe(false);
  });
});

describe("risk engine — informational math", () => {
  it("warns (not blocks) on negative net edge at market-implied probability", () => {
    const a = evalWith({}); // no winProbability given
    const edge = a.checks.find((c) => c.name === "positive_net_edge");
    expect(edge?.passed).toBe(false);
    expect(edge?.severity).toBe("warn");
    // warn alone must not block
    expect(a.checks.filter((c) => c.severity === "block" && !c.passed)).toHaveLength(0);
  });

  it("suggests zero size without a user probability estimate", () => {
    const a = evalWith({});
    expect(a.suggestedSizeUsd).toBe(0);
  });

  it("estimates fill probability higher for marketable orders", () => {
    const marketable = evalWith({ price: 0.56 });
    const passive = evalWith({ price: 0.5 });
    expect(marketable.expectedFillProbability).toBeGreaterThan(passive.expectedFillProbability);
  });
});
