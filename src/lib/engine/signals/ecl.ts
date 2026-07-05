// Strategy 10 — ECL: Entropy Collapse Lag.
//
// Most strategies try to predict the event. ECL trades something narrower:
// moments where a source of truth has ALREADY collapsed the event's
// uncertainty, but the order book hasn't repriced yet — "repricing debt".
//
//   Market still looks uncertain   → H(P_market) high
//   Source says uncertainty is gone → H(P_shadow) low
//   Book hasn't caught up           → edge after ALL costs remains
//
// Shadow probability sources, in priority order:
//   1. Crypto threshold markets — Coinbase spot + realized vol drift-free
//      lognormal model: P = Φ((ln(S/K) − σ²τ/2)/(σ√τ)). Terminal contracts
//      only; touch ("reach/hit/dip") contracts get a shadow only when the
//      touch is PROVABLE from current spot — spot below the level cannot
//      rule out an earlier unobserved touch.
//   2. Cross-venue lag — a rule-comparable partner market (strong_candidate
//      link) whose price has already collapsed toward 0/1 while this one
//      hasn't. Partner venue price is the shadow.
//   3. Scheduled official releases (CPI/Fed/weather) — NOT implemented: no
//      official-release feed is integrated, and pretending otherwise would
//      be exactly the kind of fake edge this app refuses to ship.
//
// Every gate from the spec is an explicit check; failing any gate keeps the
// signal visible but self-rejected. Sizing guidance is deliberately crippled:
// min(10% Kelly, 0.25% of account, depth-limited) with a hard $25 test cap
// until a real sample exists.

import type {
  CryptoThreshold,
  SignalContext,
  SignalResult,
  SignalStrategy,
} from "@/lib/types";
import { parseCryptoThreshold } from "../crossvenue/threshold";
import { resolutionClarity } from "./closingSoon";
import { buildSignal, check } from "./helpers";

export function binaryEntropy(p: number): number {
  const q = Math.max(0.001, Math.min(0.999, p));
  return -q * Math.log(q) - (1 - q) * Math.log(1 - q);
}

function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}

const clip = (p: number) => Math.min(0.99, Math.max(0.01, p));
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** drift-free lognormal P(S_T > K) from spot, daily vol, and days remaining */
export function cryptoShadowProb(
  spot: number,
  threshold: number,
  volDaily: number,
  daysLeft: number,
  direction: CryptoThreshold["direction"],
): number {
  const tau = Math.max(daysLeft, 1e-6);
  const sig = Math.max(volDaily, 1e-6);
  const z = (Math.log(spot / threshold) - 0.5 * sig * sig * tau) / (sig * Math.sqrt(tau));
  const pAbove = normCdf(z);
  return clip(direction === "above" ? pAbove : 1 - pAbove);
}

export interface ShadowEstimate {
  pShadow: number;
  source: string;
  sourceAgeMs: number;
}

function shadowFromContext(ctx: SignalContext): ShadowEstimate | null {
  const { market, reference, crossLinks, relatedMarkets, now } = ctx;

  // 1) crypto threshold + fresh Coinbase reference
  const th = parseCryptoThreshold(market.question, market.endDate);
  if (th && reference?.spot && reference.realizedVolDaily && market.endDate) {
    const daysLeft = (new Date(market.endDate).getTime() - now) / 86_400_000;
    if (daysLeft > 0) {
      if (th.kind === "touch") {
        // A "reach/hit/dip" market settles on the period EXTREME, not the
        // close. Current spot can PROVE the touch happened (spot is beyond
        // the level right now) but can never prove it hasn't — the price may
        // have traded through the level and retraced before this reading.
        // So the only shadow spot can honestly support is the YES side of a
        // provable touch; estimating the NO side needs period high/low
        // candles, which is roadmap work, not something to fake with a
        // terminal-value formula that understates touch probability ~2×.
        const beyond =
          th.direction === "above"
            ? reference.spot >= th.threshold
            : reference.spot <= th.threshold;
        if (!beyond) return null;
        return {
          pShadow: 0.99,
          source: `${reference.spotSource ?? "coinbase"} (spot beyond touch level now)`,
          sourceAgeMs: reference.spotFreshnessMs ?? Infinity,
        };
      }
      return {
        pShadow: cryptoShadowProb(
          reference.spot,
          th.threshold,
          reference.realizedVolDaily,
          daysLeft,
          th.direction,
        ),
        source: reference.spotSource ?? "coinbase",
        sourceAgeMs: reference.spotFreshnessMs ?? Infinity,
      };
    }
  }

  // 2) cross-venue lag: a rule-comparable partner whose price already
  //    collapsed toward certainty while this market still sits in the middle
  const link = (crossLinks ?? []).find(
    (l) =>
      (l.sourceMarketId === market.conditionId || l.targetMarketId === market.conditionId) &&
      l.matchStatus === "strong_candidate",
  );
  if (link) {
    const otherId =
      link.sourceMarketId === market.conditionId ? link.targetMarketId : link.sourceMarketId;
    const other = relatedMarkets?.find((m) => m.conditionId === otherId);
    if (other?.yesPrice !== undefined && (other.yesPrice <= 0.12 || other.yesPrice >= 0.88)) {
      return {
        pShadow: clip(other.yesPrice),
        source: `${other.venueId}:${other.venueTicker ?? other.conditionId}`,
        sourceAgeMs: now - other.fetchedAt,
      };
    }
  }

  return null;
}

/** clarity level → numeric rule-clarity score used by the 0.90 gate */
export function clarityScore(level: "low" | "medium" | "high"): number {
  return level === "high" ? 0.95 : level === "medium" ? 0.8 : 0.4;
}

export const eclSignal: SignalStrategy = {
  id: "ecl",
  label: "Entropy Collapse Lag",
  description:
    "Detects repricing debt: the source of truth has collapsed the event's uncertainty faster than the order book has repriced. Trades the lag, not the prediction.",

  run(ctx: SignalContext): SignalResult | null {
    const { market, book, settings, now } = ctx;
    if (market.outcomeType !== "binary") return null;

    const shadow = shadowFromContext(ctx);
    if (!shadow) return null;
    const pShadow = shadow.pShadow;

    // executable prices: YES ask from the book/market; NO ask via complement
    const yesAsk = book?.bestAsk ?? market.bestAsk;
    const yesBid = book?.bestBid ?? market.bestBid;
    if (yesAsk === undefined || yesBid === undefined) return null;
    const noAsk = 1 - yesBid;
    const spread = Math.max(0.001, yesAsk - yesBid);
    const pMarket = (yesAsk + yesBid) / 2;

    // ── friction: spread half + fees + slippage + latency + ambiguity ──────
    const clarity = resolutionClarity(market.description, market.resolutionSource);
    const ruleClarity = clarityScore(clarity.level);
    const testSizeUsd = Math.min(25, settings.maxTradeUsd);
    const feeCost = settings.feeRateBps / 10_000;
    const slippageCost = settings.slippageBps / 10_000;
    const latencyPenalty = Math.min(0.02, (shadow.sourceAgeMs / 1_000) * 0.005);
    const ambiguityPenalty = Math.min(0.1, 1 - ruleClarity);
    const friction = spread / 2 + feeCost + slippageCost + latencyPenalty + ambiguityPenalty;

    // ── directional edge after cost ─────────────────────────────────────────
    const edgeYes = pShadow - yesAsk - friction;
    const edgeNo = 1 - pShadow - noAsk - friction;
    const direction = edgeYes >= edgeNo ? "BUY_YES" : "BUY_NO";
    const edge = Math.max(edgeYes, edgeNo);
    const entryAsk = direction === "BUY_YES" ? yesAsk : noAsk;
    if (edge <= 0) return null; // no repricing debt at all — stay silent

    // ── entropy gap: market uncertain, shadow certain ───────────────────────
    const entropyGap = binaryEntropy(pMarket) - binaryEntropy(pShadow);

    // ── repricing-debt confirmation ─────────────────────────────────────────
    // The book snapshot must be at least as recent as the source reading:
    // only a book observed AT/AFTER the source's latest data proves the stale
    // price actually survived it. A book older than the source proves nothing
    // — the market may already have repriced since we last looked.
    const marketAgeMs = now - market.fetchedAt;
    const sourceLag = clamp01(0.5 + (shadow.sourceAgeMs - marketAgeMs) / 2_000);

    // ── liquidity: depth at the entry side vs 5× intended test size ────────
    const entryDepthUsd =
      direction === "BUY_YES" ? book?.askDepthUsd : book?.bidDepthUsd;
    const liquidityScore =
      entryDepthUsd !== undefined ? clamp01(entryDepthUsd / (5 * testSizeUsd)) : 0;

    const freshnessScore = clamp01(1 - shadow.sourceAgeMs / 5_000);

    // ── the gates (each explicit; any failure self-rejects) ────────────────
    const checks = [
      check("edge_after_cost", edge >= 0.05,
        `Edge ${(edge * 100).toFixed(1)}c after friction ${(friction * 100).toFixed(1)}c (spread/2 + fees + slippage + latency + ambiguity) vs min 5.0c`,
        edge, 0.05),
      check("entropy_collapse", entropyGap > 0,
        `H(market ${(pMarket * 100).toFixed(0)}%) = ${binaryEntropy(pMarket).toFixed(3)} vs H(shadow ${(pShadow * 100).toFixed(0)}%) = ${binaryEntropy(pShadow).toFixed(3)} — gap ${entropyGap.toFixed(3)} nats`,
        entropyGap, 0),
      check("spread_gate", spread <= 0.025,
        `Spread ${(spread * 100).toFixed(1)}c vs max 2.5c`, spread, 0.025),
      check("source_freshness", shadow.sourceAgeMs <= 1_000,
        `Source (${shadow.source}) is ${(shadow.sourceAgeMs / 1000).toFixed(1)}s old vs max 1.0s for live — paper may proceed with this warning surfaced`,
        shadow.sourceAgeMs / 1000, 1),
      check("rule_clarity", ruleClarity >= 0.9,
        `Rule clarity ${ruleClarity.toFixed(2)} (${clarity.level.toUpperCase()}: ${clarity.reason}) vs min 0.90`,
        ruleClarity, 0.9),
      check("depth_vs_size", liquidityScore >= 0.7,
        entryDepthUsd !== undefined
          ? `Entry-side depth $${Math.round(entryDepthUsd).toLocaleString()} vs 5× test size $${(5 * testSizeUsd).toFixed(0)}`
          : "No order book loaded — depth unverifiable",
        liquidityScore, 0.7),
      check("market_not_repriced", sourceLag >= 0.25,
        `Lag score ${sourceLag.toFixed(2)}: book snapshot ${(marketAgeMs / 1000).toFixed(1)}s old vs source ${(shadow.sourceAgeMs / 1000).toFixed(1)}s old — the book must be observed at/after the source's latest data to confirm the stale price survived it`,
        sourceLag, 0.25),
    ];

    // ── ECL score (per spec, clamped into the 0–100 signal scale) ──────────
    const rawScore =
      (100 * edge * entropyGap * sourceLag * liquidityScore * ruleClarity * Math.max(freshnessScore, 0.1)) /
      Math.max(spread, 0.01);
    const score = Math.min(100, rawScore);

    // ── crippled sizing: min(10% Kelly, 0.25% of account, depth-limited) ───
    const kellyFraction = (pShadow - entryAsk) / Math.max(0.01, 1 - entryAsk);
    const suggestedTestUsd = Math.max(
      0,
      Math.min(0.1 * kellyFraction * 10_000, 25, testSizeUsd, (entryDepthUsd ?? 0) / 5),
    );

    // mechanical exit plan (displayed + stored; execution remains manual or
    // via autopilot's target/stop approximation)
    const partialExit = entryAsk + 0.6 * edge;
    const fullExit = entryAsk + 0.85 * edge;

    return buildSignal({
      strategy: this.id,
      strategyLabel: this.label,
      market,
      direction,
      score,
      summary: `REPRICING DEBT: shadow ${(pShadow * 100).toFixed(0)}% (${shadow.source}) vs market ${(pMarket * 100).toFixed(0)}% — ${(edge * 100).toFixed(1)}c edge after all costs, entropy gap ${entropyGap.toFixed(2)} nats`,
      checks,
      now,
      ttlMs: 3 * 60_000, // this edge exists for minutes, not hours
      meta: {
        pShadow,
        pMarket,
        shadowSource: shadow.source,
        sourceAgeMs: shadow.sourceAgeMs,
        entropyGap,
        sourceLag,
        edgeAfterCost: edge,
        friction,
        spread,
        ruleClarity,
        liquidityScore,
        freshnessScore,
        eclScoreRaw: rawScore,
        suggestedTestUsd: Number(suggestedTestUsd.toFixed(2)),
        modelWinProb: direction === "BUY_YES" ? pShadow : 1 - pShadow,
        exitPlan: {
          entry: entryAsk,
          partialExitAt: Number(partialExit.toFixed(3)),
          fullExitAt: Number(fullExit.toFixed(3)),
          invalidateIfShadowBelow: direction === "BUY_YES" ? 0.6 : undefined,
          invalidateIfShadowAbove: direction === "BUY_NO" ? 0.4 : undefined,
          rule: "exit 50% at 60% edge capture, rest at 85%; kill on shadow invalidation, source contradiction, or spread > remaining edge",
        },
      },
    });
  },
};
