"use client";

// Shared SSE client: ONE EventSource per browser tab, fanned out to all
// subscribers, with requestAnimationFrame batching so a burst of events costs
// a single React commit. If the queue exceeds its bound the oldest events are
// dropped (latest-state-authoritative) and counted for the perf panel.

import type { FeedEvent } from "@/lib/types";

export type StreamStatus = "connecting" | "open" | "reconnecting";

interface FeedClient {
  es: EventSource | null;
  status: StreamStatus;
  queue: FeedEvent[];
  seen: Set<string>;
  subscribers: Set<(events: FeedEvent[], status: StreamStatus) => void>;
  statusSubs: Set<(status: StreamStatus) => void>;
  rafPending: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  dropped: number;
  ingested: number;
  lastIngestToFlushMs: number;
  flushLatencies: number[];
}

const g = globalThis as unknown as { __pqFeedClient?: FeedClient };

const QUEUE_CAP = 500;

function client(): FeedClient {
  if (!g.__pqFeedClient) {
    g.__pqFeedClient = {
      es: null,
      status: "connecting",
      queue: [],
      seen: new Set(),
      subscribers: new Set(),
      statusSubs: new Set(),
      rafPending: false,
      retryTimer: null,
      dropped: 0,
      ingested: 0,
      lastIngestToFlushMs: 0,
      flushLatencies: [],
    };
  }
  return g.__pqFeedClient;
}

function setStatus(s: StreamStatus): void {
  const c = client();
  c.status = s;
  c.statusSubs.forEach((cb) => cb(s));
}

function flush(): void {
  const c = client();
  c.rafPending = false;
  if (c.queue.length === 0) return;
  const batch = c.queue.splice(0, c.queue.length);
  const t0 = performance.now();
  c.subscribers.forEach((cb) => cb(batch, c.status));
  const ms = performance.now() - t0;
  c.lastIngestToFlushMs = ms;
  c.flushLatencies.push(ms);
  if (c.flushLatencies.length > 200) c.flushLatencies.splice(0, 100);
}

function scheduleFlush(): void {
  const c = client();
  if (c.rafPending) return;
  c.rafPending = true;
  requestAnimationFrame(flush);
}

function connect(): void {
  const c = client();
  if (c.es) return;
  const es = new EventSource("/api/stream");
  c.es = es;
  es.onopen = () => setStatus("open");
  es.onmessage = (msg) => {
    try {
      const evt = JSON.parse(msg.data) as FeedEvent;
      if (c.seen.has(evt.id)) return;
      c.seen.add(evt.id);
      if (c.seen.size > 2000) c.seen = new Set([...c.seen].slice(-800));
      c.ingested += 1;
      c.queue.push(evt);
      if (c.queue.length > QUEUE_CAP) {
        // UI fell behind — drop oldest, keep latest state authoritative
        c.dropped += c.queue.length - QUEUE_CAP;
        c.queue.splice(0, c.queue.length - QUEUE_CAP);
      }
      scheduleFlush();
    } catch {
      /* malformed frame */
    }
  };
  es.onerror = () => {
    setStatus("reconnecting");
    es.close();
    c.es = null;
    if (!c.retryTimer) {
      c.retryTimer = setTimeout(() => {
        c.retryTimer = null;
        if (c.subscribers.size > 0) connect();
      }, 3_000);
    }
  };
}

export function subscribeFeedClient(
  onEvents: (events: FeedEvent[], status: StreamStatus) => void,
  onStatus?: (status: StreamStatus) => void,
): () => void {
  const c = client();
  c.subscribers.add(onEvents);
  if (onStatus) {
    c.statusSubs.add(onStatus);
    onStatus(c.status);
  }
  connect();
  return () => {
    c.subscribers.delete(onEvents);
    if (onStatus) c.statusSubs.delete(onStatus);
    if (c.subscribers.size === 0 && c.es) {
      c.es.close();
      c.es = null;
      setStatus("connecting");
    }
  };
}

export function feedClientStats(): {
  dropped: number;
  ingested: number;
  status: StreamStatus;
  flushP95Ms: number;
} {
  const c = client();
  const sorted = [...c.flushLatencies].sort((a, b) => a - b);
  return {
    dropped: c.dropped,
    ingested: c.ingested,
    status: c.status,
    flushP95Ms: sorted.length
      ? Number(sorted[Math.floor(sorted.length * 0.95)].toFixed(2))
      : 0,
  };
}
