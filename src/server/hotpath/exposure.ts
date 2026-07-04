// Live exposure cache — the risk engine's hot-path data source.
//
// Order previews and risk checks read portfolio/exposure state from this
// in-memory cache (1–3ms budget) instead of recomputing from the store. The
// cache refreshes asynchronously after fills, cancels and resets; live-order
// paths force a synchronous refresh when the cache exceeds the freshness
// threshold rather than trading on stale exposure.

import type { PortfolioState, TerminalMode } from "@/lib/types";
import { computePortfolio } from "../portfolio";
import { incr, measure } from "../perf";

interface Entry {
  state: PortfolioState;
  ts: number;
  refreshing: Promise<void> | null;
}

const g = globalThis as unknown as { __pqExposure?: Map<string, Entry> };

function cacheMap(): Map<string, Entry> {
  if (!g.__pqExposure) g.__pqExposure = new Map();
  return g.__pqExposure;
}

const SOFT_TTL_MS = 10_000;

async function refresh(mode: TerminalMode): Promise<void> {
  const map = cacheMap();
  const entry = map.get(mode);
  if (entry?.refreshing) return entry.refreshing;
  const p = measure("cold.exposure_refresh", () => computePortfolio(mode)).then(
    (state) => {
      map.set(mode, { state, ts: Date.now(), refreshing: null });
    },
    () => {
      const e = map.get(mode);
      if (e) e.refreshing = null;
    },
  );
  if (entry) entry.refreshing = p;
  else map.set(mode, { state: undefined as unknown as PortfolioState, ts: 0, refreshing: p });
  return p;
}

export interface ExposureRead {
  state: PortfolioState;
  ageMs: number;
  stale: boolean;
}

/**
 * Read exposure from cache. First call (or `forceFresh`) computes
 * synchronously; otherwise returns cached state instantly and refreshes in
 * the background once the soft TTL passes.
 */
export async function getExposure(
  mode: TerminalMode,
  opts: { forceFresh?: boolean; maxAgeMs?: number } = {},
): Promise<ExposureRead> {
  const map = cacheMap();
  const entry = map.get(mode);
  const maxAge = opts.maxAgeMs ?? 60_000;

  if (!entry || entry.ts === 0 || opts.forceFresh) {
    await refresh(mode);
  } else {
    const age = Date.now() - entry.ts;
    if (age > maxAge) {
      // too stale to trade on — block until refreshed
      await refresh(mode);
    } else if (age > SOFT_TTL_MS && !entry.refreshing) {
      void refresh(mode); // async top-up, serve cached now
      incr("exposure.softRefresh");
    }
  }
  const fresh = map.get(mode)!;
  incr("exposure.reads");
  return {
    state: fresh.state,
    ageMs: Date.now() - fresh.ts,
    stale: Date.now() - fresh.ts > maxAge,
  };
}

/** call after fills / cancels / cash changes / resets */
export function invalidateExposure(mode: TerminalMode): void {
  incr("exposure.invalidations");
  void refresh(mode);
}
