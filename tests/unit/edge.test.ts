import { describe, expect, it } from "vitest";
import { complementArbOpportunity } from "@/lib/engine/arb";
import {
  decideEntries,
  makerEntryPrice,
  type PolicyInput,
} from "@/lib/engine/autopilot/policy";
import { strategyHitRates } from "@/lib/alpha/hitRate";
import type { AlphaOutcome } from "@/lib/alpha/types";
import type { SignalResult } from "@/lib/types";
import { DEFAULT_AUTOPILOT } from "@/lib/constants";
import { makeMarket, makePortfolio, makeSettings } from "../helpers";

const now = Date.now();
const settings = makeSettings();

describe("complement arbitrage math", () => {
  const book = (ask: number, size = 500) => ({
    asks: [{ price: ask, size }],
    bestAsk: ask,
  });

  it("finds a pair when both asks sum under $1 net of fees", () => {
    const opp = complementArbOpportunity(book(0.47), book(0.51), 0, 0.005)!;
    expect(opp).not.toBeNull();
    expect(opp.sum).toBeCloseTo(0.98, 4);
    expect(opp.netDiscount).toBeCloseTo(0.02, 4);
    expect(opp.maxPairs).toBe(500);
  });

  it("fees can kill a gross discount", () => {
    // 1c gross discount, 100bps fees on $0.99 notional ≈ 0.99c → net ~0
    expect(complementArbOpportunity(book(0.48), book(0.51), 100, 0.005)).toBeNull();
  });

  it("a normal (sum ≥ 1) book pair is never an arb", () => {
    expect(complementArbOpportunity(book(0.55), book(0.47), 0)).toBeNull();
    expect(complementArbOpportunity(book(0.5), book(0.5), 0)).toBeNull();
  });

  it("size comes from the THINNER top level; empty books never pair", () => {
    const opp = complementArbOpportunity(
      { asks: [{ price: 0.4, size: 30 }], bestAsk: 0.4 },
      { asks: [{ price: 0.55, size: 900 }], bestAsk: 0.55 },
      0,
    )!;
    expect(opp.maxPairs).toBe(30);
    expect(complementArbOpportunity({ asks: [], bestAsk: undefined }, book(0.4), 0)).toBeNull();
  });
});

describe("maker entry pricing", () => {
  it("posts inside the spread at the tick", () => {
    expect(makerEntryPrice(0.54, 0.58, 0.01)).toBeCloseTo(0.56, 4);
    // asymmetric: mid rounds to tick, clamped inside the touch
    expect(makerEntryPrice(0.5, 0.53, 0.01)).toBeCloseTo(0.52, 4);
  });

  it("falls back to the ask when there is no room inside the spread", () => {
    expect(makerEntryPrice(0.55, 0.56, 0.01)).toBe(0.56);
    expect(makerEntryPrice(undefined, 0.56, 0.01)).toBe(0.56);
    expect(makerEntryPrice(0.55, undefined, 0.01)).toBeUndefined();
  });
});

describe("entry economics gates", () => {
  function outcome(featureId: string, d1h: number): AlphaOutcome {
    return {
      id: `${featureId}:${Math.random()}`,
      featureId,
      signalId: "s",
      conditionId: "m",
      direction: "BUY_YES",
      entryMid: 0.5,
      spreadAtSignal: 0.01,
      tradable: true,
      wasProposed: true,
      createdAt: now,
      buckets: { b1h: { drift: d1h, at: now } },
    };
  }

  function input(over: Partial<PolicyInput> = {}): PolicyInput {
    const market = makeMarket();
    const sig: SignalResult = {
      id: "sig1",
      strategy: "price_movement",
      strategyLabel: "Momentum",
      conditionId: market.conditionId,
      direction: "BUY_YES",
      score: 80,
      status: "proposed",
      summary: "test",
      checks: [],
      createdAt: now,
      expiresAt: now + 60_000,
    };
    return {
      signals: [sig],
      markets: new Map([[market.conditionId, market]]),
      regimes: new Map(),
      portfolio: makePortfolio(),
      settings,
      config: { ...DEFAULT_AUTOPILOT, mode: "paper", requireRegimeMatch: false },
      bandit: [],
      managed: [],
      session: { trades: 0, notionalUsd: 0, tradesLastHour: 0 },
      now,
      ...over,
    };
  }

  it("backtest gate blocks strategies with proven-negative replays", () => {
    const out = decideEntries(input({ backtestBlocked: new Set(["price_movement"]) }));
    expect(out.candidates).toHaveLength(0);
    expect(out.skips.some((s) => s.reason.includes("backtest gate"))).toBe(true);
  });

  it("net-economics gate: measured drift must clear THIS market's friction", () => {
    // proven strategy with +0.6c measured drift; market friction is
    // spread/2 (1c) + slippage — 0.6c does not clear it
    const rows = Array.from({ length: 30 }, (_, i) => outcome("price_movement", i < 20 ? 0.012 : -0.006));
    const hr = strategyHitRates(rows);
    expect(hr[0].avgDrift1h).toBeGreaterThan(0);
    const out = decideEntries(input({ hitRates: new Map(hr.map((h) => [h.strategy, h])) }));
    expect(out.candidates).toHaveLength(0);
    expect(out.skips.some((s) => s.reason.includes("net economics"))).toBe(true);
  });

  it("maker entries price inside the spread; taker crosses to the ask", () => {
    const maker = decideEntries(input());
    expect(maker.candidates).toHaveLength(1);
    // makeMarket: bid 0.54 / ask 0.56, tick default 0.01 → posts at 0.55
    expect(maker.candidates[0].proposal.price).toBeCloseTo(0.55, 4);
    const taker = decideEntries(
      input({ config: { ...DEFAULT_AUTOPILOT, mode: "paper", requireRegimeMatch: false, entryStyle: "taker" } }),
    );
    expect(taker.candidates[0].proposal.price).toBeCloseTo(0.56, 4);
  });
});
