// In-process live-feed bus. Backs the /api/stream SSE endpoint and keeps a
// ring buffer so late subscribers see recent history.

import { EventEmitter } from "node:events";
import type { AuditSeverity, FeedEvent, FeedEventType } from "@/lib/types";
import { genId } from "@/lib/utils";

interface FeedGlobal {
  emitter: EventEmitter;
  recent: FeedEvent[];
}

const g = globalThis as unknown as { __pqFeed?: FeedGlobal };

function state(): FeedGlobal {
  if (!g.__pqFeed) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(100);
    g.__pqFeed = { emitter, recent: [] };
  }
  return g.__pqFeed;
}

export function publishFeed(
  type: FeedEventType,
  message: string,
  opts: { severity?: AuditSeverity; data?: Record<string, unknown> } = {},
): FeedEvent {
  const evt: FeedEvent = {
    id: genId("evt"),
    ts: Date.now(),
    type,
    severity: opts.severity ?? "info",
    message,
    data: opts.data,
  };
  const s = state();
  s.recent.push(evt);
  if (s.recent.length > 250) s.recent.splice(0, s.recent.length - 250);
  s.emitter.emit("feed", evt);
  return evt;
}

export function subscribeFeed(cb: (evt: FeedEvent) => void): () => void {
  const s = state();
  s.emitter.on("feed", cb);
  return () => s.emitter.off("feed", cb);
}

export function recentFeed(limit = 100): FeedEvent[] {
  return state().recent.slice(-limit);
}
