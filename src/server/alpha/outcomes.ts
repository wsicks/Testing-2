// Outcome tracker — measures what actually happened after every signal.
//
// For each directional signal the scanner produces, we snapshot the entry
// mid and then capture direction-adjusted drift at 5s, 30s, 5m, 1h and 24h.
// Short buckets use in-process timers reading the in-memory registry (no
// network, no DB); long buckets are swept on scan ticks WITHIN a per-bucket
// lateness tolerance. A capture that can't happen on time — process restart,
// market disappeared, tolerance exceeded — is recorded as MISSED. A late
// price is NOT a 5-second drift, so it is never recorded as one.
//
// Rejected signals are tracked too (flagged wasProposed=false): a gate that
// correctly blocked a trade still produces forward evidence, and wallet
// forward-performance needs that evidence to ever unlock copying.
//
// Wallet attribution: forward-evidence updates are queued during the sweep
// and flushed SEQUENTIALLY — concurrent read-modify-writes on the wallet
// blob would silently drop samples.

import type { AlphaOutcome, DecayBucketKey } from "@/lib/alpha/types";
import { BUCKET_MS, BUCKET_ORDER } from "@/lib/alpha/score";
import type { NormalizedMarket, SignalResult } from "@/lib/types";
import { genId } from "@/lib/utils";
import { regByCondition } from "../hotpath/registry";
import { listOutcomes, saveOutcomes } from "./repo";
import { recordWalletForward } from "./walletRadar";

interface OutcomesGlobal {
  rows: AlphaOutcome[];
  hydrating: Promise<void> | null;
  hydrated: boolean;
  dirty: boolean;
  persisting: boolean;
}

const g = globalThis as unknown as { __eqOutcomes?: OutcomesGlobal };

function state(): OutcomesGlobal {
  if (!g.__eqOutcomes) {
    g.__eqOutcomes = { rows: [], hydrating: null, hydrated: false, dirty: false, persisting: false };
  }
  return g.__eqOutcomes;
}

async function hydrate(): Promise<void> {
  const s = state();
  if (s.hydrated) return;
  // in-flight guard: concurrent first callers share one hydration; rows
  // tracked in between must never be clobbered by a second load
  s.hydrating ??= (async () => {
    const loaded = await listOutcomes();
    const have = new Set(s.rows.map((r) => r.id));
    // heal: drop rows recorded before the binary-only gate (asset-market
    // dollar "drift" masquerading as probability points)
    const clean = loaded.filter((r) => r.entryMid > 0 && r.entryMid < 1);
    s.rows = [...clean.filter((r) => !have.has(r.id)), ...s.rows];
    s.hydrated = true;
  })();
  await s.hydrating;
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

interface ForwardUpdate {
  walletId: string;
  drift1h: number;
  drift5s?: number;
}

/**
 * capture one bucket NOW. Returns a queued wallet-forward update when the
 * 1h bucket lands for a wallet-attributed signal — the caller flushes these
 * sequentially, never concurrently.
 */
function capture(o: AlphaOutcome, bucket: DecayBucketKey, now: number): ForwardUpdate | null {
  if (o.buckets[bucket]?.drift !== undefined || o.buckets[bucket]?.missed) return null;
  const mid = midFor(o.conditionId);
  if (mid === undefined) {
    o.buckets[bucket] = { missed: true, at: now };
    return null;
  }
  o.buckets[bucket] = { drift: Number(adjustedDrift(o, mid).toFixed(4)), at: now };
  if (bucket === "b1h" && o.walletId) {
    // convert SIGNAL drift to the WALLET's own drift: a fade that worked is
    // NEGATIVE evidence about the faded wallet, not positive
    const sign = o.walletSign ?? 1;
    return {
      walletId: o.walletId,
      drift1h: o.buckets.b1h!.drift! * sign,
      drift5s: o.buckets.b5s?.drift !== undefined ? o.buckets.b5s.drift * sign : undefined,
    };
  }
  return null;
}

function markMissed(o: AlphaOutcome, bucket: DecayBucketKey, now: number): void {
  if (o.buckets[bucket]?.drift !== undefined || o.buckets[bucket]?.missed) return;
  o.buckets[bucket] = { missed: true, at: now };
}

/**
 * how late a sweep capture may run and still honestly represent the bucket.
 * Short buckets are timer-owned: a sweep can only ever see them late, so the
 * sweep exclusively marks them MISSED. Long buckets tolerate one scan-cadence
 * of slack relative to their horizon.
 */
const SWEEP_TOLERANCE_MS: Record<DecayBucketKey, number> = {
  b5s: 0,
  b30s: 0,
  b5m: 90_000, // 5m ± 1.5min
  b1h: 10 * 60_000, // 1h ± 10min
  b24h: 60 * 60_000, // 24h ± 1h
};

/** cap on new trackers per scan so a noisy strategy can't flood the list */
const MAX_NEW_PER_SCAN = 24;
/** in-memory row cap — matches the persistence cap so memory and disk agree */
const MAX_ROWS = 2_000;

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
    // probability-point drift only exists for binary outcome tokens — an
    // asset market's dollar moves would poison every evidence consumer
    if (m.outcomeType !== "binary" || entryMid <= 0 || entryMid >= 1) continue;
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
      walletSign: sig.strategy === "wallet_fade" ? -1 : 1,
      createdAt: now,
      buckets: {},
    };
    s.rows.push(row);
    added += 1;

    // short buckets: in-process timers reading in-memory prices only. If a
    // restart kills the timer, the sweep marks the bucket MISSED — a late
    // price is never recorded as a 5s/30s drift.
    for (const bucket of ["b5s", "b30s"] as const) {
      const t = setTimeout(() => {
        capture(row, bucket, Date.now());
        void persist().catch(() => {});
      }, BUCKET_MS[bucket]);
      if (typeof t === "object" && "unref" in t) t.unref();
    }
  }

  // sweep: capture long buckets that are due and inside tolerance; mark
  // everything past tolerance (including restart-lost short buckets) MISSED
  const forwardQueue: ForwardUpdate[] = [];
  let swept = 0;
  for (const row of s.rows) {
    for (const bucket of BUCKET_ORDER) {
      const cell = row.buckets[bucket];
      if (cell?.drift !== undefined || cell?.missed) continue;
      const due = row.createdAt + BUCKET_MS[bucket];
      const tolerance = SWEEP_TOLERANCE_MS[bucket];
      // timers own short buckets for 2× their window before the sweep acts
      const timerGrace = bucket === "b5s" || bucket === "b30s" ? BUCKET_MS[bucket] : 0;
      if (now < due + timerGrace) continue;
      if (tolerance > 0 && now <= due + tolerance) {
        const fu = capture(row, bucket, now);
        if (fu) forwardQueue.push(fu);
      } else {
        markMissed(row, bucket, now);
      }
      swept += 1;
    }
  }

  // drop rows whose every bucket is resolved and are older than 48h, then
  // enforce the shared cap so memory and persistence never diverge
  const cutoff = now - 48 * 3_600_000;
  const before = s.rows.length;
  s.rows = s.rows.filter((r) => {
    const done = BUCKET_ORDER.every(
      (b) => r.buckets[b]?.drift !== undefined || r.buckets[b]?.missed,
    );
    return !(done && r.createdAt < cutoff);
  });
  if (s.rows.length > MAX_ROWS) s.rows = s.rows.slice(-MAX_ROWS);

  // flush wallet forward evidence SEQUENTIALLY (read-modify-write on one blob)
  for (const fu of forwardQueue) {
    try {
      await recordWalletForward(fu.walletId, fu.drift1h, fu.drift5s);
    } catch {
      /* a failed forward update must not block outcome persistence */
    }
  }

  if (added > 0 || swept > 0 || s.rows.length !== before) await persist();
  return added;
}

export async function allOutcomes(): Promise<AlphaOutcome[]> {
  await hydrate();
  return state().rows;
}
