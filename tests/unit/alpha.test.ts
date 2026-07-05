import { describe, expect, it } from "vitest";
import {
  alphaScore,
  assessMimic,
  capitalLockupCost,
  categorizeMarket,
  decayCurve,
  decayVerdict,
  durationBucket,
  labelWallet,
  rejectCandidate,
  roiWithoutBestTrade,
  skillForDimension,
  summarizeEvidence,
  walletCandidateScore,
  type ClosedPositionLite,
} from "@/lib/alpha/score";
import type { AlphaOutcome, WalletMarketEntry } from "@/lib/alpha/types";
import { DEFAULT_ALPHA } from "@/lib/constants";
import { prosecute } from "@/server/alpha/prosecutor";
import { seedSourceRecords } from "@/lib/alpha/sources.seed";
import { walletShadowSignal } from "@/lib/engine/signals/walletShadow";
import { walletFadeSignal } from "@/lib/engine/signals/walletFade";
import { deadlineCurvatureSignal } from "@/lib/engine/signals/deadlineCurvature";
import { makeBook, makeMarket, makeSettings } from "../helpers";

const now = Date.now();
const settings = makeSettings();

// ── category taxonomy ────────────────────────────────────────────────────────

describe("market categorization", () => {
  it("maps questions to canonical categories", () => {
    expect(categorizeMarket({ question: "Will Bitcoin be above $100k?" })).toBe("crypto");
    expect(categorizeMarket({ question: "Will the Fed cut rates in September?" })).toBe("fed_rates");
    expect(categorizeMarket({ question: "Will Spain win the World Cup?" })).toBe("sports");
    expect(categorizeMarket({ question: "Will the Supreme Court ruling favor X?" })).toBe("courts");
    expect(categorizeMarket({ question: "Something entirely else?" })).toBe("other");
  });

  it("buckets duration", () => {
    expect(durationBucket(now + 86_400_000, now)).toBe("dur:closing");
    expect(durationBucket(now + 5 * 86_400_000, now)).toBe("dur:short");
    expect(durationBucket(now + 60 * 86_400_000, now)).toBe("dur:long");
    expect(durationBucket(undefined, now)).toBe("dur:unknown");
  });
});

// ── wallet skill math ────────────────────────────────────────────────────────

function pos(pnl: number, invested: number, i: number): ClosedPositionLite {
  return {
    pnl,
    initialValue: invested,
    shares: invested / 0.5,
    win: pnl > 0,
    closedAt: now - i * 86_400_000,
    dimensions: ["cat:crypto", "dur:short", "liq:mid"],
  };
}

describe("wallet skill scoring", () => {
  const winners = Array.from({ length: 30 }, (_, i) => pos(i % 3 === 0 ? -8 : 14, 50, i));

  it("computes cost-adjusted category skill with sample size", () => {
    const s = skillForDimension("cat:crypto", winners);
    expect(s.sampleSize).toBe(30);
    expect(s.costAdjRoi).toBeLessThan(s.rawRoi); // costs always subtract
    expect(s.costAdjRoi).toBeGreaterThan(0);
    expect(s.winRate).toBeCloseTo(20 / 30, 2);
    expect(s.profitFactor).toBeGreaterThan(1);
  });

  it("flags lucky wallets whose edge is one trade", () => {
    const lucky = [pos(500, 50, 0), ...Array.from({ length: 25 }, (_, i) => pos(-2, 50, i + 1))];
    const s = skillForDimension("cat:crypto", lucky);
    expect(s.luckyConcentration).toBeGreaterThan(0.9);
    expect(roiWithoutBestTrade(lucky)).toBeLessThan(0);
  });

  it("labels a consistent specialist and rejects a lucky outlier", () => {
    const base = {
      avgEntryNotional: 50,
      extremePriceShare: 0.1,
      fastRoundTripShare: 0,
      shortDurationShare: 0.4,
      forward: undefined,
    };
    const specialist = labelWallet({
      ...base,
      totalClosed: 30,
      costAdjTotalRoi: 0.12,
      dimensions: [skillForDimension("cat:crypto", winners)],
      roiWithoutBest: 0.08,
    });
    expect(specialist.primary).toBe("smart_specialist");

    const lucky = [pos(500, 50, 0), ...Array.from({ length: 25 }, (_, i) => pos(-2, 50, i + 1))];
    const outlier = labelWallet({
      ...base,
      totalClosed: 26,
      costAdjTotalRoi: 0.2,
      dimensions: [skillForDimension("cat:crypto", lucky)],
      roiWithoutBest: roiWithoutBestTrade(lucky),
    });
    expect(outlier.primary).toBe("lucky_outlier");
  });

  it("applies the spec's discovery rejection rules", () => {
    const small = skillForDimension("cat:crypto", winners.slice(0, 10));
    expect(
      rejectCandidate({
        bestDim: small, totalClosed: 10, luckyConcentration: 0.2,
        roiWithoutBest: 0.05, forward: undefined, unrealizedShare: 0.1,
        illiquidShare: 0, costAdjTotalRoi: 0.1, rawTotalRoi: 0.12, daysSinceLastTrade: 2,
      }),
    ).toContain("fewer than 20");
    expect(
      rejectCandidate({
        bestDim: skillForDimension("cat:crypto", winners), totalClosed: 30,
        luckyConcentration: 0.2, roiWithoutBest: 0.05,
        forward: { samples: 15, avgDrift1h: -0.01, avgDrift5s: 0, updatedAt: now },
        unrealizedShare: 0.1, illiquidShare: 0, costAdjTotalRoi: 0.1,
        rawTotalRoi: 0.12, daysSinceLastTrade: 2,
      }),
    ).toContain("forward return is negative");
    expect(
      rejectCandidate({
        bestDim: skillForDimension("cat:crypto", winners), totalClosed: 30,
        luckyConcentration: 0.2, roiWithoutBest: 0.05, forward: undefined,
        unrealizedShare: 0.1, illiquidShare: 0, costAdjTotalRoi: -0.01,
        rawTotalRoi: 0.05, daysSinceLastTrade: 2,
      }),
    ).toContain("before realistic cost");
    expect(
      rejectCandidate({
        bestDim: skillForDimension("cat:crypto", winners), totalClosed: 30,
        luckyConcentration: 0.2, roiWithoutBest: 0.05, forward: undefined,
        unrealizedShare: 0.1, illiquidShare: 0, costAdjTotalRoi: 0.08,
        rawTotalRoi: 0.1, daysSinceLastTrade: 2,
      }),
    ).toBeNull();
    expect(
      walletCandidateScore({
        bestDim: skillForDimension("cat:crypto", winners),
        capitalEfficiency: 0.1, luckyConcentration: 0.1, crowding: 0, slippagePenaltyShare: 0.2,
      }),
    ).toBeGreaterThan(0);
  });
});

// ── mimicability ─────────────────────────────────────────────────────────────

function entry(overrides: Partial<WalletMarketEntry> = {}): WalletMarketEntry {
  return {
    walletId: "0xabc",
    displayName: "Test-Wallet",
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
    forward: { samples: 15, avgDrift1h: 0.03, avgDrift5s: 0.002, updatedAt: now },
    ...overrides,
  };
}

describe("mimicability", () => {
  const base = {
    currentPrice: 0.56,
    spread: 0.02,
    entrySideDepthUsd: 800,
    ruleClarity: 0.95,
    crowdSameSide: 1,
    minutesToClose: 60 * 24,
    alpha: DEFAULT_ALPHA,
    feeRateBps: 0,
    slippageBps: 50,
    now,
  };

  it("recommends copy on clean setups and confirm-only on marginal ones", () => {
    // no drift consumed: 3c measured edge − 1.5c friction = 1.5c net → copy
    const clean = assessMimic({ entry: entry(), ...base, currentPrice: 0.55 });
    expect(clean.blocks).toHaveLength(0);
    expect(clean.recommendation).toBe("copy");
    expect(clean.maxSizeUsd).toBeLessThanOrEqual(25);
    // 1c drift already consumed → net edge ~0.5c → confirmation only
    const marginal = assessMimic({ entry: entry(), ...base });
    expect(marginal.blocks).toHaveLength(0);
    expect(marginal.recommendation).toBe("confirm_only");
  });

  it("blocks on >2c drift from wallet entry", () => {
    const a = assessMimic({ entry: entry(), ...base, currentPrice: 0.59 });
    expect(a.blocks.map((b) => b.reason)).toContain("price_drift");
    expect(a.recommendation).toBe("block");
  });

  it("blocks without forward evidence — no honest edge estimate exists", () => {
    const a = assessMimic({ entry: entry({ forward: undefined }), ...base });
    expect(a.blocks.map((b) => b.reason)).toContain("forward_evidence");
  });

  it("blocks when the wallet started exiting", () => {
    const a = assessMimic({ entry: entry({ exiting: true }), ...base });
    expect(a.blocks.map((b) => b.reason)).toContain("wallet_exiting");
  });

  it("blocks near close and on unclear rules", () => {
    const a = assessMimic({ entry: entry(), ...base, minutesToClose: 20, ruleClarity: 0.4 });
    const reasons = a.blocks.map((b) => b.reason);
    expect(reasons).toContain("close_too_near");
    expect(reasons).toContain("rule_clarity");
  });

  it("capital lockup grows with time to settlement", () => {
    expect(capitalLockupCost(365)).toBeCloseTo(0.1, 5);
    expect(capitalLockupCost(0)).toBe(0);
  });
});

// ── decay curves + alpha score + prosecutor ──────────────────────────────────

function outcome(i: number, drift1h: number, opts: Partial<AlphaOutcome> = {}): AlphaOutcome {
  return {
    id: `o${i}`,
    featureId: "test_feature",
    signalId: `s${i}`,
    conditionId: `0xm${i % 20}`,
    direction: "BUY_YES",
    entryMid: 0.5,
    spreadAtSignal: 0.02,
    bookAgeMsAtSignal: 1_000,
    tradable: true,
    wasProposed: true,
    createdAt: now - i * 3 * 60 * 60_000, // spread over days
    buckets: {
      b5s: { drift: drift1h * 0.1, at: now },
      b30s: { drift: drift1h * 0.3, at: now },
      b5m: { drift: drift1h * 0.6, at: now },
      b1h: { drift: drift1h, at: now },
      b24h: { drift: drift1h * 1.1, at: now },
    },
    ...opts,
  };
}

describe("evidence, alpha score and prosecutor", () => {
  const good = Array.from({ length: 120 }, (_, i) => outcome(i, i % 4 === 3 ? -0.01 : 0.04));

  it("summarizes evidence and computes decay curves", () => {
    const ev = summarizeEvidence("test_feature", good);
    expect(ev.outcomes).toBe(120);
    expect(ev.tradableOutcomes).toBe(120);
    expect(ev.distinctDays).toBeGreaterThanOrEqual(7);
    const curve = decayCurve(good);
    const b1h = curve.find((c) => c.bucket === "b1h")!;
    expect(b1h.n).toBe(120);
    expect(b1h.avgDrift).toBeGreaterThan(0.02);
  });

  it("returns null alpha score without enough evidence", () => {
    const ev = summarizeEvidence("test_feature", good.slice(0, 5));
    expect(alphaScore(ev, { sourceReliability: 0.8 })).toBeNull();
  });

  it("scores evidenced features and penalizes unreliable sources", () => {
    const ev = summarizeEvidence("test_feature", good);
    const a = alphaScore(ev, { sourceReliability: 0.9 })!;
    const b = alphaScore(ev, { sourceReliability: 0.2 })!;
    expect(a.score).toBeGreaterThan(0);
    expect(b.score).toBeLessThan(a.score);
  });

  it("prosecutor passes a robust feature and blocks a lucky one", () => {
    const feature = {
      id: "test_feature", name: "Test", thesis: "t", dataSources: ["polymarket_clob"],
      categoryScope: ["all"], status: "paper_testing" as const, killCriteria: "k",
      createdAt: now, updatedAt: now,
    };
    const sources = seedSourceRecords(now);
    const pass = prosecute({
      feature,
      evidence: summarizeEvidence("test_feature", good),
      recentEvidence: summarizeEvidence("test_feature", good.slice(0, 30)),
      sources, slippageBps: 50, maxSpread: 0.03,
    });
    expect(pass.passed).toBe(true);

    // one huge outcome, everything else flat-negative → lucky concentration
    const lucky = [
      outcome(0, 0.5),
      ...Array.from({ length: 119 }, (_, i) => outcome(i + 1, -0.001)),
    ];
    const fail = prosecute({
      feature,
      evidence: summarizeEvidence("test_feature", lucky),
      recentEvidence: summarizeEvidence("test_feature", lucky.slice(0, 30)),
      sources, slippageBps: 50, maxSpread: 0.03,
    });
    expect(fail.passed).toBe(false);
    expect(fail.tests.find((t) => t.name === "lucky_trade_concentration")?.passed).toBe(false);
  });

  it("prosecutor blocks features on banned/manual-review sources", () => {
    const feature = {
      id: "test_feature", name: "Test", thesis: "t", dataSources: ["house_disclosures"],
      categoryScope: ["politics"], status: "paper_testing" as const, killCriteria: "k",
      createdAt: now, updatedAt: now,
    };
    const v = prosecute({
      feature,
      evidence: summarizeEvidence("test_feature", good),
      recentEvidence: summarizeEvidence("test_feature", good.slice(0, 30)),
      sources: seedSourceRecords(now), slippageBps: 50, maxSpread: 0.03,
    });
    expect(v.tests.find((t) => t.name === "source_terms_review")?.passed).toBe(false);
    expect(v.passed).toBe(false);
  });

  it("detects decay: recent edge collapse vs lifetime", () => {
    const lifetime = summarizeEvidence("test_feature", good);
    const flat = good.slice(0, 30).map((o, i) =>
      outcome(i, 0.001, { id: `r${i}` }),
    );
    const verdict = decayVerdict(lifetime, summarizeEvidence("test_feature", flat));
    expect(verdict.decayed).toBe(true);
  });
});

// ── wallet strategies ────────────────────────────────────────────────────────

describe("wallet shadow strategy", () => {
  const market = makeMarket({ question: "Will Bitcoin be above $100,000 on December 31?" });
  const book = makeBook();

  it("returns null without wallet intel", () => {
    expect(walletShadowSignal.run({ market, book, settings, now, alpha: DEFAULT_ALPHA })).toBeNull();
  });

  it("proposes a follow when every gate passes", () => {
    const sig = walletShadowSignal.run({
      market, book, settings, now, alpha: DEFAULT_ALPHA,
      walletIntel: {
        entries: [entry({ avgEntryPrice: 0.55, dimensionSkill: entry().dimensionSkill })],
        crowdSameSide: 1,
        updatedAt: now - 60_000,
      },
    });
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("BUY_YES");
    expect(sig!.status).toBe("proposed");
    expect(sig!.meta?.walletId).toBe("0xabc");
    expect(sig!.meta?.suggestedTestUsd as number).toBeLessThanOrEqual(25);
  });

  it("self-rejects without forward evidence (cold start is honest)", () => {
    const sig = walletShadowSignal.run({
      market, book, settings, now, alpha: DEFAULT_ALPHA,
      walletIntel: {
        entries: [entry({ forward: undefined })],
        crowdSameSide: 1,
        updatedAt: now - 60_000,
      },
    });
    expect(sig).not.toBeNull();
    expect(sig!.status).toBe("rejected");
    expect(sig!.checks.find((c) => c.name === "forward_evidence")?.passed).toBe(false);
  });

  it("goes NEUTRAL when proven specialists disagree", () => {
    const sig = walletShadowSignal.run({
      market, book, settings, now, alpha: DEFAULT_ALPHA,
      walletIntel: {
        entries: [
          entry({ side: "YES" }),
          entry({ walletId: "0xdef", side: "NO" }),
        ],
        crowdSameSide: 1,
        updatedAt: now - 60_000,
      },
    });
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("NEUTRAL");
    expect(sig!.meta?.signalType).toBe("smart_wallet_divergence");
  });

  it("self-rejects on stale wallet intel", () => {
    const sig = walletShadowSignal.run({
      market, book, settings, now, alpha: DEFAULT_ALPHA,
      walletIntel: {
        entries: [entry()],
        crowdSameSide: 1,
        updatedAt: now - 30 * 60_000,
      },
    });
    expect(sig!.checks.find((c) => c.name === "intel_freshness")?.passed).toBe(false);
    expect(sig!.status).toBe("rejected");
  });
});

describe("wallet fade strategy", () => {
  const market = makeMarket();
  const book = makeBook();

  it("fades a measured-toxic wallet with evidence", () => {
    const sig = walletFadeSignal.run({
      market, book, settings, now, alpha: DEFAULT_ALPHA,
      walletIntel: {
        entries: [
          entry({
            label: "fade_candidate",
            side: "YES",
            dimensionSkill: undefined,
            forward: { samples: 20, avgDrift1h: -0.04, avgDrift5s: 0, updatedAt: now },
          }),
        ],
        crowdSameSide: 1,
        updatedAt: now - 60_000,
      },
    });
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("BUY_NO"); // opposite of the toxic wallet's YES
    expect(sig!.checks.find((c) => c.name === "fade_evidence")?.passed).toBe(true);
  });

  it("emits a NEUTRAL exit warning when a proven wallet is leaving", () => {
    const sig = walletFadeSignal.run({
      market, book, settings, now, alpha: DEFAULT_ALPHA,
      walletIntel: {
        entries: [entry({ exiting: true })],
        crowdSameSide: 1,
        updatedAt: now - 60_000,
      },
    });
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("NEUTRAL");
    expect(sig!.meta?.signalType).toBe("smart_wallet_exit_warning");
    expect(sig!.status).toBe("rejected"); // advisory only — never executable
  });
});

describe("deadline curvature strategy", () => {
  it("flags a linearly-priced terminal market near the deadline", () => {
    const market = makeMarket({
      question: "Will BTC be above $100,000 on July 12?",
      endDate: new Date(now + 3 * 86_400_000).toISOString(),
      midpoint: 0.5,
      bestBid: 0.49,
      bestAsk: 0.51,
    });
    const history = Array.from({ length: 10 }, (_, i) => ({
      t: Math.floor((now - (10 - i) * 3_600_000) / 1000),
      p: 0.5 + i * 0.001, // near-linear path
    }));
    const sig = deadlineCurvatureSignal.run({
      market,
      book: makeBook({ midpoint: 0.5, bestBid: 0.49, bestAsk: 0.51, spread: 0.02 }),
      history,
      reference: { spot: 108_000, spotSource: "coinbase:BTC-USD", spotFreshnessMs: 900, realizedVolDaily: 0.02 },
      settings,
      now,
    });
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("NEUTRAL");
    expect(sig!.status).toBe("rejected"); // model_assumptions always fails → review
    expect(sig!.meta?.modelProbNow as number).toBeGreaterThan(0.9);
  });

  it("ignores touch contracts and far deadlines", () => {
    const touch = makeMarket({
      question: "Will BTC reach $150,000 in 2026?",
      endDate: new Date(now + 3 * 86_400_000).toISOString(),
    });
    expect(
      deadlineCurvatureSignal.run({
        market: touch,
        reference: { spot: 108_000, realizedVolDaily: 0.02 },
        settings, now,
      }),
    ).toBeNull();
    const far = makeMarket({
      question: "Will BTC be above $100,000 on December 31?",
      endDate: new Date(now + 90 * 86_400_000).toISOString(),
    });
    expect(
      deadlineCurvatureSignal.run({
        market: far,
        reference: { spot: 108_000, realizedVolDaily: 0.02 },
        settings, now,
      }),
    ).toBeNull();
  });
});

// ── source registry seeds ────────────────────────────────────────────────────

describe("source registry seeds", () => {
  const sources = seedSourceRecords(now);

  it("covers every spec category and stays honest about status", () => {
    const cats = new Set(sources.map((s) => s.category));
    for (const c of ["prediction_markets", "crypto", "macro", "politics_regulation", "weather_climate", "news_events", "sports"]) {
      expect(cats.has(c as never)).toBe(true);
    }
    // sports must be unavailable (no permitted source), never scraped
    expect(sources.find((s) => s.category === "sports")?.status).toBe("unavailable");
    // congressional disclosures must be manual_review (no structured API)
    expect(sources.find((s) => s.sourceId === "house_disclosures")?.status).toBe("manual_review");
    // key-required sources are disabled until configured, with the env var named
    const fred = sources.find((s) => s.sourceId === "fred")!;
    expect(fred.status).toBe("disabled");
    expect(fred.apiKeyEnvVar).toBe("FRED_API_KEY");
    // every source has a terms review stamp and an allowed-use statement
    for (const s of sources) {
      expect(s.lastTermsReview).toBe(now);
      expect(s.allowedUse.length).toBeGreaterThan(10);
    }
  });
});
