"use client";

// PROBABILITY LATTICE — the whole monitored universe on one board.
// SVG scatter with switchable axes, live filters, a histogram footer and a
// left stats block. Blue = proposed signal with positive edge, ink/gray =
// neutral, red = risk-blocked, hollow = reference-only (never counted as
// tradable). All interaction is local state — a data refresh re-renders
// only this panel.

import { useMemo, useState } from "react";
import type { LatticePoint } from "@/server/morphish";
import { useMorphishLattice, useMorphishWatchlist } from "@/hooks/api";
import { fmtCents, fmtUsd } from "@/lib/format";
import { Num } from "@/components/ui/num";
import { cn } from "@/lib/utils";

type AxisMode = "prob_edge" | "prob_time" | "prob_liq" | "shadow_market";

const AXES: { key: AxisMode; label: string }[] = [
  { key: "prob_edge", label: "prob × edge" },
  { key: "prob_time", label: "prob × close" },
  { key: "prob_liq", label: "prob × liq" },
  { key: "shadow_market", label: "shadow × market" },
];

const W = 720, H = 300, PAD = 28;

function coords(p: LatticePoint, mode: AxisMode): { x: number; y: number } | null {
  const prob = p.prob;
  if (prob === undefined) return null;
  switch (mode) {
    case "prob_edge":
      return { x: prob, y: Math.max(-0.05, Math.min(0.25, p.edgeAfterCost ?? 0)) };
    case "prob_time": {
      if (p.hoursToClose === undefined || p.hoursToClose <= 0) return null;
      return { x: Math.min(1, Math.log10(1 + p.hoursToClose) / 3.2), y: prob };
    }
    case "prob_liq":
      return { x: prob, y: Math.min(1, Math.log10(1 + p.liquidity) / 6) };
    case "shadow_market": {
      if (p.shadowProb === undefined) return null;
      return { x: prob, y: p.shadowProb };
    }
  }
}

export function LatticePanel({
  selected,
  onSelect,
}: {
  selected?: string;
  onSelect: (id: string) => void;
}) {
  const { data } = useMorphishLattice();
  const watch = useMorphishWatchlist();
  const [axis, setAxis] = useState<AxisMode>("prob_edge");
  const [minEdge, setMinEdge] = useState(0);
  const [maxSpread, setMaxSpread] = useState(0.1);
  const [venue, setVenue] = useState<string>("all");
  const [hideRef, setHideRef] = useState(true);
  const [freshOnly, setFreshOnly] = useState(false);
  const [hover, setHover] = useState<LatticePoint | null>(null);

  const filtered = useMemo(() => {
    const pts = data?.points ?? [];
    return pts.filter(
      (p) =>
        (venue === "all" || p.venueId === venue) &&
        (!hideRef || !p.referenceOnly) &&
        (!freshOnly || !p.stale) &&
        (p.spread === undefined || p.spread <= maxSpread) &&
        (minEdge <= 0 || (p.edgeAfterCost ?? 0) >= minEdge),
    );
  }, [data, venue, hideRef, freshOnly, maxSpread, minEdge]);

  const plotted = useMemo(
    () =>
      filtered
        .map((p) => ({ p, c: coords(p, axis) }))
        .filter((x): x is { p: LatticePoint; c: { x: number; y: number } } => x.c !== null)
        .slice(0, 3_000),
    [filtered, axis],
  );

  const yLo = axis === "prob_edge" ? -0.05 : 0;
  const yHi = axis === "prob_edge" ? 0.25 : 1;
  const X = (x: number) => PAD + x * (W - PAD * 2);
  const Y = (y: number) => H - PAD - ((y - yLo) / (yHi - yLo)) * (H - PAD * 2);

  // probability histogram footer (20 bins over x-prob)
  const hist = useMemo(() => {
    const bins = new Array(20).fill(0);
    for (const { p } of plotted) if (p.prob !== undefined) bins[Math.min(19, Math.floor(p.prob * 20))] += 1;
    return bins;
  }, [plotted]);
  const histMax = Math.max(1, ...hist);
  const s = data?.stats;

  return (
    <div className="border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-line/60 bg-paper px-2 py-1">
        <span className="text-3xs font-bold uppercase tracking-widest">
          probability lattice · {s?.liveContracts ?? 0} contracts, one board
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {AXES.map((a) => (
            <button
              key={a.key}
              onClick={() => setAxis(a.key)}
              className={cn(
                "border px-1.5 py-0.5 text-3xs font-bold uppercase",
                axis === a.key ? "border-accent bg-accent text-white" : "border-line text-ink-faint hover:text-ink",
              )}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2 p-2 lg:flex-row">
        <div className="grid shrink-0 grid-cols-3 gap-x-4 gap-y-1 text-2xs lg:w-44 lg:grid-cols-1">
          <div><div className="label">tradable</div><Num>{s?.tradable ?? 0}</Num></div>
          <div><div className="label">blue signals</div><Num tone="pos">{s?.signalsBlue ?? 0}</Num></div>
          <div><div className="label">risk-blocked</div><Num tone={s?.blocked ? "warn" : undefined}>{s?.blocked ?? 0}</Num></div>
          <div><div className="label">reference-only</div><Num>{s?.referenceOnly ?? 0}</Num></div>
          <div><div className="label">stale</div><Num tone={s?.stale ? "warn" : undefined}>{s?.stale ?? 0}</Num></div>
          <div><div className="label">ecl active</div><Num>{s?.eclActive ?? 0}</Num></div>
          <div><div className="label">wallet radar</div><Num>{s?.walletActive ?? 0}</Num></div>
          <div><div className="label">x-venue candidates</div><Num>{s?.crossVenueCandidates ?? 0}</Num></div>
          <div><div className="label">avg spread</div><Num>{fmtCents(s?.avgSpread)}</Num></div>
          <div><div className="label">median liq</div><Num>{fmtUsd(s?.medianLiquidity, 0)}</Num></div>
          <div><div className="label">24h volume</div><Num>{fmtUsd(s?.totalVolume24h, 0)}</Num></div>
        </div>

        <div className="relative min-w-0 flex-1 overflow-x-auto">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 540 }}>
            <rect x={0} y={0} width={W} height={H} fill="transparent" />
            {/* 50% probability guide — only meaningful when x IS probability;
                in prob_time mode x is log time-to-close and a line at x=0.5
                would mark nothing */}
            {axis !== "prob_time" ? (
              <line x1={X(0.5)} y1={PAD / 2} x2={X(0.5)} y2={H - PAD} stroke="#111" strokeDasharray="4 3" strokeWidth={1} opacity={0.5} />
            ) : null}
            {axis === "prob_edge" ? (
              <line x1={PAD} y1={Y(0)} x2={W - PAD} y2={Y(0)} stroke="#999" strokeWidth={0.7} />
            ) : null}
            {axis === "shadow_market" ? (
              <line x1={X(0)} y1={Y(0)} x2={X(1)} y2={Y(1)} stroke="#999" strokeDasharray="2 3" strokeWidth={0.7} />
            ) : null}
            {plotted.map(({ p, c }) => {
              const blue = p.proposed && (p.edgeAfterCost ?? 0) > 0;
              const red = p.blocked;
              const isSel = p.id === selected;
              return (
                <circle
                  key={p.id}
                  cx={X(c.x)}
                  cy={Y(c.y)}
                  r={isSel ? 5 : blue || red ? 3 : 2}
                  fill={p.referenceOnly ? "none" : blue ? "#2563eb" : red ? "#b91c1c" : "#333"}
                  stroke={p.referenceOnly ? "#777" : isSel ? "#111" : "none"}
                  strokeWidth={isSel ? 1.5 : 1}
                  opacity={blue || red || isSel ? 0.95 : 0.35}
                  className="cursor-pointer"
                  onMouseEnter={() => setHover(p)}
                  onMouseLeave={() => setHover(null)}
                  onClick={(e) => {
                    if (e.shiftKey) watch.mutate({ conditionId: p.id, add: true });
                    else onSelect(p.id);
                  }}
                />
              );
            })}
            {/* histogram footer */}
            {hist.map((n, i) => (
              <rect
                key={i}
                x={X(i / 20) + 1}
                y={H - PAD + 2}
                width={(W - PAD * 2) / 20 - 2}
                height={(n / histMax) * (PAD - 6)}
                fill={i >= 10 ? "#2563eb" : "#333"}
                opacity={0.6}
              />
            ))}
            <text x={PAD} y={10} className="fill-current text-[9px] uppercase" opacity={0.5}>
              {axis === "prob_time" ? "log time-to-close →" : "implied probability →"}
            </text>
          </svg>
          {hover ? (
            <div className="pointer-events-none absolute left-2 top-2 max-w-72 border border-line-strong bg-paper p-1.5 text-3xs shadow-sm">
              <div className="font-semibold">{hover.question.slice(0, 80)}</div>
              <div className="text-ink-soft">
                {hover.venueId} · {hover.category} · prob {((hover.prob ?? 0) * 100).toFixed(1)}% ·
                spread {fmtCents(hover.spread)} · liq {fmtUsd(hover.liquidity, 0)}
                {hover.signalScore !== undefined ? ` · ${hover.signalStrategy} ${hover.signalScore}/100` : ""}
                {hover.edgeAfterCost !== undefined ? ` · edge ${fmtCents(hover.edgeAfterCost)}` : ""}
                {hover.hoursToClose !== undefined ? ` · closes ${hover.hoursToClose.toFixed(0)}h` : ""}
                {hover.referenceOnly ? " · REFERENCE-ONLY" : ""}
                {hover.stale ? " · STALE" : ""}
              </div>
              <div className="text-ink-faint">click = select · shift-click = watchlist</div>
            </div>
          ) : null}
        </div>

        <div className="grid shrink-0 grid-cols-2 gap-x-3 gap-y-1 text-2xs lg:w-40 lg:grid-cols-1">
          <label className="block">
            <span className="label">min edge {fmtCents(minEdge)}</span>
            <input type="range" min={0} max={0.1} step={0.005} value={minEdge}
              onChange={(e) => setMinEdge(Number(e.target.value))} className="w-full" />
          </label>
          <label className="block">
            <span className="label">max spread {fmtCents(maxSpread)}</span>
            <input type="range" min={0.005} max={0.1} step={0.005} value={maxSpread}
              onChange={(e) => setMaxSpread(Number(e.target.value))} className="w-full" />
          </label>
          <label className="block">
            <span className="label">venue</span>
            <select value={venue} onChange={(e) => setVenue(e.target.value)}
              className="w-full border border-line bg-paper px-1 py-0.5 text-2xs">
              {["all", "polymarket", "kalshi"].map((v) => <option key={v}>{v}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1 text-3xs uppercase">
            <input type="checkbox" checked={hideRef} onChange={(e) => setHideRef(e.target.checked)} />
            hide reference-only
          </label>
          <label className="flex items-center gap-1 text-3xs uppercase">
            <input type="checkbox" checked={freshOnly} onChange={(e) => setFreshOnly(e.target.checked)} />
            fresh data only
          </label>
          <div className="text-3xs text-ink-faint">{plotted.length} plotted</div>
        </div>
      </div>
    </div>
  );
}
