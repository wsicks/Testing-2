"use client";

// Morphish top command bar — dense header in the reference's layout. The
// clock ticks in local component state; data cells update from their own
// queries so one tick never re-renders the board.

import { useEffect, useState } from "react";
import { useHealth, useMorphishSummary, usePerf } from "@/hooks/api";
import { useTerminal } from "@/store/terminal";
import { Badge } from "@/components/ui/badge";
import { Num } from "@/components/ui/num";
import { cn } from "@/lib/utils";

function UtcClock() {
  // mounted guard: server HTML must not contain a wall-clock reading — it
  // would mismatch the client's first render on every hydration. The first
  // interval tick (≤1s) populates the clock; until then it shows "—".
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(t);
  }, []);
  return (
    <Num className="text-2xs font-bold tracking-wider">
      {now ? `${now.toISOString().slice(11, 19)} UTC` : "—"}
    </Num>
  );
}

export function CommandBar({ venueScope }: { venueScope: string }) {
  const mode = useTerminal((s) => s.mode);
  const { data: sum } = useMorphishSummary(mode);
  const { data: health } = useHealth();
  const { data: perf } = usePerf();
  const hot = (perf as { hists?: { label: string; p50: number; p95: number }[] } | undefined)?.hists?.filter(
    (h) => h.label.startsWith("hot."),
  );
  const p50 = hot?.length ? Math.max(...hot.map((h) => h.p50)) : undefined;
  const p95 = hot?.length ? Math.max(...hot.map((h) => h.p95)) : undefined;
  // undefined = health not yet known; never fabricate an OK
  const wsUp: boolean | undefined = health ? health.gamma.ok && health.clob.ok : undefined;
  const freshS = sum ? Math.round(sum.scan.ageMs / 1000) : undefined;

  return (
    <div className="flex items-center gap-3 border border-line bg-panel px-2 py-1">
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center border border-line-strong text-sm font-black">
          ✳
        </div>
        <div>
          <div className="text-3xs font-bold uppercase tracking-widest text-ink-faint">
            autonomous · {sum?.mode ?? mode} book · live on market
          </div>
          <div className="text-sm font-black tracking-wide">
            EVENTQUANT <span className="text-accent">MORPHISH</span>
            <span className="pl-2 text-3xs font-semibold uppercase text-ink-faint">{venueScope}</span>
          </div>
        </div>
      </div>
      <div className="hidden flex-1 items-center justify-center gap-3 md:flex">
        <Badge variant={mode === "live" ? "neg" : mode === "paper" ? "accent" : "warn"}>
          {mode}{sum?.isSample ? " · SAMPLE" : ""}
        </Badge>
        <span className="text-3xs uppercase text-ink-faint">
          health{" "}
          <span className={cn("font-bold", wsUp === undefined ? "text-ink-faint" : wsUp ? "text-pos" : "text-neg")}>
            {wsUp === undefined ? "—" : wsUp ? "OK" : "DEGRADED"}
          </span>
        </span>
        <span className="text-3xs uppercase text-ink-faint">
          cycle <Num className="font-bold text-ink">#{sum?.scan.cycle ?? "—"}</Num>
        </span>
        <span className="text-3xs uppercase text-ink-faint">
          markets <Num className="font-bold text-ink">{sum?.scan.markets ?? "—"}</Num>
        </span>
        <span className="text-3xs uppercase text-ink-faint">
          signals <Num className="font-bold text-ink">{sum?.signals.active ?? "—"}</Num>
          {sum?.signals.experimental ? (
            <span className="pl-1 text-warn">({sum.signals.experimental} exp)</span>
          ) : null}
        </span>
      </div>
      <div className="ml-auto flex items-center gap-3">
        {/* labeled by what it measures: REST health probes, not a websocket */}
        <span className="text-3xs uppercase text-ink-faint">
          api{" "}
          <span className={cn("font-bold", wsUp === undefined ? "text-ink-faint" : wsUp ? "text-pos" : "text-neg")}>
            {wsUp === undefined ? "—" : wsUp ? "up" : "down"}
          </span>
        </span>
        <span className="text-3xs uppercase text-ink-faint">
          hot p50/p95{" "}
          <Num className={cn("font-bold", (p95 ?? 0) > 20 ? "text-warn" : "text-ink")}>
            {p50 !== undefined ? `${p50.toFixed(1)}/${p95?.toFixed(1)}ms` : "—"}
          </Num>
        </span>
        <span className="text-3xs uppercase text-ink-faint">
          fresh{" "}
          <Num className={cn("font-bold", (freshS ?? 0) > 60 ? "text-warn" : "text-ink")}>
            {freshS !== undefined ? `${freshS}s` : "—"}
          </Num>
        </span>
        {sum?.killSwitch ? <Badge variant="neg">KILL ENGAGED</Badge> : null}
        <UtcClock />
      </div>
    </div>
  );
}
