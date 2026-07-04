// Audit trail: every signal, approval, order event, cancel, fill and error is
// recorded via this module. Audit writes also fan out to the live feed.
//
// Hot-path friendly: audit() enqueues and returns immediately; persistence is
// an append-only ASYNC batch flush so trading paths never block on the store
// (or PostgreSQL under the prisma driver). Queue depth and flush latency are
// exported to the perf panel.

import type {
  AuditActor,
  AuditEventRecord,
  AuditSeverity,
  FeedEventType,
} from "@/lib/types";
import { genId } from "@/lib/utils";
import { publishFeed } from "./events";
import { incr, recordLatency } from "./perf";
import { getStore } from "./store";

interface AuditGlobal {
  queue: AuditEventRecord[];
  flushing: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const g = globalThis as unknown as { __pqAudit?: AuditGlobal };

function state(): AuditGlobal {
  if (!g.__pqAudit) g.__pqAudit = { queue: [], flushing: false, timer: null };
  return g.__pqAudit;
}

async function flush(): Promise<void> {
  const s = state();
  if (s.flushing || s.queue.length === 0) return;
  s.flushing = true;
  const batch = s.queue.splice(0, s.queue.length);
  const t0 = performance.now();
  try {
    const store = await getStore();
    for (const evt of batch) {
      await store.addAudit(evt);
    }
  } catch (err) {
    console.error("[polyquant] audit flush failed:", err);
    incr("audit.flushErrors");
  } finally {
    recordLatency("cold.audit_flush", performance.now() - t0);
    s.flushing = false;
    if (s.queue.length > 0) scheduleFlush();
  }
}

function scheduleFlush(): void {
  const s = state();
  if (s.timer) return;
  s.timer = setTimeout(() => {
    s.timer = null;
    void flush();
  }, 200);
  if (typeof s.timer === "object" && "unref" in s.timer) s.timer.unref();
}

export async function audit(
  actor: AuditActor,
  type: string,
  message: string,
  opts: {
    severity?: AuditSeverity;
    data?: Record<string, unknown>;
    feedType?: FeedEventType;
  } = {},
): Promise<void> {
  const evt: AuditEventRecord = {
    id: genId("aud"),
    ts: Date.now(),
    actor,
    type,
    severity: opts.severity ?? "info",
    message,
    data: opts.data,
  };
  const s = state();
  s.queue.push(evt);
  incr("audit.enqueued");
  if (s.queue.length >= 25) void flush();
  else scheduleFlush();

  if (opts.feedType) {
    publishFeed(opts.feedType, message, {
      severity: opts.severity,
      data: opts.data,
    });
  }
}

/** queue depth for the perf panel */
export function auditQueueDepth(): number {
  return state().queue.length;
}

/** drain the queue — used by tests and graceful worker shutdown */
export async function flushAuditQueue(): Promise<void> {
  await flush();
}
