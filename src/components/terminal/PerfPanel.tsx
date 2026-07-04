"use client";

// Performance observability panel. hot.* metrics are internal operations on
// in-memory data and are held to the <20ms p95 budget; upstream.* metrics
// time EXTERNAL Polymarket APIs and are shown for transparency, not judged
// against internal budgets.

import { useEffect, useState } from "react";
import { usePerf } from "@/hooks/api";
import { feedClientStats } from "@/hooks/feedClient";
import { fmtAgo, fmtNum } from "@/lib/format";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Num } from "@/components/ui/num";
import { EmptyNote, Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

function HistTable({
  rows,
  budgetMs,
}: {
  rows: { label: string; count: number; p50: number; p95: number; p99: number; max: number; last: number }[];
  budgetMs?: number;
}) {
  if (!rows.length) return <EmptyNote>no samples yet</EmptyNote>;
  return (
    <table className="w-full text-2xs">
      <thead>
        <tr className="border-b border-line-strong text-left">
          {["metric", "n", "p50", "p95", "p99", "max", "last", budgetMs ? "budget" : ""].map(
            (h) => (
              <th key={h} className="cell label">{h}</th>
            ),
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((h) => {
          const breach = budgetMs !== undefined && h.p95 > budgetMs;
          return (
            <tr key={h.label} className={cn("border-b border-line/60", breach && "bg-neg-soft/50")}>
              <td className="cell font-semibold">{h.label}</td>
              <td className="cell"><Num className="text-ink-faint">{fmtNum(h.count)}</Num></td>
              <td className="cell"><Num>{h.p50}ms</Num></td>
              <td className="cell">
                <Num tone={breach ? "neg" : budgetMs !== undefined ? "pos" : undefined}>{h.p95}ms</Num>
              </td>
              <td className="cell"><Num>{h.p99}ms</Num></td>
              <td className="cell"><Num className="text-ink-faint">{h.max}ms</Num></td>
              <td className="cell"><Num className="text-ink-faint">{h.last}ms</Num></td>
              {budgetMs !== undefined ? (
                <td className="cell">
                  <Badge variant={breach ? "neg" : "pos"}>{breach ? "breach" : "ok"}</Badge>
                </td>
              ) : (
                <td className="cell" />
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function PerfPanel() {
  const { data, isLoading } = usePerf();
  const [client, setClient] = useState(() => ({ dropped: 0, ingested: 0, flushP95Ms: 0, status: "connecting" as string }));
  useEffect(() => {
    const t = setInterval(() => setClient(feedClientStats()), 2_000);
    return () => clearInterval(t);
  }, []);

  const hot = data?.hists.filter((h) => h.label.startsWith("hot.")) ?? [];
  const upstream = data?.hists.filter((h) => h.label.startsWith("upstream.")) ?? [];
  const other = data?.hists.filter((h) => !h.label.startsWith("hot.") && !h.label.startsWith("upstream.")) ?? [];

  return (
    <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
      <Panel
        title="hot path — internal (<20ms p95 budget)"
        right={isLoading ? <Spinner /> : <Badge variant="pos">in-memory operations</Badge>}
        bodyClassName="p-0"
      >
        <HistTable rows={hot} budgetMs={data?.budgetsMs.hotP95Target ?? 20} />
      </Panel>

      <Panel
        title="upstream — external polymarket apis (no latency promise)"
        right={<Badge variant="warn">external infrastructure</Badge>}
        bodyClassName="p-0"
      >
        <HistTable rows={upstream} />
        <p className="border-t border-line px-2 py-1 text-3xs text-ink-faint">
          External API, wallet, blockchain and order-matching latency is not
          under this app&apos;s control and is deliberately reported separately
          from internal budgets.
        </p>
      </Panel>

      <Panel title="background / cold path" bodyClassName="p-0">
        <HistTable rows={other} />
      </Panel>

      <Panel title="system & stream" bodyClassName="grid grid-cols-2 gap-1 md:grid-cols-4">
        <Stat label="cache hit rate" v={data?.cacheHitRate !== undefined ? `${(data.cacheHitRate * 100).toFixed(1)}%` : "—"} />
        <Stat label="registry size" v={data ? `${data.registry.size} mkts` : "—"} />
        <Stat label="registry age" v={data ? fmtAgo(data.registry.updatedAt) : "—"} />
        <Stat label="audit queue depth" v={String(data?.auditQueueDepth ?? "—")} />
        <Stat label="memory (rss)" v={data ? `${data.memoryMb} MB` : "—"} />
        <Stat label="uptime" v={data ? `${Math.floor(data.uptimeMs / 60000)}m` : "—"} />
        <Stat label="sse events (client)" v={String(client.ingested)} />
        <Stat
          label="dropped updates (client)"
          v={String(client.dropped)}
          tone={client.dropped > 0 ? "warn" : undefined}
        />
        <Stat label="sse flush p95 (client)" v={`${client.flushP95Ms}ms`} />
        <Stat label="stream status" v={client.status} />
        <Stat label="exposure reads" v={String(data?.counters["exposure.reads"] ?? 0)} />
        <Stat label="exposure invalidations" v={String(data?.counters["exposure.invalidations"] ?? 0)} />
      </Panel>
    </div>
  );
}

function Stat({ label, v, tone }: { label: string; v: string; tone?: "warn" }) {
  return (
    <div className="border border-line bg-paper px-1.5 py-1">
      <div className="label">{label}</div>
      <Num tone={tone}>{v}</Num>
    </div>
  );
}
