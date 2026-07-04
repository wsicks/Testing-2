"use client";

// SSE subscription to /api/stream with reconnect + connection state.

import { useEffect, useRef, useState } from "react";
import type { FeedEvent } from "@/lib/types";

export type StreamStatus = "connecting" | "open" | "reconnecting";

export function useFeed(maxEvents = 120) {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      es = new EventSource("/api/stream");
      es.onopen = () => setStatus("open");
      es.onmessage = (msg) => {
        try {
          const evt = JSON.parse(msg.data) as FeedEvent;
          if (seen.current.has(evt.id)) return;
          seen.current.add(evt.id);
          if (seen.current.size > 1000) {
            seen.current = new Set([...seen.current].slice(-400));
          }
          setEvents((prev) => [evt, ...prev].slice(0, maxEvents));
        } catch {
          /* ignore malformed frames */
        }
      };
      es.onerror = () => {
        setStatus("reconnecting");
        es?.close();
        retryTimer = setTimeout(connect, 3_000);
      };
    };
    connect();
    return () => {
      stopped = true;
      es?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [maxEvents]);

  return { events, status };
}
