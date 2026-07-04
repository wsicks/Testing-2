"use client";

import { useFeed } from "@/hooks/useFeed";
import { fmtTime } from "@/lib/format";
import type { FeedEventType } from "@/lib/types";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { EmptyNote } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const TYPE_LABEL: Record<FeedEventType, string> = {
  market_discovered: "MKT+",
  price_moved: "MOVE",
  signal_created: "SIG+",
  signal_rejected: "SIG-",
  risk_check_failed: "RISK",
  order_preview_created: "PREV",
  order_submitted: "ORD+",
  order_filled: "FILL",
  order_canceled: "CXL",
  api_error: "ERR",
  ws_reconnect: "WS",
  user_action: "USER",
  scanner_tick: "SCAN",
  kill_switch: "KILL",
};

export function LiveFeed({ className }: { className?: string }) {
  const { events, status } = useFeed(120);
  return (
    <Panel
      title="live feed"
      className={className}
      right={
        <Badge variant={status === "open" ? "pos" : "warn"}>{status}</Badge>
      }
      bodyClassName="overflow-y-auto p-0"
    >
      {events.length === 0 ? (
        <EmptyNote>waiting for events…</EmptyNote>
      ) : (
        <ul>
          {events.map((e) => (
            <li
              key={e.id}
              className={cn(
                "flex items-start gap-1.5 border-b border-line/60 px-2 py-0.5 text-2xs leading-snug",
                e.severity === "error" && "bg-neg-soft",
                e.severity === "warn" && "bg-warn-soft/50",
              )}
            >
              <span className="num shrink-0 text-ink-faint">{fmtTime(e.ts)}</span>
              <span
                className={cn(
                  "num w-9 shrink-0 font-bold",
                  e.severity === "error"
                    ? "text-neg"
                    : e.severity === "warn"
                      ? "text-warn"
                      : "text-ink-soft",
                )}
              >
                {TYPE_LABEL[e.type] ?? e.type}
              </span>
              <span className="min-w-0 break-words">{e.message}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
