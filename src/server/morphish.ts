// MORPHISH BOARD services — every panel reads hot in-memory state (market
// cache, signal ring, exposure cache, wallet intel, cross-venue link cache).
// No PostgreSQL round-trip sits on any dashboard update path; the only store
// access is the KV-cached foundry feature list, memoized here for 60s.
//
// Numbers are real or absent: portfolio KPIs come from the live portfolio
// engine for the CURRENT mode (demo state is labeled by the caller), the Top
// GEM is the strongest signal that survives hard gates (and is shown as
// BLOCKED with reasons when none does), lattice/ridge/graph are built from
// the live normalized universe. Nothing here fabricates a win rate.

import type {
  CrossVenueLink,
  NormalizedMarket,
  PortfolioState,
  SignalResult,
  TerminalMode,
} from "@/lib/types";
import type { AlphaFeatureStatus, MarketWalletIntel } from "@/lib/alpha/types";
import { capitalLockupCost, categorizeMarket } from "@/lib/alpha/score";
import { cryptoShadowProb } from "@/lib/engine/signals/ecl";
import { parseCryptoThreshold } from "@/lib/engine/crossvenue/threshold";
import { getCrossVenueLinks } from "./crossVenue";
import { getMarkets, getRealizedVolDaily, getSpotRef } from "./marketData";
import { computePortfolio } from "./portfolio";
import { measure, measureSync, perfSnapshot } from "./perf";
import { recentSignals } from "./hotpath/signalCache";
import { regInfo } from "./hotpath/registry";
import { scanCycles } from "./scanner";
import { getWalletIntel, walletIntelInfo } from "./alpha/walletRadar";
import { listFeatures } from "./alpha/repo";
import { listWallets } from "./alpha/repo";

// ── foundry status memo (60s) — statuses gate what may surface as Top GEM ───

interface MorphishGlobal {
  featureStatus: Map<string, AlphaFeatureStatus>;
  featureStatusAt: number;
  walletNames: Map<string, string>;
  walletNamesAt: number;
}

const g = globalThis as unknown as { __eqMorphish?: MorphishGlobal };

function state(): MorphishGlobal {
  if (!g.__eqMorphish) {
    g.__eqMorphish = {
      featureStatus: new Map(),
      featureStatusAt: 0,
      walletNames: new Map(),
      walletNamesAt: 0,
    };
  }
  return g.__eqMorphish;
}

/** wallet display names, memoized 60s — the graph must not hit the store per request */
async function walletNamesMemo(): Promise<Map<string, string>> {
  const s = state();
  if (Date.now() - s.walletNamesAt > 60_000) {
    try {
      const wallets = await listWallets();
      s.walletNames = new Map(
        wallets.map((w) => [w.walletId, w.pseudonym ?? w.walletId.slice(0, 8)]),
      );
      s.walletNamesAt = Date.now();
    } catch {
      /* keep last-good names */
    }
  }
  return s.walletNames;
}

async function featureStatuses(): Promise<Map<string, AlphaFeatureStatus>> {
  const s = state();
  if (Date.now() - s.featureStatusAt > 60_000) {
    try {
      const features = await listFeatures();
      s.featureStatus = new Map(features.map((f) => [f.id, f.status]));
      s.featureStatusAt = Date.now();
    } catch {
      /* keep last-good statuses */
    }
  }
  return s.featureStatus;
}

const EXPERIMENTAL: AlphaFeatureStatus[] = [
  "idea", "data_connected", "backtesting", "paper_testing", "rejected", "degraded", "retired",
];

// ── Summary (KPI card + command bar) ─────────────────────────────────────────

export interface MorphishSummary {
  mode: TerminalMode;
  portfolio: PortfolioState;
  /** breakeven win rate implied by avg R/R: 1/(1+RR); undefined without R/R */
  breakevenWinRate?: number;
  negativeExpectancy: boolean;
  riskState: "SAFE" | "WATCH" | "LOCKED";
  /** PnL since local midnight (the portfolio engine's "daily") — labeled "today" in the UI, NOT a rolling 24h window */
  changeTodayUsd?: number;
  /** value change vs the oldest snapshot within the last 7 days; absent until ≥1d of snapshot history exists */
  change7dUsd?: number;
  openOrderExposure: number;
  scan: { cycle: number; markets: number; updatedAt: number; ageMs: number };
  signals: { active: number; proposed: number; experimental: number };
  walletIntelMarkets: number;
  killSwitch: boolean;
  isSample: boolean;
}

export async function morphishSummary(
  mode: TerminalMode,
  opts: { killSwitch: boolean; openOrderExposure: number; change7dUsd?: number },
): Promise<MorphishSummary> {
  const portfolio = await computePortfolio(mode);
  const sigs = recentSignals();
  const statuses = await featureStatuses();
  const reg = regInfo();
  const rr = portfolio.avgRR;
  const breakeven = rr && rr > 0 ? 1 / (1 + rr) : undefined;
  const wr = portfolio.winRate;
  const negativeExpectancy =
    portfolio.closedTrades >= 10 &&
    breakeven !== undefined &&
    wr !== undefined &&
    wr < breakeven;
  return {
    mode,
    portfolio,
    breakevenWinRate: breakeven,
    negativeExpectancy,
    riskState: opts.killSwitch ? "LOCKED" : negativeExpectancy || portfolio.dailyPnl < 0 ? "WATCH" : "SAFE",
    changeTodayUsd: portfolio.dailyPnl,
    change7dUsd: opts.change7dUsd,
    openOrderExposure: opts.openOrderExposure,
    scan: { cycle: scanCycles(), markets: reg.size, updatedAt: reg.updatedAt, ageMs: reg.ageMs },
    signals: {
      active: sigs.length,
      proposed: sigs.filter((x) => x.status === "proposed").length,
      experimental: sigs.filter((x) => EXPERIMENTAL.includes(statuses.get(x.strategy) ?? "idea")).length,
    },
    walletIntelMarkets: walletIntelInfo().markets,
    killSwitch: opts.killSwitch,
    isSample: portfolio.isSample,
  };
}

// ── Top GEM ──────────────────────────────────────────────────────────────────

export interface TopGemCandidate {
  signalId: string;
  strategy: string;
  strategyLabel: string;
  experimental: boolean;
  conditionId: string;
  question: string;
  venueId: string;
  direction: string;
  score: number;
  gemScore: number;
  /** normalized opportunity intensity (NOT leverage, NOT a payout multiple) */
  intensity: number;
  edgeAfterCost?: number;
  /** expected edge in dollars at the allowed test size — honest scale */
  edgeUsdAtTestSize?: number;
  testSizeUsd: number;
  entryPrice?: number;
  shadowProb?: number;
  spread?: number;
  liquidityScore?: number;
  ruleClarity?: number;
  freshnessMs: number;
  minutesToClose?: number;
  blocked: boolean;
  blockReasons: string[];
  createdAt: number;
}

interface GemInputs {
  sig: SignalResult;
  market: NormalizedMarket;
  experimental: boolean;
  now: number;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** TopGemScore per spec, with every hard exclusion listed instead of hidden */
export function scoreGem(x: GemInputs): TopGemCandidate {
  const { sig, market, now } = x;
  const m = sig.meta ?? {};
  const edge = num(m.edgeAfterCost) ?? num(m.remainingEdge) ?? num(m.netEdge);
  const spread = market.spread ?? num(m.spread) ?? 0.05;
  const liquidityScore = num(m.liquidityScore) ?? Math.min(1, market.liquidity / 20_000);
  const ruleClarity = num(m.ruleClarity) ?? 0.8;
  const freshnessMs = now - market.fetchedAt;
  const minutesToClose = market.endDate
    ? (new Date(market.endDate).getTime() - now) / 60_000
    : undefined;
  const testSizeUsd = Math.min(25, num(m.suggestedTestUsd) ?? 10);

  const blockReasons: string[] = [];
  if (sig.status !== "proposed") blockReasons.push(`signal self-rejected (${sig.checks.filter((c) => !c.passed).map((c) => c.name).join(", ") || "checks failed"})`);
  if (sig.direction === "NEUTRAL") blockReasons.push("informational signal — no direction to trade");
  if (edge === undefined || edge <= 0) blockReasons.push("no measured edge after cost");
  if (ruleClarity < 0.9) blockReasons.push(`rule clarity ${ruleClarity.toFixed(2)} < 0.90`);
  if (freshnessMs > 60_000) blockReasons.push(`market data ${(freshnessMs / 1000).toFixed(0)}s stale`);
  if (edge !== undefined && spread > edge) blockReasons.push(`spread ${(spread * 100).toFixed(1)}c wider than remaining edge`);
  if (market.referenceOnly || !market.tradable) blockReasons.push("reference-only / non-tradable market");
  if (liquidityScore < 0.7) blockReasons.push("depth below 5× intended size");
  if (x.experimental) blockReasons.push("experimental (not promoted) — visible for research, never a live preview");

  const freshScore = Math.max(0.1, 1 - freshnessMs / 60_000);
  const crowding = 1; // no crowding measure for non-wallet signals yet
  const stale = 1 + Math.max(0, freshnessMs - 15_000) / 60_000;
  const raw =
    ((sig.score / 100) *
      Math.max(0.001, (edge ?? 0) * 20) *
      liquidityScore *
      ruleClarity *
      freshScore *
      100) /
    ((1 + spread * 10) * (1 + 0.05) * crowding * stale);
  const gemScore = blockReasons.length > 0 ? 0 : raw;

  return {
    signalId: sig.id,
    strategy: sig.strategy,
    strategyLabel: sig.strategyLabel,
    experimental: x.experimental,
    conditionId: market.conditionId,
    question: market.question,
    venueId: market.venueId,
    direction: sig.direction,
    score: sig.score,
    gemScore,
    intensity: Number((raw / 2).toFixed(2)),
    edgeAfterCost: edge,
    edgeUsdAtTestSize: edge !== undefined ? Number((edge * testSizeUsd / Math.max(0.02, num(m.currentPrice) ?? market.bestAsk ?? 0.5)).toFixed(2)) : undefined,
    testSizeUsd,
    entryPrice: num(m.currentPrice) ?? market.bestAsk,
    shadowProb: num(m.pShadow) ?? num(m.modelWinProb),
    spread,
    liquidityScore,
    ruleClarity,
    freshnessMs,
    minutesToClose,
    blocked: blockReasons.length > 0,
    blockReasons,
    createdAt: sig.createdAt,
  };
}

export interface TopGemPayload {
  gem?: TopGemCandidate;
  candidates: TopGemCandidate[];
  note: string;
}

export async function morphishTopGem(): Promise<TopGemPayload> {
  const [{ markets }, statuses] = await Promise.all([getMarkets(), featureStatuses()]);
  const byId = new Map(markets.map((m) => [m.conditionId, m]));
  const now = Date.now();
  const candidates = measureSync("hot.morphish_topgem", () => {
    const out: TopGemCandidate[] = [];
    for (const sig of recentSignals(now)) {
      if (!sig.conditionId) continue;
      const market = byId.get(sig.conditionId);
      if (!market) continue;
      out.push(
        scoreGem({
          sig,
          market,
          experimental: EXPERIMENTAL.includes(statuses.get(sig.strategy) ?? "idea"),
          now,
        }),
      );
    }
    return out.sort((a, b) => b.gemScore - a.gemScore || b.score - a.score).slice(0, 12);
  });
  const gem = candidates.find((c) => !c.blocked);
  return {
    gem,
    candidates,
    note: gem
      ? "intensity is a normalized opportunity score, not leverage or a payout multiple; edge $ is at the crippled test size"
      : "no candidate currently survives every hard gate — blocked candidates are listed with their reasons",
  };
}

// ── Probability lattice ──────────────────────────────────────────────────────

export interface LatticePoint {
  id: string;
  venueId: string;
  question: string;
  category: string;
  prob?: number;
  shadowProb?: number;
  edgeAfterCost?: number;
  spread?: number;
  liquidity: number;
  volume24h: number;
  signalScore?: number;
  signalStrategy?: string;
  proposed: boolean;
  blocked: boolean;
  walletSide?: "YES" | "NO";
  hoursToClose?: number;
  tradable: boolean;
  referenceOnly: boolean;
  stale: boolean;
}

export interface LatticePayload {
  points: LatticePoint[];
  stats: {
    liveContracts: number;
    tradable: number;
    referenceOnly: number;
    signalsBlue: number;
    blocked: number;
    stale: number;
    eclActive: number;
    walletActive: number;
    crossVenueCandidates: number;
    avgSpread: number;
    medianLiquidity: number;
    totalVolume24h: number;
  };
  builtAt: number;
}

export async function morphishLattice(): Promise<LatticePayload> {
  const [{ markets }, links] = await Promise.all([
    getMarkets(),
    getCrossVenueLinks().catch(() => [] as CrossVenueLink[]),
  ]);
  const now = Date.now();
  return measureSync("hot.morphish_lattice", () => {
    const sigs = recentSignals(now);
    const bestSig = new Map<string, SignalResult>();
    for (const s of sigs) {
      if (!s.conditionId) continue;
      const cur = bestSig.get(s.conditionId);
      if (!cur || s.score > cur.score) bestSig.set(s.conditionId, s);
    }
    const points: LatticePoint[] = [];
    const spreads: number[] = [];
    const liqs: number[] = [];
    let volume = 0;
    for (const m of markets) {
      if (m.outcomeType !== "binary") continue;
      const sig = bestSig.get(m.conditionId);
      const meta = sig?.meta ?? {};
      const intel = getWalletIntel(m.conditionId);
      const stale = now - m.fetchedAt > 60_000;
      if (m.spread !== undefined) spreads.push(m.spread);
      liqs.push(m.liquidity);
      volume += m.volume24h;
      points.push({
        id: m.conditionId,
        venueId: m.venueId,
        question: m.question,
        category: categorizeMarket({ question: m.question, category: m.category, tags: m.tags }),
        prob: m.midpoint ?? m.yesPrice,
        shadowProb: num(meta.pShadow),
        edgeAfterCost: num(meta.edgeAfterCost) ?? num(meta.remainingEdge) ?? num(meta.netEdge),
        spread: m.spread,
        liquidity: m.liquidity,
        volume24h: m.volume24h,
        signalScore: sig?.score,
        signalStrategy: sig?.strategy,
        proposed: sig?.status === "proposed",
        blocked: sig?.status === "rejected",
        walletSide: intel?.entries[0]?.side,
        hoursToClose: m.endDate ? (new Date(m.endDate).getTime() - now) / 3_600_000 : undefined,
        tradable: m.tradable,
        referenceOnly: m.referenceOnly,
        stale,
      });
    }
    liqs.sort((a, b) => a - b);
    return {
      points,
      stats: {
        liveContracts: points.length,
        tradable: points.filter((p) => p.tradable && !p.referenceOnly).length,
        referenceOnly: points.filter((p) => p.referenceOnly).length,
        signalsBlue: points.filter((p) => p.proposed && (p.edgeAfterCost ?? 0) > 0).length,
        blocked: points.filter((p) => p.blocked).length,
        stale: points.filter((p) => p.stale).length,
        eclActive: sigs.filter((s) => s.strategy === "ecl").length,
        walletActive: sigs.filter((s) => s.strategy.startsWith("wallet_")).length,
        crossVenueCandidates: links.filter(
          (l) => l.matchStatus === "strong_candidate" || l.matchStatus === "exact",
        ).length,
        avgSpread: spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : 0,
        medianLiquidity: liqs.length ? liqs[Math.floor(liqs.length / 2)] : 0,
        totalVolume24h: volume,
      },
      builtAt: now,
    };
  });
}

// ── Tail probability ridge ───────────────────────────────────────────────────

export interface RidgeCurve {
  conditionId: string;
  question: string;
  venueId: string;
  threshold: number;
  direction: "above" | "below";
  daysLeft: number;
  spot: number;
  volDaily: number;
  spotFreshnessMs: number;
  marketProb?: number;
  shadowProb: number;
  tailMass: number;
  requiredMovePct: number;
  /** density over log-move grid: x = move fraction, y = relative density */
  points: { x: number; y: number }[];
  strikeX: number;
  selected: boolean;
}

export interface RidgePayload {
  curves: RidgeCurve[];
  note: string;
  builtAt: number;
}

/** lognormal terminal density over a ±4σ move grid (drift-free, stated) */
function densityCurve(volDaily: number, daysLeft: number): { xs: number[]; ys: number[] } {
  const sigma = Math.max(1e-6, volDaily * Math.sqrt(Math.max(daysLeft, 1e-6)));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i <= 80; i++) {
    const x = -4 * sigma + (8 * sigma * i) / 80; // log-move
    const y = Math.exp((-x * x) / (2 * sigma * sigma));
    xs.push(x);
    ys.push(y);
  }
  return { xs, ys };
}

export async function morphishRidge(selectedId?: string): Promise<RidgePayload> {
  const { markets } = await getMarkets();
  const now = Date.now();
  // terminal crypto-threshold markets with parseable structure, nearest close first
  const parsed = markets
    .filter((m) => m.outcomeType === "binary" && m.endDate)
    .map((m) => ({ m, th: parseCryptoThreshold(m.question, m.endDate) }))
    .filter((x): x is { m: NormalizedMarket; th: NonNullable<ReturnType<typeof parseCryptoThreshold>> } =>
      x.th !== null && x.th.kind === "terminal" && x.th.coinbaseProduct !== undefined)
    .map((x) => ({ ...x, daysLeft: (new Date(x.m.endDate!).getTime() - now) / 86_400_000 }))
    .filter((x) => x.daysLeft > 0 && x.daysLeft < 120)
    .sort((a, b) =>
      a.m.conditionId === selectedId ? -1 : b.m.conditionId === selectedId ? 1 : a.daysLeft - b.daysLeft,
    )
    .slice(0, 10);

  const products = [...new Set(parsed.map((x) => x.th.coinbaseProduct!))].slice(0, 4);
  const refs = new Map<string, { spot: number; ts: number; vol?: number }>();
  for (const p of products) {
    const spot = await getSpotRef(p).catch(() => undefined);
    if (!spot) continue;
    const vol = await getRealizedVolDaily(p).catch(() => undefined);
    refs.set(p, { spot: spot.price, ts: spot.ts, vol });
  }

  const curves = measureSync("hot.morphish_ridge", () => {
    const out: RidgeCurve[] = [];
    for (const { m, th, daysLeft } of parsed) {
      const ref = refs.get(th.coinbaseProduct!);
      if (!ref || ref.vol === undefined) continue;
      const shadow = cryptoShadowProb(ref.spot, th.threshold, ref.vol, daysLeft, th.direction);
      const { xs, ys } = densityCurve(ref.vol, daysLeft);
      const strikeX = Math.log(th.threshold / ref.spot);
      out.push({
        conditionId: m.conditionId,
        question: m.question,
        venueId: m.venueId,
        threshold: th.threshold,
        direction: th.direction,
        daysLeft: Number(daysLeft.toFixed(2)),
        spot: ref.spot,
        volDaily: ref.vol,
        spotFreshnessMs: now - ref.ts,
        marketProb: m.midpoint ?? m.yesPrice,
        shadowProb: shadow,
        // cryptoShadowProb is ALREADY direction-adjusted — the mass in the
        // market-relevant tail is the shadow itself for both directions
        tailMass: shadow,
        requiredMovePct: (th.threshold - ref.spot) / ref.spot,
        points: xs.map((x, i) => ({ x: Number(x.toFixed(5)), y: Number(ys[i].toFixed(4)) })),
        strikeX: Number(strikeX.toFixed(5)),
        selected: m.conditionId === selectedId,
      });
    }
    return out;
  });
  return {
    curves,
    note: "drift-free lognormal terminal densities from Coinbase spot + realized vol — a stated model, not fair value; touch contracts are excluded (period extremes are not priceable from spot alone)",
    builtAt: now,
  };
}

// ── Relationship graph ───────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  type: "market" | "event" | "venue" | "wallet" | "signal" | "source" | "category";
  label: string;
  score?: number;
  venueId?: string;
  size: number; // display radius hint
  meta?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type:
    | "same_event"
    | "cross_venue"
    | "rule_conflict"
    | "wallet_position"
    | "signal_link"
    | "reference_link"
    | "category_link";
  strength: number;
  tone: "blue" | "gray" | "red";
  dotted: boolean;
  note: string;
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    nodes: number;
    edges: number;
    conflicts: number;
    walletConsensus: number;
    crossVenuePairs: number;
    avgMatchScore: number;
  };
  histogram: { bucket: number; count: number }[];
  builtAt: number;
}

export async function morphishGraph(): Promise<GraphPayload> {
  const [{ markets }, links, walletName] = await Promise.all([
    getMarkets(),
    getCrossVenueLinks().catch(() => [] as CrossVenueLink[]),
    walletNamesMemo(),
  ]);
  const now = Date.now();
  return measureSync("hot.morphish_graph", () => {
    const byId = new Map(markets.map((m) => [m.conditionId, m]));
    const sigs = recentSignals(now);
    const nodes = new Map<string, GraphNode>();
    // edge ids are React keys downstream — a market carrying several signals
    // must not emit duplicate cat:/evt: edges, so edges dedupe by id
    const edgeById = new Map<string, GraphEdge>();
    const addNode = (n: GraphNode) => {
      if (!nodes.has(n.id)) nodes.set(n.id, n);
    };
    const addEdge = (e: GraphEdge) => {
      if (!edgeById.has(e.id)) edgeById.set(e.id, e);
    };

    // seed: markets carrying the strongest recent signals
    const topSigs = sigs
      .filter((s) => s.conditionId && byId.has(s.conditionId))
      .sort((a, b) => b.score - a.score)
      .slice(0, 24);
    for (const s of topSigs) {
      const m = byId.get(s.conditionId!)!;
      const mid = `mkt:${m.conditionId}`;
      addNode({
        id: mid, type: "market", label: m.question.slice(0, 48),
        venueId: m.venueId, score: s.score, size: 10 + Math.min(14, m.volume24h / 50_000),
        meta: { conditionId: m.conditionId, prob: m.midpoint ?? m.yesPrice },
      });
      addNode({ id: `sig:${s.strategy}`, type: "signal", label: s.strategyLabel, size: 8 });
      addEdge({
        id: `e:sig:${s.id}`, source: `sig:${s.strategy}`, target: mid, type: "signal_link",
        strength: s.score / 100, tone: s.status === "proposed" ? "blue" : "gray",
        dotted: s.status !== "proposed",
        note: `${s.strategyLabel} ${s.score}/100 — ${s.status}`,
      });
      const cat = categorizeMarket({ question: m.question, category: m.category, tags: m.tags });
      addNode({ id: `cat:${cat}`, type: "category", label: cat, size: 12 });
      addEdge({
        id: `e:cat:${m.conditionId}`, source: `cat:${cat}`, target: mid, type: "category_link",
        strength: 0.3, tone: "gray", dotted: true, note: `category cluster: ${cat}`,
      });
      if (m.eventSlug) {
        addNode({ id: `evt:${m.eventSlug}`, type: "event", label: m.eventSlug.slice(0, 32), size: 9 });
        addEdge({
          id: `e:evt:${m.conditionId}`, source: `evt:${m.eventSlug}`, target: mid,
          type: "same_event", strength: 0.6, tone: "gray", dotted: false,
          note: "same underlying event",
        });
      }
    }

    // cross-venue links among displayed markets (conflicts in red)
    let conflictCount = 0;
    const matchScores: number[] = [];
    for (const l of links) {
      const a = `mkt:${l.sourceMarketId}`, b = `mkt:${l.targetMarketId}`;
      if (!nodes.has(a) && !nodes.has(b)) continue;
      for (const [id, marketId, title, venue] of [
        [a, l.sourceMarketId, l.sourceTitle, l.sourceVenueId],
        [b, l.targetMarketId, l.targetTitle, l.targetVenueId],
      ] as const) {
        const m = byId.get(marketId);
        addNode({
          id, type: "market", label: (m?.question ?? title).slice(0, 48), venueId: venue,
          size: 9, meta: { conditionId: marketId, prob: m?.midpoint ?? m?.yesPrice },
        });
      }
      const conflict = l.matchStatus === "conflict";
      if (conflict) conflictCount += 1;
      matchScores.push(l.matchScore);
      addEdge({
        id: `e:xv:${l.id}`, source: a, target: b, type: conflict ? "rule_conflict" : "cross_venue",
        strength: l.matchScore,
        tone: conflict ? "red" : l.matchStatus === "strong_candidate" ? "blue" : "gray",
        dotted: l.matchStatus !== "strong_candidate" && l.matchStatus !== "exact",
        note: `${l.matchStatus.replace(/_/g, " ")} (score ${(l.matchScore * 100).toFixed(0)}%)${conflict ? " — rules DISAGREE" : ""}`,
      });
    }

    // tracked wallets with live stances in displayed markets
    let consensusPairs = 0;
    for (const [conditionId] of byId) {
      const mid = `mkt:${conditionId}`;
      if (!nodes.has(mid)) continue;
      const intel: MarketWalletIntel | undefined = getWalletIntel(conditionId);
      if (!intel) continue;
      const sameSide = intel.entries.length > 1 && intel.crowdSameSide === intel.entries.length;
      if (sameSide) consensusPairs += 1;
      for (const e of intel.entries.slice(0, 4)) {
        const wid = `wal:${e.walletId}`;
        addNode({
          id: wid, type: "wallet", label: e.displayName ?? walletName.get(e.walletId) ?? e.walletId.slice(0, 8),
          size: 8, meta: { walletId: e.walletId, label: e.label },
        });
        addEdge({
          id: `e:w:${e.walletId}:${conditionId}`, source: wid, target: mid, type: "wallet_position",
          strength: Math.min(1, e.sizeUsd / 1_000),
          tone: e.label === "fade_candidate" ? "red" : e.exiting ? "gray" : "blue",
          dotted: e.exiting,
          note: `${e.label.replace(/_/g, " ")} holds ${e.side} $${Math.round(e.sizeUsd)} @ ${(e.avgEntryPrice * 100).toFixed(0)}c${e.exiting ? " (exiting)" : ""}`,
        });
      }
    }

    // venues as anchors
    for (const v of new Set([...nodes.values()].map((n) => n.venueId).filter(Boolean))) {
      addNode({ id: `ven:${v}`, type: "venue", label: v!, size: 13 });
    }
    for (const n of [...nodes.values()]) {
      if (n.type === "market" && n.venueId) {
        addEdge({
          id: `e:v:${n.id}`, source: `ven:${n.venueId}`, target: n.id, type: "reference_link",
          strength: 0.2, tone: "gray", dotted: true, note: `listed on ${n.venueId}`,
        });
      }
    }

    const hist = new Array(10).fill(0);
    for (const s of matchScores) hist[Math.min(9, Math.floor(s * 10))] += 1;
    return {
      nodes: [...nodes.values()].slice(0, 140),
      edges: [...edgeById.values()].slice(0, 280),
      stats: {
        nodes: nodes.size,
        edges: edgeById.size,
        conflicts: conflictCount,
        walletConsensus: consensusPairs,
        crossVenuePairs: matchScores.length,
        avgMatchScore: matchScores.length ? matchScores.reduce((a, b) => a + b, 0) / matchScores.length : 0,
      },
      histogram: hist.map((count, i) => ({ bucket: i / 10, count })),
      builtAt: now,
    };
  });
}

// ── Status strip ─────────────────────────────────────────────────────────────

export function morphishPerf(): Record<string, unknown> {
  const snap = perfSnapshot();
  return snap as unknown as Record<string, unknown>;
}

export { measure };
export { capitalLockupCost };
