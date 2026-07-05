// WALLET RADAR — public Polymarket wallet intelligence.
//
// Discovery: large recent trades + top holders of the most active markets
// (the legacy leaderboard API is dead — recorded in the source registry).
// Scoring: category-specific skill from closed positions with explicit cost
// estimates. Forward evidence: measured drift after WE detect an entry —
// the only honest basis for "copyable edge".
//
// Hard rules, enforced here and in the strategies that consume this data:
// never deanonymize (only the venue's own public pseudonym is stored), never
// coordinate trades, never auto-copy live, never chase stale entries.

import type {
  DimensionSkill,
  MarketWalletIntel,
  TrackedWalletRecord,
  WalletMarketEntry,
} from "@/lib/alpha/types";
import {
  categorizeMarket,
  durationBucket,
  labelWallet,
  liquidityBucket,
  rejectCandidate,
  roiWithoutBestTrade,
  skillForDimension,
  walletCandidateScore,
  type ClosedPositionLite,
} from "@/lib/alpha/score";
import type { NormalizedMarket } from "@/lib/types";
import { audit } from "../audit";
import { measure } from "../perf";
import {
  fetchHolders,
  fetchLargeTrades,
  fetchWalletPositions,
  fetchWalletTrades,
  politeDelay,
  toTradeLite,
  type DataApiPosition,
} from "./dataApi";
import {
  getWalletTrades,
  listWallets,
  saveWallets,
  saveWalletTrades,
  upsertWallet,
} from "./repo";

// ── In-memory intel cache (scanner reads this; never blocks the scan) ────────

interface RadarGlobal {
  intel: Map<string, MarketWalletIntel>;
  intelBuiltAt: number;
  refreshing: boolean;
}

const g = globalThis as unknown as { __eqWalletRadar?: RadarGlobal };

function state(): RadarGlobal {
  if (!g.__eqWalletRadar) {
    g.__eqWalletRadar = { intel: new Map(), intelBuiltAt: 0, refreshing: false };
  }
  return g.__eqWalletRadar;
}

/** cold-path read used by the scanner — returns whatever is cached, instantly */
export function getWalletIntel(conditionId: string): MarketWalletIntel | undefined {
  return state().intel.get(conditionId);
}

export function walletIntelInfo(): { markets: number; builtAt: number } {
  const s = state();
  return { markets: s.intel.size, builtAt: s.intelBuiltAt };
}

// ── Position → skill inputs ──────────────────────────────────────────────────

function isClosed(p: DataApiPosition): boolean {
  return p.redeemable || p.curPrice === 0 || p.curPrice === 1 || p.currentValue === 0;
}

/**
 * openTs: earliest observed BUY per conditionId from the wallet's public
 * tape. Position HOLDING duration = close time − first entry; without an
 * observed entry the duration is honestly unknown (the positions endpoint
 * has no open timestamp), never guessed.
 */
function toClosedLite(
  p: DataApiPosition,
  openTsByCondition: Map<string, number>,
): ClosedPositionLite {
  const closedAt = p.endDate ? new Date(p.endDate).getTime() : undefined;
  const openTs = openTsByCondition.get(p.conditionId);
  return {
    pnl: p.cashPnl,
    initialValue: p.initialValue,
    shares: p.totalBought,
    win: p.cashPnl > 0,
    closedAt,
    dimensions: [
      `cat:${categorizeMarket({ question: p.title })}`,
      openTs !== undefined && closedAt !== undefined && closedAt > openTs
        ? durationBucket(closedAt, openTs)
        : "dur:unknown",
      liquidityBucket(undefined),
    ],
  };
}

export interface WalletScoreResult {
  record: TrackedWalletRecord;
  rejected?: string;
}

/**
 * Score one wallet from its public positions + recent trades.
 * Pure-ish: network fetches happen here; math lives in lib/alpha/score.
 */
export async function scoreWallet(
  walletId: string,
  opts: { manuallyAdded?: boolean; pseudonym?: string; existing?: TrackedWalletRecord } = {},
): Promise<WalletScoreResult> {
  const now = Date.now();
  const positions = await fetchWalletPositions(walletId);
  const trades = (await fetchWalletTrades(walletId, 200)).map(toTradeLite);
  await saveWalletTrades(walletId, [...trades].reverse()); // store oldest→newest

  const openTsByCondition = new Map<string, number>();
  for (const t of trades) {
    if (t.side !== "BUY") continue;
    const cur = openTsByCondition.get(t.conditionId);
    if (cur === undefined || t.ts < cur) openTsByCondition.set(t.conditionId, t.ts);
  }
  const closed = positions.filter(isClosed).map((p) => toClosedLite(p, openTsByCondition));
  const open = positions.filter((p) => !isClosed(p));
  const dims = new Set<string>();
  for (const c of closed) for (const d of c.dimensions) dims.add(d);
  const dimensions: DimensionSkill[] = [...dims]
    .map((d) => skillForDimension(d, closed))
    .filter((d) => d.sampleSize > 0)
    .sort((a, b) => b.sampleSize - a.sampleSize);
  const allSkill = skillForDimension("all", closed.map((c) => ({ ...c, dimensions: ["all"] })));

  // both-sides fast round trips (maker/wash heuristic) from the trade tape
  const byMarket = new Map<string, { buys: number[]; sells: number[] }>();
  for (const t of trades) {
    const row = byMarket.get(t.conditionId) ?? { buys: [], sells: [] };
    (t.side === "BUY" ? row.buys : row.sells).push(t.ts);
    byMarket.set(t.conditionId, row);
  }
  let fastRoundTrips = 0;
  for (const row of byMarket.values()) {
    const crossed = row.buys.some((b) => row.sells.some((s) => Math.abs(s - b) < 10 * 60_000));
    if (crossed) fastRoundTrips += 1;
  }
  const fastRoundTripShare = byMarket.size > 0 ? fastRoundTrips / byMarket.size : 0;

  const totalInvested = closed.reduce((a, p) => a + p.initialValue, 0);
  const extremeShare =
    positions.length > 0
      ? positions.filter((p) => p.avgPrice <= 0.1 || p.avgPrice >= 0.9).length / positions.length
      : 0;
  // short-duration share over positions with KNOWN duration only — unknown
  // durations must not manufacture a "closing-market sniper" label
  const knownDur = closed.filter((c) => !c.dimensions.includes("dur:unknown"));
  const shortDurShare =
    knownDur.length >= 10
      ? knownDur.filter((c) => c.dimensions.some((d) => d === "dur:closing" || d === "dur:short")).length /
        knownDur.length
      : 0;
  const unrealizedShare = (() => {
    const openVal = open.reduce((a, p) => a + Math.abs(p.cashPnl), 0);
    const closedVal = closed.reduce((a, p) => a + Math.abs(p.pnl), 0);
    return openVal + closedVal > 0 ? openVal / (openVal + closedVal) : 0;
  })();

  const roiNoBest = roiWithoutBestTrade(closed);
  const bestDim = [...dimensions]
    .filter((d) => d.dimension.startsWith("cat:") && d.sampleSize >= 20)
    .sort((a, b) => b.costAdjRoi - a.costAdjRoi)[0];

  const labels = labelWallet({
    totalClosed: closed.length,
    costAdjTotalRoi: allSkill.costAdjRoi,
    dimensions,
    avgEntryNotional: closed.length ? totalInvested / closed.length : 0,
    extremePriceShare: extremeShare,
    fastRoundTripShare,
    roiWithoutBest: roiNoBest,
    forward: opts.existing?.forward,
    shortDurationShare: shortDurShare,
  });

  const lastTradeTs = trades.length ? Math.max(...trades.map((t) => t.ts)) : 0;
  const rejected = rejectCandidate({
    bestDim,
    totalClosed: closed.length,
    luckyConcentration: allSkill.luckyConcentration,
    roiWithoutBest: roiNoBest,
    forward: opts.existing?.forward,
    unrealizedShare,
    illiquidShare: 0, // liquidity at historical trade time is not observable — never used to reject
    costAdjTotalRoi: allSkill.costAdjRoi,
    rawTotalRoi: allSkill.rawRoi,
    daysSinceLastTrade: lastTradeTs ? (now - lastTradeTs) / 86_400_000 : 999,
  });

  const candidateScore = walletCandidateScore({
    bestDim,
    capitalEfficiency: allSkill.capitalEfficiency,
    luckyConcentration: allSkill.luckyConcentration,
    crowding: 0,
    slippagePenaltyShare:
      allSkill.rawRoi > 0 ? Math.max(0, (allSkill.rawRoi - allSkill.costAdjRoi) / allSkill.rawRoi) : 0,
  });

  const record: TrackedWalletRecord = {
    walletId: walletId.toLowerCase(),
    pseudonym: opts.pseudonym ?? opts.existing?.pseudonym,
    publicProfileUrl: undefined,
    label: labels.primary,
    labels: labels.all,
    firstSeen: opts.existing?.firstSeen ?? now,
    lastSeen: now,
    manuallyAdded: opts.manuallyAdded ?? opts.existing?.manuallyAdded ?? false,
    autoDiscovered: opts.existing?.autoDiscovered ?? !opts.manuallyAdded,
    status: opts.manuallyAdded
      ? "tracked"
      : rejected
        ? "rejected"
        : "tracked",
    rejectReason: rejected ?? undefined,
    candidateScore,
    totalClosed: closed.length,
    totalPnl: closed.reduce((a, p) => a + p.pnl, 0),
    costAdjTotalRoi: allSkill.costAdjRoi,
    dimensions,
    forward: opts.existing?.forward,
    lastScoredAt: now,
    lastIntelAt: opts.existing?.lastIntelAt,
  };
  return { record, rejected: rejected ?? undefined };
}

// ── Discovery ────────────────────────────────────────────────────────────────

export interface DiscoveryResult {
  candidates: number;
  scored: number;
  tracked: number;
  rejected: number;
}

/**
 * Nightly (or on-demand) discovery: pull public wallets from large trades and
 * top holders of active markets, score each, keep the ones that survive the
 * rejection rules. Bounded to `maxScore` wallet scorings per run.
 */
export async function discoverWallets(
  topMarkets: NormalizedMarket[],
  maxScore = 20,
): Promise<DiscoveryResult> {
  const existing = await listWallets();
  const known = new Set(existing.map((w) => w.walletId));
  const candidates = new Map<string, string | undefined>(); // wallet → pseudonym

  try {
    const large = await fetchLargeTrades(500, 100);
    for (const t of large) {
      const id = t.proxyWallet.toLowerCase();
      if (!known.has(id)) candidates.set(id, t.pseudonym);
    }
  } catch (err) {
    await audit("scanner", "wallet_discovery_error", `large-trades fetch failed: ${String(err)}`, { severity: "warn" });
  }

  for (const m of topMarkets.slice(0, 5)) {
    if (m.venueId !== "polymarket") continue;
    try {
      const holderGroups = await fetchHolders(m.conditionId, 8);
      for (const grp of holderGroups) {
        for (const h of grp.holders) {
          const id = h.proxyWallet.toLowerCase();
          if (!known.has(id) && !candidates.has(id))
            candidates.set(id, h.displayUsernamePublic ? h.pseudonym : undefined);
        }
      }
      await politeDelay();
    } catch {
      /* best-effort per market */
    }
  }

  let scored = 0, tracked = 0, rejectedCount = 0;
  for (const [walletId, pseudonym] of candidates) {
    if (scored >= maxScore) break;
    try {
      const { record, rejected } = await scoreWallet(walletId, { pseudonym });
      scored += 1;
      if (rejected) rejectedCount += 1;
      else tracked += 1;
      await upsertWallet(record);
      await politeDelay(250);
    } catch {
      /* skip wallets whose data fails to load */
    }
  }
  await audit(
    "scanner",
    "wallet_discovery",
    `Wallet discovery: ${candidates.size} public candidates, ${scored} scored, ${tracked} tracked, ${rejectedCount} rejected by quality rules`,
    { data: { candidates: candidates.size, scored, tracked, rejected: rejectedCount } },
  );
  return { candidates: candidates.size, scored, tracked, rejected: rejectedCount };
}

// ── Live intel for the scanner ───────────────────────────────────────────────

/**
 * Rebuild the per-market wallet intel map from tracked wallets' open
 * positions + recent trades. Network work happens here (radar tick);
 * the scanner only ever reads the in-memory result.
 */
export async function refreshWalletIntel(maxWallets = 25): Promise<number> {
  const s = state();
  if (s.refreshing) return s.intel.size;
  s.refreshing = true;
  try {
    return await measure("alpha.wallet_intel_refresh", async () => {
      const now = Date.now();
      const wallets = (await listWallets())
        .filter((w) => w.status === "tracked")
        .sort((a, b) => (b.candidateScore ?? 0) - (a.candidateScore ?? 0))
        .slice(0, maxWallets);

      const intel = new Map<string, MarketWalletIntel>();
      const refreshedIds: string[] = [];
      for (const w of wallets) {
        try {
          const positions = await fetchWalletPositions(w.walletId, 100);
          const freshTrades = (await fetchWalletTrades(w.walletId, 60)).map(toTradeLite);
          await saveWalletTrades(w.walletId, [...freshTrades].reverse());
          const open = positions.filter((p) => !isClosed(p) && p.currentValue > 1);
          for (const p of open) {
            const side: "YES" | "NO" = p.outcomeIndex === 0 ? "YES" : "NO";
            const marketTrades = freshTrades.filter((t) => t.conditionId === p.conditionId);
            const buys = marketTrades.filter((t) => t.side === "BUY" && t.asset === p.asset);
            const sells = marketTrades.filter((t) => t.side === "SELL" && t.asset === p.asset);
            const lastBuyTs = buys.length ? Math.max(...buys.map((t) => t.ts)) : 0;
            const lastSellTs = sells.length ? Math.max(...sells.map((t) => t.ts)) : 0;
            const cat = `cat:${categorizeMarket({ question: p.title })}`;
            const entry: WalletMarketEntry = {
              walletId: w.walletId,
              displayName: w.pseudonym,
              label: w.label,
              side,
              avgEntryPrice: p.avgPrice,
              sizeUsd: p.currentValue,
              lastTradeTs: Math.max(lastBuyTs, lastSellTs, 0),
              entries: buys.length,
              stillHolding: p.size > 0,
              exiting: lastSellTs > lastBuyTs,
              dimensionSkill: w.dimensions.find((d) => d.dimension === cat),
              forward: w.forward,
            };
            const cur = intel.get(p.conditionId) ?? { entries: [], crowdSameSide: 0, updatedAt: now };
            cur.entries.push(entry);
            intel.set(p.conditionId, cur);
          }
          refreshedIds.push(w.walletId);
          await politeDelay(120);
        } catch {
          /* one wallet failing must not kill the refresh */
        }
      }
      for (const row of intel.values()) {
        const yes = row.entries.filter((e) => e.side === "YES").length;
        row.crowdSameSide = Math.max(yes, row.entries.length - yes);
        row.updatedAt = now;
      }
      s.intel = intel;
      s.intelBuiltAt = now;
      // persist lastIntelAt on a FRESH read-modify-write: mutating the rows
      // fetched before the (minutes-long) network loop would lose any
      // concurrent update (e.g. forward-evidence writes), and on the Prisma
      // store the early objects are detached parses whose mutations vanish
      const latest = await listWallets();
      for (const id of refreshedIds) {
        const row = latest.find((x) => x.walletId === id);
        if (row) row.lastIntelAt = now;
      }
      await saveWallets(latest);
      return intel.size;
    });
  } finally {
    s.refreshing = false;
  }
}

/**
 * Update a wallet's forward evidence from a completed outcome measurement.
 * Incremental mean — called by the outcome tracker when a wallet-attributed
 * signal's 1h bucket lands.
 */
export async function recordWalletForward(
  walletId: string,
  drift1h: number,
  drift5s: number | undefined,
): Promise<void> {
  const wallets = await listWallets();
  const w = wallets.find((x) => x.walletId === walletId);
  if (!w) return;
  const f = w.forward ?? { samples: 0, avgDrift1h: 0, avgDrift5s: 0, updatedAt: 0 };
  const n = f.samples + 1;
  w.forward = {
    samples: n,
    avgDrift1h: f.avgDrift1h + (drift1h - f.avgDrift1h) / n,
    avgDrift5s:
      drift5s !== undefined ? f.avgDrift5s + (drift5s - f.avgDrift5s) / n : f.avgDrift5s,
    updatedAt: Date.now(),
  };
  await saveWallets(wallets);
}

/** re-score all tracked wallets (daily) — refreshes labels and skill tables */
export async function rescoreTrackedWallets(max = 25): Promise<number> {
  const wallets = (await listWallets()).filter(
    (w) => w.status === "tracked" || w.manuallyAdded,
  );
  let n = 0;
  for (const w of wallets.slice(0, max)) {
    try {
      const { record } = await scoreWallet(w.walletId, {
        manuallyAdded: w.manuallyAdded,
        pseudonym: w.pseudonym,
        existing: w,
      });
      // merge live-updated fields from a FRESH read: the loop spans minutes
      // of network I/O, and forward evidence recorded meanwhile must not be
      // reverted by this stale snapshot
      const fresh = (await listWallets()).find((x) => x.walletId === w.walletId);
      if (fresh?.forward && (!record.forward || fresh.forward.updatedAt > (record.forward.updatedAt ?? 0))) {
        record.forward = fresh.forward;
      }
      if (fresh?.lastIntelAt && fresh.lastIntelAt > (record.lastIntelAt ?? 0)) {
        record.lastIntelAt = fresh.lastIntelAt;
      }
      await upsertWallet(record);
      n += 1;
      await politeDelay(250);
    } catch {
      /* keep going */
    }
  }
  return n;
}

export { getWalletTrades };
