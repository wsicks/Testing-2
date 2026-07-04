// Per-source transparency ledger: every external data source exposes its
// license note, update cadence, rate-limit posture, and live success/failure
// counters. Surfaced on /sources and in venue-health chips.

import type { SourceStatus, VenueId } from "@/lib/types";
import type { SourceMetaStatic } from "./types";

interface Counters {
  requests: number;
  failures: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastError?: string;
}

const g = globalThis as unknown as {
  __pqSources?: Map<VenueId, Counters>;
};

function counters(): Map<VenueId, Counters> {
  if (!g.__pqSources) g.__pqSources = new Map();
  return g.__pqSources;
}

function get(venueId: VenueId): Counters {
  const m = counters();
  let c = m.get(venueId);
  if (!c) {
    c = { requests: 0, failures: 0 };
    m.set(venueId, c);
  }
  return c;
}

export function recordSourceSuccess(venueId: VenueId): void {
  const c = get(venueId);
  c.requests += 1;
  c.lastSuccessAt = Date.now();
}

export function recordSourceFailure(venueId: VenueId, err: unknown): void {
  const c = get(venueId);
  c.requests += 1;
  c.failures += 1;
  c.lastFailureAt = Date.now();
  c.lastError = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
}

export function sourceStatus(venueId: VenueId, meta: SourceMetaStatic): SourceStatus {
  const c = get(venueId);
  return {
    venueId,
    name: meta.name,
    licenseNote: meta.licenseNote,
    updateFrequency: meta.updateFrequency,
    rateLimitNote: meta.rateLimitNote,
    dataClass: meta.dataClass,
    requests: c.requests,
    failures: c.failures,
    lastSuccessAt: c.lastSuccessAt,
    lastFailureAt: c.lastFailureAt,
    lastError: c.lastError,
    freshnessMs: c.lastSuccessAt !== undefined ? Date.now() - c.lastSuccessAt : undefined,
  };
}
