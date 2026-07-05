// Alpha Foundry scoring math — pure functions, no I/O.
//
// Every score here is derived from measured inputs and returns its components
// so the UI and the Alpha Prosecutor can show WHY, not just a number. Cost
// adjustments use explicit, conservative estimates (labeled as estimates)
// because historical per-trade spread/slippage is not observable from the
// public position feed.

import type {
  AlphaFeature,
  AlphaOutcome,
  DecayBucketKey,
  DecayCurvePoint,
  DimensionSkill,
  FeatureEvidence,
  ForwardEvidence,
  MimicAssessment,
  MimicBlock,
  WalletLabel,
  WalletMarketEntry,
} from "./types";
import type { AlphaSettings } from "./types";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// ── Category taxonomy ────────────────────────────────────────────────────────

const CATEGORY_RULES: { key: string; re: RegExp }[] = [
  { key: "elections", re: /\belection|primary|presidential race|senate race|governor|mayor(al)?|ballot|nominee\b/i },
  { key: "fed_rates", re: /\bfed\b|fomc|interest rate|rate (cut|hike)|powell|basis points/i },
  { key: "macro", re: /inflation|cpi|gdp|jobs report|unemployment|recession|tariff|payroll|treasury yield|debt ceiling/i },
  { key: "crypto", re: /crypto|bitcoin|\bbtc\b|ethereum|\beth\b|solana|\bsol\b|dogecoin|\bxrp\b|blockchain|defi|stablecoin/i },
  { key: "weather", re: /weather|hurricane|temperature|rainfall|snowfall|storm|tornado|heat wave|drought/i },
  { key: "sports", re: /\bnba\b|\bnfl\b|\bmlb\b|\bnhl\b|soccer|football|tennis|golf|\bufc\b|boxing|olympic|\bf1\b|grand prix|counter-strike|esports?|league of legends|dota|valorant|premier league|champions league|world cup|super bowl|playoff/i },
  { key: "courts", re: /court|scotus|supreme|ruling|verdict|trial|lawsuit|judge|indicted?|conviction|appeal/i },
  { key: "geopolitics", re: /\bwar\b|ukraine|russia|china|israel|iran|nato|ceasefire|invasion|north korea|sanction/i },
  { key: "ai_tech", re: /\bai\b|artificial intelligence|openai|anthropic|gpt|apple|google|microsoft|nvidia|spacex|tesla|semiconductor|iphone/i },
  { key: "entertainment", re: /movie|film|oscar|grammy|box office|album|billboard|celebrit|netflix|tv series|taylor swift/i },
  { key: "politics", re: /politic|congress|\bbill\b|senate|house of representatives|government|shutdown|impeach|cabinet|executive order|veto|legislation/i },
];

/** canonical alpha category for a market (question + category + tags) */
export function categorizeMarket(args: {
  question?: string;
  category?: string;
  tags?: string[];
}): string {
  const hay = [args.question ?? "", args.category ?? "", ...(args.tags ?? [])].join(" ");
  for (const rule of CATEGORY_RULES) if (rule.re.test(hay)) return rule.key;
  return "other";
}

export function durationBucket(closeTimeMs: number | undefined, refMs: number): string {
  if (closeTimeMs === undefined) return "dur:unknown";
  const days = (closeTimeMs - refMs) / 86_400_000;
  if (days <= 2) return "dur:closing";
  if (days <= 7) return "dur:short";
  if (days <= 30) return "dur:mid";
  return "dur:long";
}

export function liquidityBucket(liquidityUsd: number | undefined): string {
  if (liquidityUsd === undefined) return "liq:unknown";
  if (liquidityUsd < 10_000) return "liq:low";
  if (liquidityUsd < 100_000) return "liq:mid";
  return "liq:high";
}

// ── Wallet skill from closed positions ───────────────────────────────────────

export interface ClosedPositionLite {
  pnl: number; // cashPnl (USD)
  initialValue: number; // entry notional (USD)
  shares: number; // totalBought
  win: boolean;
  /** epoch ms of market close (ordering proxy for drawdown sequencing) */
  closedAt?: number;
  dimensions: string[]; // ["cat:crypto", "dur:short", "liq:low"]
}

/**
 * conservative round-trip cost estimate: 1.5c/share (≈ two spread crossings)
 * — explicit and shown to the user; NOT a claim about actual fills.
 */
export const EST_ROUNDTRIP_COST_PER_SHARE = 0.015;

export function skillForDimension(
  dimension: string,
  positions: ClosedPositionLite[],
): DimensionSkill {
  const rows = positions.filter((p) => p.dimensions.includes(dimension));
  const n = rows.length;
  if (n === 0) {
    return {
      dimension, sampleSize: 0, costAdjRoi: 0, rawRoi: 0, winRate: 0,
      profitFactor: 0, avgWin: 0, avgLoss: 0, maxDrawdown: 0,
      luckyConcentration: 0, capitalEfficiency: 0, confidence: 0,
    };
  }
  const invested = rows.reduce((a, p) => a + p.initialValue, 0);
  const gross = rows.reduce((a, p) => a + p.pnl, 0);
  const cost = rows.reduce((a, p) => a + p.shares * EST_ROUNDTRIP_COST_PER_SHARE, 0);
  const net = gross - cost;
  const wins = rows.filter((p) => p.win);
  const losses = rows.filter((p) => !p.win);
  const grossWins = wins.reduce((a, p) => a + p.pnl, 0);
  const grossLosses = Math.abs(losses.reduce((a, p) => a + p.pnl, 0));
  const bestPnl = Math.max(0, ...rows.map((p) => p.pnl));
  // drawdown over the pnl sequence ordered by close time
  const ordered = [...rows].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  let equity = 0, peak = 0, maxDd = 0;
  for (const p of ordered) {
    equity += p.pnl;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  const lucky = net > 0 ? clamp01(bestPnl / Math.max(net, 1e-9)) : bestPnl > 0 ? 1 : 0;
  return {
    dimension,
    sampleSize: n,
    costAdjRoi: invested > 0 ? net / invested : 0,
    rawRoi: invested > 0 ? gross / invested : 0,
    winRate: n > 0 ? wins.length / n : 0,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 99 : 0,
    avgWin: wins.length ? grossWins / wins.length : 0,
    avgLoss: losses.length ? grossLosses / losses.length : 0,
    maxDrawdown: maxDd,
    luckyConcentration: lucky,
    capitalEfficiency: invested > 0 ? gross / invested : 0,
    confidence: clamp01((n - 5) / 35) * (1 - 0.5 * lucky),
  };
}

/**
 * survives-one-lucky-trade check: recompute cost-adjusted ROI with the single
 * best trade removed. A wallet whose edge disappears is a lucky outlier.
 */
export function roiWithoutBestTrade(positions: ClosedPositionLite[]): number {
  if (positions.length < 2) return 0;
  const best = positions.reduce((a, b) => (b.pnl > a.pnl ? b : a));
  const rest = positions.filter((p) => p !== best);
  const invested = rest.reduce((a, p) => a + p.initialValue, 0);
  const net = rest.reduce(
    (a, p) => a + p.pnl - p.shares * EST_ROUNDTRIP_COST_PER_SHARE,
    0,
  );
  return invested > 0 ? net / invested : 0;
}

// ── Labels ───────────────────────────────────────────────────────────────────

export interface LabelInputs {
  totalClosed: number;
  costAdjTotalRoi: number;
  dimensions: DimensionSkill[];
  avgEntryNotional: number;
  /** share of entries at ≤10c or ≥90c */
  extremePriceShare: number;
  /** share of markets where the wallet traded BOTH sides within minutes */
  fastRoundTripShare: number;
  roiWithoutBest: number;
  forward?: ForwardEvidence;
  /** share of closed positions in dur:closing/dur:short */
  shortDurationShare: number;
}

export function labelWallet(x: LabelInputs): { primary: WalletLabel; all: WalletLabel[] } {
  const all: WalletLabel[] = [];
  const bestDim = [...x.dimensions]
    .filter((d) => d.sampleSize >= 20)
    .sort((a, b) => b.costAdjRoi - a.costAdjRoi)[0];
  const positiveDims = x.dimensions.filter(
    (d) => d.sampleSize >= 20 && d.costAdjRoi > 0.03,
  );

  if (x.totalClosed < 20) all.push("low_sample_unknown");
  if (x.fastRoundTripShare > 0.3) all.push("likely_market_maker");
  if (x.fastRoundTripShare > 0.5 && Math.abs(x.costAdjTotalRoi) < 0.01)
    all.push("possible_wash_noise");
  if (x.totalClosed >= 20 && x.costAdjTotalRoi > 0.05 && x.roiWithoutBest <= 0)
    all.push("lucky_outlier");
  if (x.avgEntryNotional > 2_000 && x.totalClosed >= 20 && x.costAdjTotalRoi <= 0)
    all.push("whale_not_smart");
  if (x.extremePriceShare > 0.5 && x.costAdjTotalRoi < 0) all.push("high_risk_gambler");
  if (
    bestDim && bestDim.costAdjRoi > 0.08 && bestDim.luckyConcentration < 0.5 &&
    x.roiWithoutBest > 0 && !all.includes("lucky_outlier")
  )
    all.push("smart_specialist");
  if (positiveDims.length >= 3 && x.totalClosed >= 60 && x.costAdjTotalRoi > 0.05)
    all.push("broad_smart_wallet");
  if (x.shortDurationShare > 0.5 && x.costAdjTotalRoi > 0.05 && x.totalClosed >= 20)
    all.push("closing_market_sniper");
  if (
    x.totalClosed >= 20 &&
    (x.costAdjTotalRoi < -0.1 || (x.forward && x.forward.samples >= 10 && x.forward.avgDrift1h < -0.01))
  )
    all.push("fade_candidate");
  if (all.length === 0) all.push("ignore");

  const priority: WalletLabel[] = [
    "possible_wash_noise", "likely_market_maker", "lucky_outlier",
    "smart_specialist", "broad_smart_wallet", "closing_market_sniper",
    "fade_candidate", "whale_not_smart", "high_risk_gambler",
    "low_sample_unknown", "ignore",
  ];
  const primary = priority.find((p) => all.includes(p)) ?? "ignore";
  return { primary, all };
}

// ── Discovery candidate score ────────────────────────────────────────────────

export function walletCandidateScore(x: {
  bestDim?: DimensionSkill;
  capitalEfficiency: number;
  luckyConcentration: number;
  crowding: number; // 0–1 estimated crowd-following on this wallet
  slippagePenaltyShare: number; // edge share lost to estimated costs
}): number {
  if (!x.bestDim || x.bestDim.sampleSize < 20) return 0;
  const categoryRoi = Math.max(0, x.bestDim.costAdjRoi);
  const sampleQuality = clamp01((x.bestDim.sampleSize - 20) / 60 + 0.3);
  const capEff = clamp01(0.5 + x.capitalEfficiency);
  const lucky = 1 + 2 * x.luckyConcentration;
  const crowd = 1 + x.crowding;
  const slip = 1 + x.slippagePenaltyShare;
  return (100 * categoryRoi * sampleQuality * capEff) / (lucky * crowd * slip);
}

/** discovery hard rejections from the spec — returns the reason or null */
export function rejectCandidate(x: {
  bestDim?: DimensionSkill;
  totalClosed: number;
  luckyConcentration: number;
  roiWithoutBest: number;
  forward?: ForwardEvidence;
  unrealizedShare: number;
  illiquidShare: number;
  costAdjTotalRoi: number;
  rawTotalRoi: number;
  daysSinceLastTrade: number;
}): string | null {
  if (!x.bestDim || x.bestDim.sampleSize < 20)
    return "fewer than 20 closed trades in any category";
  if (x.luckyConcentration > 0.5)
    return "one trade explains more than 50% of profit";
  if (x.forward && x.forward.samples >= 10 && x.forward.avgDrift1h <= 0)
    return "copyable forward return is negative after detection";
  if (x.illiquidShare > 0.7) return "mostly trades illiquid markets — copying impossible";
  if (x.unrealizedShare > 0.8) return "PnL is mostly unrealized/unclosed";
  if (x.rawTotalRoi > 0 && x.costAdjTotalRoi <= 0)
    return "only profitable before realistic cost estimates";
  if (x.daysSinceLastTrade > 30) return "no recent activity";
  return null;
}

// ── Mimicability ─────────────────────────────────────────────────────────────

export interface MimicInputs {
  entry: WalletMarketEntry;
  currentPrice: number; // executable price for OUR entry on the wallet's side
  spread: number;
  entrySideDepthUsd?: number;
  ruleClarity: number;
  crowdSameSide: number;
  minutesToClose?: number;
  alpha: AlphaSettings;
  feeRateBps: number;
  slippageBps: number;
  now: number;
}

/**
 * MimicabilityScore per spec:
 * skill × categoryFit × entryFreshness × remainingEdge × liquidity × clarity
 * ÷ crowding ÷ slippage ÷ stalePrice — with every hard block listed.
 */
export function assessMimic(x: MimicInputs): MimicAssessment {
  const { entry, alpha } = x;
  const blocks: MimicBlock[] = [];
  const dim = entry.dimensionSkill;
  const fwd = entry.forward;

  const drift = x.currentPrice - entry.avgEntryPrice; // + = market moved with the wallet
  const driftCents = Math.abs(drift) * 100;
  const entryAgeMin = (x.now - entry.lastTradeTs) / 60_000;
  const maxSize = Math.min(
    alpha.testOrderUsd,
    (x.entrySideDepthUsd ?? 0) / 5,
  );

  // evidence-based expected edge: measured avg 1h drift after detection.
  // Without forward evidence there IS no honest remaining-edge estimate.
  const expectedEdge = fwd && fwd.samples >= alpha.minWalletForwardSamples ? fwd.avgDrift1h : 0;
  const remainingEdge = Math.max(0, expectedEdge - Math.max(0, drift));
  const friction =
    x.spread / 2 + x.feeRateBps / 10_000 + x.slippageBps / 10_000;

  if (!dim || dim.sampleSize < alpha.minWalletSampleSize)
    blocks.push({ reason: "sample_size", detail: `wallet has ${dim?.sampleSize ?? 0} closed trades in this category (min ${alpha.minWalletSampleSize})` });
  if (!fwd || fwd.samples < alpha.minWalletForwardSamples)
    blocks.push({ reason: "forward_evidence", detail: `${fwd?.samples ?? 0} forward-tracked entries (min ${alpha.minWalletForwardSamples}) — no honest copyable-edge estimate yet` });
  else if (fwd.avgDrift1h <= 0)
    blocks.push({ reason: "forward_negative", detail: `avg post-entry drift ${(fwd.avgDrift1h * 100).toFixed(1)}c is not positive` });
  if (driftCents > alpha.maxCopyDriftCents)
    blocks.push({ reason: "price_drift", detail: `price moved ${driftCents.toFixed(1)}c from wallet entry (max ${alpha.maxCopyDriftCents}c)` });
  if (entryAgeMin > alpha.maxWalletEntryAgeMin)
    blocks.push({ reason: "entry_stale", detail: `wallet entry is ${Math.round(entryAgeMin)}min old (max ${alpha.maxWalletEntryAgeMin}min)` });
  if (entry.exiting || !entry.stillHolding)
    blocks.push({ reason: "wallet_exiting", detail: entry.exiting ? "wallet has started exiting" : "wallet no longer holds this position" });
  if (x.spread > 0 && remainingEdge > 0 && x.spread > remainingEdge + 1e-9)
    blocks.push({ reason: "spread_vs_edge", detail: `spread ${(x.spread * 100).toFixed(1)}c wider than remaining edge ${(remainingEdge * 100).toFixed(1)}c` });
  if ((x.entrySideDepthUsd ?? 0) < 5 * Math.min(alpha.testOrderUsd, 25))
    blocks.push({ reason: "liquidity", detail: `entry-side depth $${Math.round(x.entrySideDepthUsd ?? 0)} < 5× test size` });
  if (x.minutesToClose !== undefined && x.minutesToClose < 60)
    blocks.push({ reason: "close_too_near", detail: `market closes in ${Math.round(x.minutesToClose)}min — no safe exit window` });
  if (x.ruleClarity < 0.9)
    blocks.push({ reason: "rule_clarity", detail: `rule clarity ${x.ruleClarity.toFixed(2)} below 0.90` });

  const components = {
    walletSkill: clamp01((dim?.costAdjRoi ?? 0) * 5) * (dim?.confidence ?? 0),
    categoryFit: dim && dim.sampleSize >= alpha.minWalletSampleSize ? 1 : 0.2,
    entryFreshness: clamp01(1 - entryAgeMin / Math.max(1, alpha.maxWalletEntryAgeMin)),
    remainingEdge: clamp01(remainingEdge * 20),
    liquidityScore: clamp01((x.entrySideDepthUsd ?? 0) / (5 * alpha.testOrderUsd)),
    ruleClarity: x.ruleClarity,
    crowdingPenalty: 1 + Math.max(0, x.crowdSameSide - 1) * 0.25,
    slippagePenalty: 1 + friction * 10,
    stalePricePenalty: 1 + clamp01(entryAgeMin / (12 * 60)),
  };
  const raw =
    (100 *
      components.walletSkill *
      components.categoryFit *
      components.entryFreshness *
      components.remainingEdge *
      components.liquidityScore *
      components.ruleClarity) /
    (components.crowdingPenalty * components.slippagePenalty * components.stalePricePenalty);
  const score = blocks.length > 0 ? Math.min(raw, 20) : raw;

  // recommendation follows NET ECONOMICS, not the display score: blocks veto,
  // then remaining edge after friction decides copy vs confirmation-only
  const netEdge = remainingEdge - friction;
  const recommendation =
    blocks.length > 0
      ? "block"
      : netEdge >= 0.01
        ? "copy"
        : netEdge > 0
          ? "confirm_only"
          : "watch";

  return {
    score: Math.min(100, score),
    components,
    blocks,
    remainingEdge,
    friction,
    maxSizeUsd: Math.max(0, Math.min(maxSize, 25)),
    recommendation,
  };
}

// ── Capital lockup ───────────────────────────────────────────────────────────

/** cost (in probability points) of tying capital up until settlement */
export function capitalLockupCost(daysToClose: number, annualRate = 0.1): number {
  return Math.max(0, daysToClose) * (annualRate / 365);
}

// ── Decay curves & feature evidence ──────────────────────────────────────────

export const BUCKET_MS: Record<DecayBucketKey, number> = {
  b5s: 5_000,
  b30s: 30_000,
  b5m: 5 * 60_000,
  b1h: 60 * 60_000,
  b24h: 24 * 60 * 60_000,
};

export const BUCKET_ORDER: DecayBucketKey[] = ["b5s", "b30s", "b5m", "b1h", "b24h"];

export function decayCurve(outcomes: AlphaOutcome[]): DecayCurvePoint[] {
  return BUCKET_ORDER.map((bucket) => {
    const rows = outcomes.map((o) => o.buckets[bucket]).filter(Boolean);
    const captured = rows.filter((b) => b!.drift !== undefined);
    const missed = rows.filter((b) => b!.missed).length;
    const avg =
      captured.length > 0
        ? captured.reduce((a, b) => a + (b!.drift ?? 0), 0) / captured.length
        : 0;
    return { bucket, n: captured.length, missed, avgDrift: avg };
  });
}

export function summarizeEvidence(featureId: string, rows: AlphaOutcome[]): FeatureEvidence {
  const mine = rows.filter((o) => o.featureId === featureId);
  const spreads = mine.map((o) => o.spreadAtSignal).filter((s): s is number => s !== undefined);
  const drifts1h = mine
    .map((o) => o.buckets.b1h?.drift)
    .filter((d): d is number => d !== undefined);
  const positives = drifts1h.filter((d) => d > 0);
  const bestDrift = Math.max(0, ...drifts1h);
  const grossPositive = positives.reduce((a, b) => a + b, 0);
  // longest adverse run over 1h drifts, chronological
  let run = 0, maxRun = 0;
  for (const d of drifts1h) {
    run = d < 0 ? run + 1 : 0;
    maxRun = Math.max(maxRun, run);
  }
  const days = new Set(mine.map((o) => new Date(o.createdAt).toISOString().slice(0, 10)));
  return {
    featureId,
    outcomes: mine.length,
    tradableOutcomes: mine.filter((o) => o.tradable).length,
    proposedOutcomes: mine.filter((o) => o.wasProposed).length,
    distinctMarkets: new Set(mine.map((o) => o.conditionId)).size,
    distinctDays: days.size,
    avgSpread: spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : 0,
    staleShare:
      mine.length > 0
        ? mine.filter((o) => (o.bookAgeMsAtSignal ?? 0) > 60_000).length / mine.length
        : 0,
    luckyConcentration:
      grossPositive > 0 ? clamp01(bestDrift / grossPositive) : drifts1h.length ? 1 : 0,
    maxAdverseRun: maxRun,
    curve: decayCurve(mine),
    firstAt: mine.length ? Math.min(...mine.map((o) => o.createdAt)) : undefined,
    lastAt: mine.length ? Math.max(...mine.map((o) => o.createdAt)) : undefined,
  };
}

// ── AlphaScore ───────────────────────────────────────────────────────────────

/**
 * AlphaScore per spec — multiplicative composite over measured evidence.
 * Returns null when there is not enough evidence to say anything honest.
 */
export function alphaScore(
  ev: FeatureEvidence,
  opts: { sourceReliability: number; ambiguityPenalty?: number; crowdingPenalty?: number },
): { score: number; components: Record<string, number> } | null {
  const oneH = ev.curve.find((c) => c.bucket === "b1h");
  if (!oneH || oneH.n < 10) return null;
  const fiveS = ev.curve.find((c) => c.bucket === "b5s");
  const expectedEdge = oneH.avgDrift; // measured, direction-adjusted
  const friction = ev.avgSpread / 2 + 0.005; // half-spread + 50bps slippage estimate
  const components: Record<string, number> = {
    expectedEdge: clamp01((expectedEdge - friction) * 25 + 0.02),
    evidenceStrength: clamp01(oneH.n / 100) * clamp01(ev.distinctDays / 7),
    dataFreshness: clamp01(1 - ev.staleShare),
    liquidityScore: clamp01(ev.tradableOutcomes / Math.max(1, ev.outcomes)),
    ruleClarity: 1 - (opts.ambiguityPenalty ?? 0),
    repeatability: clamp01(ev.distinctMarkets / Math.max(1, ev.outcomes) + 0.3),
    spreadPenalty: 1 + ev.avgSpread * 10,
    slippagePenalty: 1 + 0.05,
    latencyPenalty:
      fiveS && fiveS.n >= 5 && expectedEdge > 0
        ? 1 + clamp01(Math.max(0, fiveS.avgDrift) / Math.max(1e-6, expectedEdge))
        : 1,
    crowdingPenalty: opts.crowdingPenalty ?? 1,
    overfitPenalty: 1 + 2 * ev.luckyConcentration,
    sourceReliabilityPenalty: 1 + (1 - clamp01(opts.sourceReliability)),
  };
  const raw =
    (100 *
      components.expectedEdge *
      components.evidenceStrength *
      components.dataFreshness *
      components.liquidityScore *
      components.ruleClarity *
      components.repeatability) /
    (components.spreadPenalty *
      components.slippagePenalty *
      components.latencyPenalty *
      components.crowdingPenalty *
      components.overfitPenalty *
      components.sourceReliabilityPenalty);
  return { score: Math.min(100, Math.max(0, raw)), components };
}

/** decay verdict for retirement monitoring: recent edge vs lifetime edge */
export function decayVerdict(
  lifetime: FeatureEvidence,
  recent: FeatureEvidence,
): { decayed: boolean; detail: string } {
  const life = lifetime.curve.find((c) => c.bucket === "b1h");
  const rec = recent.curve.find((c) => c.bucket === "b1h");
  if (!life || life.n < 30 || !rec || rec.n < 10)
    return { decayed: false, detail: "insufficient evidence for a decay verdict" };
  if (life.avgDrift <= 0)
    return { decayed: true, detail: `lifetime 1h drift ${(life.avgDrift * 100).toFixed(2)}c is not positive` };
  const ratio = rec.avgDrift / life.avgDrift;
  if (ratio < 0.4)
    return {
      decayed: true,
      detail: `recent 1h drift ${(rec.avgDrift * 100).toFixed(2)}c is ${(ratio * 100).toFixed(0)}% of lifetime ${(life.avgDrift * 100).toFixed(2)}c`,
    };
  return { decayed: false, detail: `recent edge holds at ${(ratio * 100).toFixed(0)}% of lifetime` };
}

/** graveyard rows are just features whose lifecycle ended */
export function isGraveyard(f: AlphaFeature): boolean {
  return f.status === "rejected" || f.status === "retired";
}
