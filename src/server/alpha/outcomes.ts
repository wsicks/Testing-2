// Outcome tracker — measures what actually happened after every signal.
//
// For each directional signal the scanner produces, we snapshot the entry
// mid and then capture direction-adjusted drift at 5s, 30s, 5m, 1h and 24h.
// Short buckets use in-process timers reading the in-memory registry (no
// network, no DB); long buckets are swept on scan ticks. A capture that
// can't happen (process restart, market disappeared) is recorded as MISSED —
// never interpolated, never faked.
//
// Rejected signals are tracked too (flagged wasProposed=false): a gate that
// correctly blocked a trade still produces forward evidence, and wallet
// forward-performance needs that evidence to ever unlock copying.

import type { AlphaOutcome, DecayBucketKey } from "@/lib/alpha/types";
import { BUCKET_MS, BUCKET_ORDER } from "@/lib/alpha/score";
import type { NormalizedMarket, SignalResult } from "@/lib/types";
import { genId } from "@/lib/utils";
import { regByCondition } from "../hotpath/registry";
import { listOutcomes, saveOutcomes } from "./repo";
import { recordWalletForward } from "./walletRadar";

interface OutcomesGlobal {
  rows: AlphaOutcome[];
  hydrated: boolean;
  dirty: boolean;
  persisting: boolean;
}

const g = globalThis as unknown as { __eqOutcomes?: OutcomesGlobal };

function state(): OutcomesGlobal {
  if (!g.__eqOutcomes) g.__eqOutcomes = { rows: [], hydrated: false, dirty: false, persisting: false };
  return g.__eqOutcomes;
}

async function hydrate(): Promise<void> {
  const s = state();
  if (s.hydrated) return;
  s.rows = await listOutcomes();
  s.hydrated = true;
}

async function persist(): Promise<void> {
  const s = state();
  if (s.persisting) {
    s.dirty = true;
    return;
  }
  s.persisting = true;
  try {
    do {
      s.dirty = false;
      await saveOutcomes(s.rows);
    } while (s.dirty);
  } finally {
    s.persisting = false;
  }
}

function midFor(conditionId: string): number | undefined {
  const m = regByCondition(conditionId);
  if (!m) return undefined;
  return m.midpoint ?? m.yesPrice;
}

/** direction-adjusted drift: positive = the market moved the signal's way */
function adjustedDrift(o: AlphaOutcome, currentMid: number): number {
  const raw = currentMid - o.entryMid;
  return o.direction === "BUY_YES" ? raw : -raw;
}

function capture(o: AlphaOutcome, bucket: DecayBucketKey, now: number): void {
  if (o.buckets[bucket]?.drift !== undefined || o.buckets[bucket]?.missed) return;
  const mid = midFor(o.conditionId);
  if (mid === undefined) {
    o.buckets[bucket] = { missed: true, at: now };
    return;
  }
  o.buckets[bucket] = { drift: Number(adjustedDrift(o, mid).toFixed(4)), at: now };
  if (bucket === "b1h" && o.walletId) {
    void recordWalletForward(
      o.walletId,
      o.buckets.b1h!.drift!,
      o.buckets.b5s?.drift,
    ).catch(() => {});
  }
}

/** cap on new trackers per scan so a noisy strategy can't flood the list */
const MAX_NEW_PER_SCAN = 24;

export async function trackSignalOutcomes(
  signals: SignalResult[],
  markets: NormalizedMarket[],
): Promise<number> {
  await hydrate();
  const s = state();
  const now = Date.now();
  const marketById = new Map(markets.map((m) => [m.conditionId, m]));
  let added = 0;

  for (const sig of signals) {
    if (added >= MAX_NEW_PER_SCAN) break;
    if (sig.direction === "NEUTRAL" || !sig.conditionId) continue;
    const m = marketById.get(sig.conditionId);
    const entryMid = m?.midpoint ?? m?.yesPrice;
    if (!m || entryMid === undefined) continue;
    const spread = m.spread;
    const row: AlphaOutcome = {
      id: genId("ao"),
      featureId: sig.strategy,
      signalId: sig.id,
      conditionId: sig.conditionId,
      direction: sig.direction,
      entryMid,
      spreadAtSignal: spread,
      bookAgeMsAtSignal: now - m.fetchedAt,
      tradable: spread !== undefined && spread <= 0.05 && m.tradable && !m.referenceOnly,
      wasProposed: sig.status === "proposed",
      walletId: typeof sig.meta?.walletId === "string" ? (sig.meta.walletId as string) : undefined,
      createdAt: now,
      buckets: {},
    };
    s.rows.push(row);
    added += 1;

    // short buckets: in-process timers reading in-memory prices only.
    // A restart before they fire leaves the bucket to be marked missed by
    // the sweep — honest by construction.
    for (const bucket of ["b5s", "b30s"] as const) {
      const t = setTimeout(() => {
        capture(row, bucket, Date.now());
        void persist().catch(() => {});
      }, BUCKET_MS[bucket]);
      if (typeof t === "object" && "unref" in t) t.unref();
    }
  }

  // sweep long buckets that came due (and short ones lost to restarts)
  let swept = 0;
  for (const row of s.rows) {
    for (const bucket of BUCKET_ORDER) {
      const due = row.createdAt + BUCKET_MS[bucket];
      const cell = row.buckets[bucket];
      if (cell?.drift !== undefined || cell?.missed) continue;
      // grace: short buckets are timer-owned for 2× their window
      if (now < due + (bucket === "b5s" || bucket === "b30s" ? BUCKET_MS[bucket] : 0)) continue;
      capture(row, bucket, now);
      swept += 1;
    }
  }

  // drop rows whose every bucket is resolved and are older than 48h
  const cutoff = now - 48 * 3_600_000;
  const before = s.rows.length;
  s.rows = s.rows.filter((r) => {
    const done = BUCKET_ORDER.every(
      (b) => r.buckets[b]?.drift !== undefined || r.buckets[b]?.missed,
    );
    return !(done && r.createdAt < cutoff);
  });

  if (added > 0 || swept > 0 || s.rows.length !== before) await persist();
  return added;
}

export async function allOutcomes(): Promise<AlphaOutcome[]> {
  await hydrate();
  return state().rows;
}
