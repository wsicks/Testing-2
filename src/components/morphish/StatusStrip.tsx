"use client";

// Bottom micro status strip — internal latencies vs upstream latencies,
// cache hit rate, queue depth, scan cycle. Internal `hot.*` metrics carry
// the <20ms budget; `upstream.*` are external round-trips and never promise
// anything.

import { useMorphishSummary, usePerf } from "@/hooks/api";
import { useTerminal } from "@/store/terminal";
import { Num } from "@/components/ui/num";
import { cn } from "@/lib/utils";

interface Hist { label: string; p50: number; p95: number; count: number }

function cell(hists: Hist[] | undefined, label: string): string {
  const h = hists?.find((x) => x.label === label);
  return h ? `${h.p50.toFixed(1)}/${h.p95.toFixed(1)}ms` : "—";
}

export function StatusStrip() {
  const mode = useTerminal((s) => s.mode);
  const { data: perf } = usePerf();
  const { data: sum } = useMorphishSummary(mode);
  const p = perf as
    | { hists?: Hist[]; counters?: Record<string, number>; cacheHitRate?: number; memoryMb?: number }
    | undefined;
  const hot = (label: string) => cell(p?.hists, label);
  const hotBad = p?.hists?.some((h) => h.label.startsWith("hot.") && h.p95 > 20);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 border border-line bg-panel px-2 py-1 text-3xs uppercase text-ink-faint">
      <span>updated <Num className="text-ink">{sum ? `${Math.round(sum.scan.ageMs / 1000)}s ago` : "—"}</Num></span>
      <span>cycle <Num className="text-ink">#{sum?.scan.cycle ?? "—"}</Num></span>
      <span className={cn(hotBad && "text-warn")}>
        signal engine <Num className="text-ink">{hot("hot.signal_market")}</Num>
      </span>
      <span>risk <Num className="text-ink">{hot("hot.order_preview")}</Num></span>
      <span>lattice <Num className="text-ink">{hot("hot.morphish_lattice")}</Num></span>
      <span>top gem <Num className="text-ink">{hot("hot.morphish_topgem")}</Num></span>
      <span>graph <Num className="text-ink">{hot("hot.morphish_graph")}</Num></span>
      <span>upstream gamma <Num className="text-ink">{cell(p?.hists, "upstream.gamma")}</Num></span>
      <span>clob <Num className="text-ink">{cell(p?.hists, "upstream.clob")}</Num></span>
      <span>kalshi <Num className="text-ink">{cell(p?.hists, "upstream.kalshi")}</Num></span>
      <span>cache hit <Num className="text-ink">{p?.cacheHitRate !== undefined ? `${(p.cacheHitRate * 100).toFixed(0)}%` : "—"}</Num></span>
      {/* unmeasured is "—", never a fabricated healthy zero/ok */}
      <span>audit queue <Num className="text-ink">{p ? (p.counters?.["audit.queued"] ?? 0) : "—"}</Num></span>
      <span>stale mkts <Num className={cn("text-ink", (sum?.scan.ageMs ?? 0) > 60_000 && "text-warn")}>{sum ? (sum.scan.ageMs > 60_000 ? "registry stale" : "ok") : "—"}</Num></span>
      <span className="ml-auto">eventquant morphish · build {process.env.NEXT_PUBLIC_BUILD ?? "dev"}</span>
    </div>
  );
}
