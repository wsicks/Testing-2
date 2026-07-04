"use client";

// Live feed hook on top of the shared single-connection SSE client.
// Event delivery is rAF-batched: one React commit per animation frame no
// matter how many events arrive.

import { useEffect, useState } from "react";
import type { FeedEvent } from "@/lib/types";
import {
  subscribeFeedClient,
  type StreamStatus,
} from "./feedClient";

export type { StreamStatus };

export function useFeed(maxEvents = 120) {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>("connecting");

  useEffect(() => {
    return subscribeFeedClient(
      (batch) => {
        setEvents((prev) => {
          const next = [...batch].reverse().concat(prev);
          return next.length > maxEvents ? next.slice(0, maxEvents) : next;
        });
      },
      (s) => setStatus(s),
    );
  }, [maxEvents]);

  return { events, status };
}
