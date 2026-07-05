// Runtime error log — every caught failure in the scanner / foundry /
// autopilot / strategy pipeline lands here instead of vanishing into console
// noise. Entries are deduped by (source, message) with a running count, so a
// failure that fires every scan tick is one row with count=400, not 400 rows.
//
// The in-memory ring is the hot read; a capped KV blob persists across
// restarts. The checked-in ERRORLOG.md at the repo root is the durable,
// human-triaged registry — rows from here graduate into that file when they
// are diagnosed, and the file records the fixing commit.

import { genId } from "@/lib/utils";
import { getStore } from "./store";

export interface ErrorLogEntry {
  id: string;
  /** where it happened: "scanner", "strategy:ecl", "foundry:attention", "client:/morphish" */
  source: string;
  message: string;
  detail?: string;
  count: number;
  firstAt: number;
  lastAt: number;
  resolved: boolean;
}

const KV_KEY = "errors:log";
const CAP = 200;
const PERSIST_MIN_INTERVAL_MS = 15_000;

interface ErrLogGlobal {
  byKey: Map<string, ErrorLogEntry>;
  hydrating: Promise<void> | null;
  hydrated: boolean;
  lastPersistAt: number;
  persistQueued: boolean;
}

const g = globalThis as unknown as { __eqErrLog?: ErrLogGlobal };

function state(): ErrLogGlobal {
  if (!g.__eqErrLog) {
    g.__eqErrLog = {
      byKey: new Map(),
      hydrating: null,
      hydrated: false,
      lastPersistAt: 0,
      persistQueued: false,
    };
  }
  return g.__eqErrLog;
}

const keyOf = (source: string, message: string) => `${source}|${message}`;

async function hydrate(): Promise<void> {
  const s = state();
  if (s.hydrated) return;
  s.hydrating ??= (async () => {
    try {
      const store = await getStore();
      const rows = (await store.getKV<ErrorLogEntry[]>(KV_KEY)) ?? [];
      for (const row of rows) {
        const k = keyOf(row.source, row.message);
        const mem = s.byKey.get(k);
        if (!mem) {
          s.byKey.set(k, row);
        } else {
          // an error already re-observed in memory keeps its fresher lastAt;
          // fold the persisted count in so restarts don't reset history
          mem.count += row.count;
          mem.firstAt = Math.min(mem.firstAt, row.firstAt);
        }
      }
    } catch {
      /* a broken store must not break error logging */
    }
    s.hydrated = true;
  })();
  await s.hydrating;
}

function rows(): ErrorLogEntry[] {
  return [...state().byKey.values()].sort((a, b) => b.lastAt - a.lastAt);
}

function schedulePersist(): void {
  const s = state();
  if (s.persistQueued) return;
  const wait = Math.max(0, s.lastPersistAt + PERSIST_MIN_INTERVAL_MS - Date.now());
  s.persistQueued = true;
  const t = setTimeout(() => {
    s.persistQueued = false;
    s.lastPersistAt = Date.now();
    void (async () => {
      try {
        const store = await getStore();
        await store.setKV(KV_KEY, rows().slice(0, CAP));
      } catch {
        /* persistence is best-effort; the ring still has the data */
      }
    })();
  }, wait);
  if (typeof t === "object" && "unref" in t) t.unref();
}

/**
 * Record a caught error. Synchronous and infallible by design — callers sit
 * in catch blocks and must never throw again.
 */
export function logError(source: string, err: unknown, detail?: string): void {
  try {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    const s = state();
    const k = keyOf(source, message);
    const now = Date.now();
    const existing = s.byKey.get(k);
    if (existing) {
      existing.count += 1;
      existing.lastAt = now;
      if (detail) existing.detail = detail.slice(0, 300);
      // a recurring error is not resolved, whatever a human clicked earlier
      existing.resolved = false;
    } else {
      // evict the stalest resolved row first, then the stalest row
      if (s.byKey.size >= CAP) {
        const all = rows();
        const victim = [...all].reverse().find((r) => r.resolved) ?? all[all.length - 1];
        if (victim) s.byKey.delete(keyOf(victim.source, victim.message));
      }
      s.byKey.set(k, {
        id: genId("err"),
        source: source.slice(0, 80),
        message,
        detail: detail?.slice(0, 300),
        count: 1,
        firstAt: now,
        lastAt: now,
        resolved: false,
      });
    }
    void hydrate().catch(() => {});
    schedulePersist();
  } catch {
    /* never throw from the error logger */
  }
}

export async function listErrors(): Promise<ErrorLogEntry[]> {
  await hydrate();
  return rows();
}

export async function resolveError(id: string): Promise<boolean> {
  await hydrate();
  const entry = rows().find((r) => r.id === id);
  if (!entry) return false;
  entry.resolved = true;
  schedulePersist();
  return true;
}

export async function errorLogStats(): Promise<{ open: number; total: number }> {
  await hydrate();
  const all = rows();
  return { open: all.filter((r) => !r.resolved).length, total: all.length };
}
