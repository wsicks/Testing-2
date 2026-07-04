// Lightweight performance instrumentation for the hot path.
//
// Ring-buffer histograms (p50/p95/p99) + counters, with an OpenTelemetry
// facade: every measure() opens a span via @opentelemetry/api, which is a
// no-op unless the operator wires an OTel SDK/exporter — zero overhead by
// default, standard tracing when configured. Snapshot served by /api/perf.
//
// Honest boundary: `upstream.*` metrics time EXTERNAL Polymarket calls and
// carry no latency promise; `hot.*` metrics time internal processing on data
// already in memory and are held to the <20ms p95 budget.

import { trace } from "@opentelemetry/api";

const RING = 512;

interface PerfGlobal {
  hists: Map<string, { buf: Float64Array; idx: number; count: number; last: number }>;
  counters: Map<string, number>;
  startedAt: number;
}

const g = globalThis as unknown as { __pqPerf?: PerfGlobal };

function state(): PerfGlobal {
  if (!g.__pqPerf) {
    g.__pqPerf = { hists: new Map(), counters: new Map(), startedAt: Date.now() };
  }
  return g.__pqPerf;
}

export function recordLatency(label: string, ms: number): void {
  const s = state();
  let h = s.hists.get(label);
  if (!h) {
    h = { buf: new Float64Array(RING), idx: 0, count: 0, last: 0 };
    s.hists.set(label, h);
  }
  h.buf[h.idx] = ms;
  h.idx = (h.idx + 1) % RING;
  h.count += 1;
  h.last = ms;
}

export function incr(counter: string, n = 1): void {
  const s = state();
  s.counters.set(counter, (s.counters.get(counter) ?? 0) + n);
}

const tracer = trace.getTracer("polyquant");

/** time a sync hot-path operation */
export function measureSync<T>(label: string, fn: () => T): T {
  const span = tracer.startSpan(label);
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    recordLatency(label, performance.now() - t0);
    span.end();
  }
}

/** time an async operation */
export async function measure<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const span = tracer.startSpan(label);
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    recordLatency(label, performance.now() - t0);
    span.end();
  }
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

export interface HistSnapshot {
  label: string;
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  last: number;
}

export function perfSnapshot(): {
  hists: HistSnapshot[];
  counters: Record<string, number>;
  cacheHitRate?: number;
  uptimeMs: number;
  memoryMb: number;
} {
  const s = state();
  const hists: HistSnapshot[] = [];
  for (const [label, h] of s.hists) {
    const n = Math.min(h.count, RING);
    const vals = Array.from(h.buf.slice(0, n)).sort((a, b) => a - b);
    hists.push({
      label,
      count: h.count,
      p50: round(percentile(vals, 50)),
      p95: round(percentile(vals, 95)),
      p99: round(percentile(vals, 99)),
      max: round(vals[vals.length - 1] ?? 0),
      last: round(h.last),
    });
  }
  hists.sort((a, b) => a.label.localeCompare(b.label));
  const counters = Object.fromEntries(s.counters);
  const hit = counters["cache.hit"] ?? 0;
  const miss = counters["cache.miss"] ?? 0;
  return {
    hists,
    counters,
    cacheHitRate: hit + miss > 0 ? Number((hit / (hit + miss)).toFixed(3)) : undefined,
    uptimeMs: Date.now() - s.startedAt,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}

function round(v: number): number {
  return v >= 100 ? Math.round(v) : Number(v.toFixed(2));
}
