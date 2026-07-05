// In-memory ring of recently persisted signals — the Morphish board (and any
// other hot-path consumer) reads signals from here with zero store/DB
// round-trips. The scanner pushes after each persist; entries expire with
// their signal TTL.

import type { SignalResult } from "@/lib/types";

interface CacheGlobal {
  rows: SignalResult[];
}

const g = globalThis as unknown as { __eqSignalCache?: CacheGlobal };

function state(): CacheGlobal {
  if (!g.__eqSignalCache) g.__eqSignalCache = { rows: [] };
  return g.__eqSignalCache;
}

const CAP = 400;

export function pushSignals(signals: SignalResult[]): void {
  const s = state();
  s.rows.push(...signals);
  if (s.rows.length > CAP) s.rows = s.rows.slice(-CAP);
}

/** newest first; expired signals filtered out */
export function recentSignals(now = Date.now()): SignalResult[] {
  return [...state().rows]
    .filter((r) => !r.expiresAt || r.expiresAt > now)
    .reverse();
}
