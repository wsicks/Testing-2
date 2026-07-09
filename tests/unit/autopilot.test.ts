import { describe, expect, it } from "vitest";
import {
  emptyBandit,
  sampleArms,
  sampleBeta,
  updateBandit,
} from "@/lib/engine/autopilot/bandit";
import { decideEntries, type PolicyInput } from "@/lib/engine/autopilot/policy";
import { evaluateExit } from "@/lib/engine/autopilot/exits";
import { shrunkKelly } from "@/lib/engine/risk/kelly";
import { privateEdgeProfiles } from "@/lib/alpha/privateEdge";
import { mulberry32 } from "@/lib/rng";
import { DEFAULT_AUTOPILOT } from "@/lib/constants";
import type { AlphaOutcome } from "@/lib/alpha/types";
import type { ManagedPosition, SignalResult } from "@/lib/types";
import { makeMarket, makePortfolio, makeSettings } from "../helpers";

const now = Date.now();

function makeSignal(overrides: Partial<SignalResult> = {}): SignalResult {
  return {
    id: "sig1",
    strategy: "dislocation",
    strategyLabel: "Fair-Value Dislocation",
    conditionId: "0xcond1",
    tokenId: "tok-yes",
    marketQuestion: "Will the test market resolve yes?",
    direction: "BUY_YES",
    score: 80,
    status: "proposed",
    summary: "test",
    checks: [],
    createdAt: now,
    expiresAt: now + 600_000,
    meta: { modelWinProb: 0.62 },
    ...overrides,
  };
}

function policyInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  const market = makeMarket();
  return {
    signals: [makeSignal()],
    markets: new Map([[market.conditionId, market]]),
    regimes: new Map([[market.conditionId, "calm"]]),
    portfolio: makePortfolio(),
    settings: makeSettings(),
    config: { ...DEFAULT_AUTOPILOT, mode: "paper", enabledStrategies: ["dislocation"] },
    bandit: sampleArms(emptyBandit(["dislocation"]), mulberry32(1)),
    managed: [],
    session: { trades: 0, notionalUsd: 0, tradesLastHour: 0 },
    now,
    ...overrides,
  };
}

function outcome(overrides: Partial<AlphaOutcome> = {}): AlphaOutcome {
  return {
    id: `out-${Math.random()}`,
    featureId: "dislocation",
    signalId: "sig1",
    conditionId: "0xcond1",
    direction: "BUY_YES",
    entryMid: 0.55,
    spreadAtSignal: 0.01,
    bookAgeMsAtSignal: 5_000,
    tradable: true,
    wasProposed: true,
    createdAt: now,
    buckets: {
      b5m: { drift: 0.03, at: now + 5 * 60_000 },
      b1h: { drift: 0.04, at: now + 60 * 60_000 },
    },
    ...overrides,
  };
}

function privateEdge(rows: AlphaOutcome[]): PolicyInput["privateEdge"] {
  return new Map(privateEdgeProfiles(rows).map((profile) => [profile.strategy, profile]));
}

describe("thompson bandit", () => {
  it("updates Beta posteriors from realized outcomes only", () => {
    const st = emptyBandit(["a", "b"]);
    updateBandit(st, "a", true, 5);
    updateBandit(st, "a", true, 3);
    updateBandit(st, "a", false, -2);
    expect(st.arms.a.alpha).toBe(3); // 1 + 2 wins
    expect(st.arms.a.beta).toBe(2); // 1 + 1 loss
    expect(st.arms.a.realizedPnlUsd).toBeCloseTo(6, 2);
    expect(st.arms.b.alpha).toBe(1); // untouched prior
  });

  it("samples deterministically under a fixed PRNG and within (0,1)", () => {
    const r1 = sampleBeta(3, 2, mulberry32(42));
    const r2 = sampleBeta(3, 2, mulberry32(42));
    expect(r1).toBe(r2);
    expect(r1).toBeGreaterThan(0);
    expect(r1).toBeLessThan(1);
  });

  it("ranks a proven strategy above an unproven one on average", () => {
    const st = emptyBandit(["winner", "loser"]);
    for (let i = 0; i < 15; i++) updateBandit(st, "winner", true, 1);
    for (let i = 0; i < 15; i++) updateBandit(st, "loser", false, -1);
    let winnerFirst = 0;
    for (let s = 0; s < 50; s++) {
      const arms = sampleArms(st, mulberry32(s));
      if (arms[0].strategy === "winner") winnerFirst += 1;
    }
    expect(winnerFirst).toBeGreaterThan(45);
  });
});

describe("uncertainty-shrunk kelly", () => {
  it("sizes tiny with no track record and grows with proof", () => {
    const unproven = shrunkKelly(0.62, 0.5, { wins: 0, losses: 0 }, 0.25, 0.05);
    const proven = shrunkKelly(0.62, 0.5, { wins: 30, losses: 15 }, 0.25, 0.05);
    expect(unproven).toBeGreaterThanOrEqual(0);
    expect(proven).toBeGreaterThan(unproven);
    expect(proven).toBeLessThanOrEqual(0.05);
  });

  it("returns zero without edge", () => {
    expect(shrunkKelly(0.4, 0.5, { wins: 0, losses: 10 }, 0.25, 0.05)).toBe(0);
  });
});

describe("entry policy", () => {
  it("produces a risk-ready proposal from a qualifying signal", () => {
    const { candidates, skips } = decideEntries(policyInput());
    expect(candidates).toHaveLength(1);
    const p = candidates[0].proposal;
    expect(p.side).toBe("BUY");
    expect(p.tokenId).toBe("tok-yes");
    expect(p.winProbability).toBeCloseTo(0.62, 6);
    expect(p.size).toBeGreaterThan(0);
    expect(skips).toHaveLength(0);
  });

  it("skips below the score floor with an explicit reason", () => {
    const { candidates, skips } = decideEntries(
      policyInput({ signals: [makeSignal({ score: 30 })] }),
    );
    expect(candidates).toHaveLength(0);
    expect(skips[0].reason).toContain("below autopilot minimum");
  });

  it("never trades NEUTRAL signals", () => {
    const { candidates } = decideEntries(
      policyInput({ signals: [makeSignal({ direction: "NEUTRAL" })] }),
    );
    expect(candidates).toHaveLength(0);
  });

  it("enforces regime gating", () => {
    const { candidates, skips } = decideEntries(
      policyInput({ regimes: new Map([["0xcond1", "trending"]]) }),
    );
    expect(candidates).toHaveLength(0);
    expect(skips[0].reason).toContain("regime");
  });

  it("halts entries at the open-position cap but reports it", () => {
    const managed: ManagedPosition[] = Array.from({ length: 5 }, (_, i) => ({
      tokenId: `t${i}`,
      strategy: "dislocation",
      mode: "paper",
      entryPrice: 0.5,
      size: 10,
      openedAt: now,
      peakPrice: 0.5,
    }));
    const { candidates, skips } = decideEntries(policyInput({ managed }));
    expect(candidates).toHaveLength(0);
    expect(skips[0].reason).toContain("max open positions");
  });

  it("respects the session notional budget", () => {
    const { candidates, skips } = decideEntries(
      policyInput({ session: { trades: 10, notionalUsd: 499, tradesLastHour: 3 } }),
    );
    expect(candidates).toHaveLength(0);
    expect(skips.some((s) => s.reason.includes("notional budget"))).toBe(true);
  });

  it("buys the NO token for BUY_NO signals at the implied NO ask (taker)", () => {
    const { candidates } = decideEntries(
      policyInput({
        signals: [makeSignal({ direction: "BUY_NO", meta: { modelWinProb: 0.6 } })],
        config: { ...DEFAULT_AUTOPILOT, mode: "paper", enabledStrategies: ["dislocation"], entryStyle: "taker" },
      }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].proposal.tokenId).toBe("tok-no");
    // NO ask = 1 - YES bid = 1 - 0.54
    expect(candidates[0].proposal.price).toBeCloseTo(0.46, 3);
  });

  it("maker BUY_NO posts inside the implied NO spread", () => {
    const { candidates } = decideEntries(
      policyInput({ signals: [makeSignal({ direction: "BUY_NO", meta: { modelWinProb: 0.6 } })] }),
    );
    expect(candidates).toHaveLength(1);
    // implied NO book: bid 1-0.56=0.44, ask 1-0.54=0.46 → posts at 0.45
    expect(candidates[0].proposal.price).toBeCloseTo(0.45, 3);
  });
  it("blocks stale entries when local evidence says the strategy decays quickly", () => {
    const rows = Array.from({ length: 24 }, () =>
      outcome({ buckets: { b5m: { drift: 0.04 }, b1h: { drift: 0.004 } } }),
    );
    const { candidates, skips } = decideEntries(
      policyInput({
        privateEdge: privateEdge(rows),
        signals: [
          makeSignal({
            createdAt: now - 45 * 60_000,
            expiresAt: now + 60_000,
          }),
        ],
      }),
    );

    expect(candidates).toHaveLength(0);
    expect(skips.some((s) => s.reason.includes("private edge stale"))).toBe(true);
  });

  it("uses strong private evidence to re-rank and calibrate model probability", () => {
    const rows = Array.from({ length: 60 }, () => outcome());
    const base = decideEntries(policyInput());
    const withPrivateEdge = decideEntries(policyInput({ privateEdge: privateEdge(rows) }));

    expect(withPrivateEdge.candidates).toHaveLength(1);
    expect(withPrivateEdge.candidates[0].rank).toBeGreaterThan(base.candidates[0].rank);
    expect(withPrivateEdge.candidates[0].proposal.winProbability).toBeGreaterThan(0.62);
  });

  it("blocks entries whose measured private edge cannot clear current friction", () => {
    const rows = Array.from({ length: 24 }, () =>
      outcome({ buckets: { b5m: { drift: 0.025 }, b1h: { drift: 0.02 } } }),
    );
    const market = makeMarket({ spread: 0.08, bestBid: 0.51, bestAsk: 0.59 });
    const { candidates, skips } = decideEntries(
      policyInput({
        markets: new Map([[market.conditionId, market]]),
        privateEdge: privateEdge(rows),
      }),
    );

    expect(candidates).toHaveLength(0);
    expect(skips.some((s) => s.reason.includes("private edge net economics"))).toBe(true);
  });

  it("blocks maker entries when execution intelligence says the fill will not arrive in time", () => {
    const { candidates, skips } = decideEntries(
      policyInput({
        signals: [
          makeSignal({
            meta: {
              modelWinProb: 0.7,
              executionQuality: {
                fillProbability: 0.1,
                expectedWaitMs: 900_000,
                adverseSelectionRisk: 0.2,
                quoteStability: 0.8,
                spoofRisk: 0.1,
                bookPressure: 0.1,
                reasons: ["low_fill_probability"],
              },
            },
          }),
        ],
      }),
    );

    expect(candidates).toHaveLength(0);
    expect(skips.some((s) => s.reason.includes("execution gate"))).toBe(true);
  });
});

describe("exit manager", () => {
  const pos: ManagedPosition = {
    tokenId: "tok-yes",
    strategy: "dislocation",
    mode: "paper",
    entryPrice: 0.5,
    size: 100,
    openedAt: now - 10 * 60_000,
    peakPrice: 0.5,
  };
  const cfg = { ...DEFAULT_AUTOPILOT, targetPct: 12, stopPct: 8, trailPct: 6, maxHoldMin: 240 };

  it("holds inside all thresholds", () => {
    expect(evaluateExit(pos, 0.52, cfg, now).action).toBe("hold");
  });

  it("exits at target", () => {
    const d = evaluateExit(pos, 0.57, cfg, now);
    expect(d.action).toBe("exit");
    expect(d.reason).toBe("target");
  });

  it("exits at hard stop", () => {
    const d = evaluateExit(pos, 0.45, cfg, now);
    expect(d.action).toBe("exit");
    expect(d.reason).toBe("stop");
  });

  it("trails from the peak once in profit", () => {
    const ran = evaluateExit(pos, 0.555, cfg, now); // peak = 0.555 (+11%)
    expect(ran.action).toBe("hold");
    const d = evaluateExit({ ...pos, peakPrice: ran.peakPrice }, 0.515, cfg, now);
    expect(d.action).toBe("exit");
    expect(d.reason).toBe("trail");
  });

  it("time-stops old positions", () => {
    const d = evaluateExit({ ...pos, openedAt: now - 300 * 60_000 }, 0.51, cfg, now);
    expect(d.action).toBe("exit");
    expect(d.reason).toBe("time");
  });

  it("flattens ahead of market close with priority over everything", () => {
    const d = evaluateExit(
      { ...pos, endDate: new Date(now + 10 * 60_000).toISOString() },
      0.57, // would be target — pre-close wins
      { ...cfg, flattenBeforeCloseMin: 30 },
      now,
    );
    expect(d.action).toBe("exit");
    expect(d.reason).toBe("pre_close");
  });
});
