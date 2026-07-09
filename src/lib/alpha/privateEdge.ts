import type { AppSettings, NormalizedMarket, SignalResult } from "@/lib/types";
import { wilsonLower } from "./hitRate";
import type { AlphaOutcome, DecayBucketKey } from "./types";
import { conformalInterval } from "@/lib/engine/risk/conformal";

const DEFAULT_SPREAD = 0.02;
const ARCHIVE_SLIPPAGE_EST = 0.005;
const FIVE_MIN_MS = 5 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;
const TWO_HOURS_MS = 2 * ONE_HOUR_MS;
const MAX_HALF_LIFE_MS = 6 * ONE_HOUR_MS;
const DECAY_INTERVAL_MS = 55 * 60_000;
const STALE_BOOK_MS = 60_000;

export const PRIVATE_EDGE_MIN_SAMPLES = 12;
export const PRIVATE_EDGE_MIN_POSTERIOR_NET_HIT = 0.46;

export interface EdgeBucketStats {
  bucket: DecayBucketKey;
  n: number;
  hitRate: number;
  netHitRate: number;
  avgDrift: number;
  avgNetDrift: number;
}

export interface PrivateEdgeProfile {
  strategy: string;
  n: number;
  sampleReady: boolean;
  wins: number;
  netWins: number;
  hitRate: number;
  netHitRate: number;
  wilsonNetLo: number;
  posteriorWinProb: number;
  posteriorNetWinProb: number;
  avgDrift1h: number;
  avgNetDrift1h: number;
  conformalNetEdgeLo: number;
  conformalNetEdgeHi: number;
  conformalConfidence: number;
  avgSpread: number;
  avgFriction: number;
  tradableShare: number;
  staleBookShare: number;
  executionPenalty: number;
  halfLifeMs: number;
  staleAfterMs: number;
  confidence: number;
  sizeMultiplier: number;
  rankMultiplier: number;
  edgeCents: number;
  buckets: EdgeBucketStats[];
  notes: string[];
}

export interface PrivateEdgeVerdict {
  allow: boolean;
  reason?: string;
  currentFriction: number;
  currentNetEdge: number;
  freshness: number;
  sizeMultiplier: number;
  rankMultiplier: number;
  adjustedWinProbability?: number;
}

export interface PrivateEdgeVerdictInput {
  profile?: PrivateEdgeProfile;
  signal: SignalResult;
  market: NormalizedMarket;
  settings: AppSettings;
  now: number;
  modelWinProbability?: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round(n: number, places = 4): number {
  return Number(n.toFixed(places));
}

function avg(nums: number[], fallback = 0): number {
  return nums.length ? nums.reduce((sum, n) => sum + n, 0) / nums.length : fallback;
}

function capturedDrift(row: AlphaOutcome, bucket: DecayBucketKey): number | undefined {
  const drift = row.buckets[bucket]?.drift;
  return typeof drift === "number" && Number.isFinite(drift) ? drift : undefined;
}

function archiveFriction(row: AlphaOutcome): number {
  return (row.spreadAtSignal ?? DEFAULT_SPREAD) / 2 + ARCHIVE_SLIPPAGE_EST;
}

function bucketStats(rows: AlphaOutcome[], bucket: DecayBucketKey): EdgeBucketStats {
  let n = 0;
  let wins = 0;
  let netWins = 0;
  let driftSum = 0;
  let netDriftSum = 0;
  for (const row of rows) {
    const drift = capturedDrift(row, bucket);
    if (drift === undefined) continue;
    const friction = archiveFriction(row);
    n += 1;
    driftSum += drift;
    netDriftSum += drift - friction;
    if (drift > 0) wins += 1;
    if (drift > friction) netWins += 1;
  }

  return {
    bucket,
    n,
    hitRate: n ? round(wins / n) : 0,
    netHitRate: n ? round(netWins / n) : 0,
    avgDrift: n ? round(driftSum / n) : 0,
    avgNetDrift: n ? round(netDriftSum / n) : 0,
  };
}

function estimateHalfLifeMs(avg5m: number, avg1h: number): number {
  if (avg5m > 0 && avg1h > 0) {
    if (avg1h >= avg5m) return MAX_HALF_LIFE_MS;
    const ratio = clamp(avg1h / avg5m, 0.05, 0.99);
    return clamp((DECAY_INTERVAL_MS * Math.log(0.5)) / Math.log(ratio), FIVE_MIN_MS, MAX_HALF_LIFE_MS);
  }
  if (avg5m > 0 && avg1h <= 0) return FIVE_MIN_MS;
  if (avg1h > 0) return ONE_HOUR_MS;
  return FIVE_MIN_MS;
}

function currentFriction(market: NormalizedMarket, settings: AppSettings): number {
  return (
    (market.spread ?? DEFAULT_SPREAD) / 2 +
    settings.feeRateBps / 10_000 +
    settings.slippageBps / 10_000
  );
}

function edgeNotes(profile: Omit<PrivateEdgeProfile, "notes">): string[] {
  const notes: string[] = [];
  if (!profile.sampleReady) notes.push("low_sample_shadow_only");
  if (profile.avgNetDrift1h > 0) notes.push("positive_net_drift");
  if (profile.conformalNetEdgeLo > 0) notes.push("conformal_edge_confirmed");
  if (profile.posteriorNetWinProb >= 0.55) notes.push("posterior_net_hit_positive");
  if (profile.halfLifeMs <= 30 * 60_000) notes.push("fast_decay");
  if (profile.executionPenalty >= 0.35) notes.push("fragile_execution");
  return notes;
}

export function privateEdgeProfiles(outcomes: AlphaOutcome[]): PrivateEdgeProfile[] {
  const byStrategy = new Map<string, AlphaOutcome[]>();
  for (const row of outcomes) {
    const rows = byStrategy.get(row.featureId) ?? [];
    rows.push(row);
    byStrategy.set(row.featureId, rows);
  }

  return [...byStrategy.entries()]
    .map(([strategy, rows]) => {
      const bucketList: DecayBucketKey[] = ["b5s", "b30s", "b5m", "b1h", "b24h"];
      const buckets = bucketList.map((bucket) => bucketStats(rows, bucket));
      const b5m = buckets.find((b) => b.bucket === "b5m")!;
      const captured1h = rows
        .map((row) => ({ row, drift: capturedDrift(row, "b1h") }))
        .filter((x): x is { row: AlphaOutcome; drift: number } => x.drift !== undefined);

      const n = captured1h.length;
      const wins = captured1h.filter(({ drift }) => drift > 0).length;
      const netWins = captured1h.filter(({ row, drift }) => drift > archiveFriction(row)).length;
      const driftSum = captured1h.reduce((sum, { drift }) => sum + drift, 0);
      const netDrifts = captured1h.map(({ row, drift }) => drift - archiveFriction(row));
      const netDriftSum = netDrifts.reduce((sum, drift) => sum + drift, 0);
      const frictionSamples = captured1h.map(({ row }) => archiveFriction(row));
      const spreadSamples = rows
        .map((row) => row.spreadAtSignal)
        .filter((spread): spread is number => typeof spread === "number" && Number.isFinite(spread));
      const bookAgeSamples = rows
        .map((row) => row.bookAgeMsAtSignal)
        .filter((age): age is number => typeof age === "number" && Number.isFinite(age));

      const avgSpread = avg(spreadSamples, DEFAULT_SPREAD);
      const avgFriction = avg(frictionSamples, DEFAULT_SPREAD / 2 + ARCHIVE_SLIPPAGE_EST);
      const tradableShare = rows.length ? rows.filter((row) => row.tradable).length / rows.length : 0;
      const staleBookShare = bookAgeSamples.length
        ? bookAgeSamples.filter((age) => age > STALE_BOOK_MS).length / bookAgeSamples.length
        : 0;
      const spreadPenalty = clamp((avgSpread - 0.025) / 0.05, 0, 1) * 0.35;
      const executionPenalty = clamp((1 - tradableShare) * 0.5 + staleBookShare * 0.25 + spreadPenalty, 0, 0.85);
      const sampleReady = n >= PRIVATE_EDGE_MIN_SAMPLES;
      const posteriorWinProb = n ? (wins + 2) / (n + 4) : 0.5;
      const posteriorNetWinProb = n ? (netWins + 2) / (n + 4) : 0.5;
      const avgDrift1h = n ? driftSum / n : 0;
      const avgNetDrift1h = n ? netDriftSum / n : 0;
      const conformal = conformalInterval(netDrifts, avgNetDrift1h, 0.1);
      const halfLifeMs = estimateHalfLifeMs(b5m.avgDrift, avgDrift1h);
      const staleAfterMs = clamp(halfLifeMs * 1.5, FIVE_MIN_MS, TWO_HOURS_MS);
      const sampleConfidence = sampleReady ? 0.25 + 0.75 * Math.sqrt(clamp(n / 60, 0, 1)) : (n / PRIVATE_EDGE_MIN_SAMPLES) * 0.25;
      const confidence = clamp(sampleConfidence * (0.65 + 0.35 * tradableShare) * (1 - executionPenalty * 0.35), 0, 1);
      const wilsonNetLo = wilsonLower(netWins, n);
      const driftScore = clamp(((avgNetDrift1h + Math.min(0, conformal.lower)) / 2) / 0.03, -1, 1);
      const posteriorScore = clamp((posteriorNetWinProb - 0.5) * 2, -1, 1);
      const combinedScore = clamp(0.65 * posteriorScore + 0.35 * driftScore - executionPenalty, -1, 1);
      const quality = clamp(0.5 + combinedScore / 2, 0, 1);
      const sizeMultiplier = sampleReady ? clamp(0.2 + 0.8 * confidence * quality, 0.1, 1) : 1;
      const rankMultiplier = sampleReady
        ? clamp(0.4 + confidence * (0.8 + driftScore) + Math.max(0, wilsonNetLo - 0.5) * 1.5 - executionPenalty, 0.2, 2.2)
        : 1;

      const base = {
        strategy,
        n,
        sampleReady,
        wins,
        netWins,
        hitRate: n ? round(wins / n) : 0,
        netHitRate: n ? round(netWins / n) : 0,
        wilsonNetLo: round(wilsonNetLo),
        posteriorWinProb: round(posteriorWinProb),
        posteriorNetWinProb: round(posteriorNetWinProb),
        avgDrift1h: round(avgDrift1h),
        avgNetDrift1h: round(avgNetDrift1h),
        conformalNetEdgeLo: conformal.lower,
        conformalNetEdgeHi: conformal.upper,
        conformalConfidence: conformal.confidence,
        avgSpread: round(avgSpread),
        avgFriction: round(avgFriction),
        tradableShare: round(tradableShare),
        staleBookShare: round(staleBookShare),
        executionPenalty: round(executionPenalty),
        halfLifeMs: Math.round(halfLifeMs),
        staleAfterMs: Math.round(staleAfterMs),
        confidence: round(confidence),
        sizeMultiplier: round(sizeMultiplier),
        rankMultiplier: round(rankMultiplier),
        edgeCents: round(avgNetDrift1h * 100, 2),
        buckets,
      };

      return {
        ...base,
        notes: edgeNotes(base),
      };
    })
    .sort((a, b) => b.rankMultiplier - a.rankMultiplier || b.n - a.n);
}

export function privateEdgeVerdict(input: PrivateEdgeVerdictInput): PrivateEdgeVerdict {
  const { profile, signal, market, settings, now, modelWinProbability } = input;
  const friction = currentFriction(market, settings);
  if (!profile || !profile.sampleReady) {
    return {
      allow: true,
      currentFriction: friction,
      currentNetEdge: 0,
      freshness: 1,
      sizeMultiplier: 1,
      rankMultiplier: 1,
      adjustedWinProbability: modelWinProbability,
    };
  }

  const ageMs = Math.max(0, now - signal.createdAt);
  if (ageMs > profile.staleAfterMs) {
    return {
      allow: false,
      reason: `private edge stale: ${profile.strategy} decays after ${(profile.staleAfterMs / 60_000).toFixed(1)}m; signal is ${(ageMs / 60_000).toFixed(1)}m old`,
      currentFriction: friction,
      currentNetEdge: profile.avgNetDrift1h,
      freshness: 0,
      sizeMultiplier: 0,
      rankMultiplier: 0,
      adjustedWinProbability: modelWinProbability,
    };
  }

  if (profile.tradableShare < 0.5) {
    return {
      allow: false,
      reason: `private edge execution quality: only ${(profile.tradableShare * 100).toFixed(0)}% of measured ${profile.strategy} signals were tradable`,
      currentFriction: friction,
      currentNetEdge: profile.avgNetDrift1h,
      freshness: 1,
      sizeMultiplier: 0,
      rankMultiplier: 0,
      adjustedWinProbability: modelWinProbability,
    };
  }

  const currentNetEdge = profile.avgNetDrift1h - Math.max(0, friction - profile.avgFriction);
  if (profile.posteriorNetWinProb < PRIVATE_EDGE_MIN_POSTERIOR_NET_HIT) {
    return {
      allow: false,
      reason: `private edge posterior: net-hit posterior ${(profile.posteriorNetWinProb * 100).toFixed(0)}% over ${profile.n} outcomes is below ${(PRIVATE_EDGE_MIN_POSTERIOR_NET_HIT * 100).toFixed(0)}%`,
      currentFriction: friction,
      currentNetEdge,
      freshness: 1,
      sizeMultiplier: 0,
      rankMultiplier: 0,
      adjustedWinProbability: modelWinProbability,
    };
  }

  if (currentNetEdge <= 0) {
    return {
      allow: false,
      reason: `private edge net economics: measured net drift ${(profile.avgNetDrift1h * 100).toFixed(2)}c does not clear current friction ${(friction * 100).toFixed(2)}c`,
      currentFriction: friction,
      currentNetEdge,
      freshness: 1,
      sizeMultiplier: 0,
      rankMultiplier: 0,
      adjustedWinProbability: modelWinProbability,
    };
  }

  const freshness = clamp(1 - ageMs / Math.max(profile.staleAfterMs, 1), 0.2, 1);
  const spreadPenalty = clamp(((market.spread ?? DEFAULT_SPREAD) - profile.avgSpread) / 0.04, 0, 0.6);
  const sizeMultiplier = clamp(profile.sizeMultiplier * (0.5 + 0.5 * freshness) * (1 - spreadPenalty), 0.1, 1);
  const rankMultiplier = clamp(profile.rankMultiplier * (0.65 + 0.35 * freshness) * (1 - spreadPenalty), 0.1, 2.2);

  let adjustedWinProbability = modelWinProbability;
  if (modelWinProbability !== undefined) {
    const posteriorTilt = clamp((profile.posteriorNetWinProb - 0.5) * profile.confidence * 0.04, -0.03, 0.03);
    const driftTilt = clamp(currentNetEdge * profile.confidence * 0.5, -0.025, 0.025);
    adjustedWinProbability = clamp(modelWinProbability + posteriorTilt + driftTilt, 0.01, 0.99);
  }

  return {
    allow: true,
    currentFriction: friction,
    currentNetEdge: round(currentNetEdge),
    freshness: round(freshness),
    sizeMultiplier: round(sizeMultiplier),
    rankMultiplier: round(rankMultiplier),
    adjustedWinProbability: adjustedWinProbability === undefined ? undefined : round(adjustedWinProbability, 6),
  };
}
