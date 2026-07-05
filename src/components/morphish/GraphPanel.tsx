"use client";

// MINDMAP — relationship graph over markets, wallets, signals, venues and
// cross-venue links. Layout is deterministic (category hubs on a band,
// satellites on orbits) and computed in a memo — no force simulation, no
// dropped frames. Blue = useful signal relationship, gray = neutral,
// red = rule conflict / fade risk; dotted = weak.

import { useMemo, useState } from "react";
import type { GraphEdge, GraphNode } from "@/server/morphish";
import { useMorphishGraph } from "@/hooks/api";
import { Num } from "@/components/ui/num";
import { cn } from "@/lib/utils";

const W = 980, H = 380;

interface Placed extends GraphNode {
  x: number;
  y: number;
}

function hashAngle(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 3600) / 3600 * Math.PI * 2;
}

function layout(nodes: GraphNode[], edges: GraphEdge[]): Map<string, Placed> {
  const placed = new Map<string, Placed>();
  const hubs = nodes.filter((n) => n.type === "category");
  const hubX = new Map<string, number>();
  hubs.forEach((h, i) => {
    const x = ((i + 1) / (hubs.length + 1)) * W;
    hubX.set(h.id, x);
    placed.set(h.id, { ...h, x, y: H / 2 });
  });
  // venues along the top, signals along the bottom
  const venues = nodes.filter((n) => n.type === "venue");
  venues.forEach((v, i) => placed.set(v.id, { ...v, x: ((i + 1) / (venues.length + 1)) * W, y: 24 }));
  const sigs = nodes.filter((n) => n.type === "signal");
  sigs.forEach((v, i) => placed.set(v.id, { ...v, x: ((i + 1) / (sigs.length + 1)) * W, y: H - 22 }));

  // markets orbit their category hub; everything else orbits its first
  // placed neighbor
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
    adj.set(e.target, [...(adj.get(e.target) ?? []), e.source]);
  }
  for (const n of nodes) {
    if (placed.has(n.id)) continue;
    const anchor = (adj.get(n.id) ?? []).map((id) => placed.get(id)).find(Boolean);
    const a = hashAngle(n.id);
    const r = n.type === "market" ? 70 + (a * 37) % 50 : 40 + (a * 23) % 30;
    const cx = anchor?.x ?? W / 2;
    const cy = anchor?.y ?? H / 2;
    placed.set(n.id, {
      ...n,
      x: Math.max(16, Math.min(W - 16, cx + Math.cos(a) * r)),
      y: Math.max(16, Math.min(H - 16, cy + Math.sin(a) * (r * 0.62))),
    });
  }
  return placed;
}

export function GraphPanel({
  onSelectMarket,
  onSelectWallet,
}: {
  onSelectMarket: (id: string) => void;
  onSelectWallet: (id: string) => void;
}) {
  const { data } = useMorphishGraph();
  const [hideWeak, setHideWeak] = useState(false);
  const [conflictsOnly, setConflictsOnly] = useState(false);
  const [hoverEdge, setHoverEdge] = useState<GraphEdge | null>(null);
  const [hoverNode, setHoverNode] = useState<Placed | null>(null);

  const placed = useMemo(
    () => (data ? layout(data.nodes, data.edges) : new Map<string, Placed>()),
    [data],
  );
  const edges = useMemo(
    () =>
      (data?.edges ?? []).filter(
        (e) =>
          (!hideWeak || !e.dotted) &&
          (!conflictsOnly || e.type === "rule_conflict") &&
          placed.has(e.source) &&
          placed.has(e.target),
      ),
    [data, hideWeak, conflictsOnly, placed],
  );
  const s = data?.stats;
  const histMax = Math.max(1, ...(data?.histogram ?? []).map((h) => h.count));

  return (
    <div className="border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-line/60 bg-paper px-2 py-1">
        <span className="text-3xs font-bold uppercase tracking-widest">
          mindmap · relationship graph simulation
        </span>
        <span className="text-3xs text-ink-faint">
          nodes <Num className="font-bold text-ink">{s?.nodes ?? 0}</Num> · edges{" "}
          <Num className="font-bold text-ink">{s?.edges ?? 0}</Num>
        </span>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1 text-3xs uppercase">
            <input type="checkbox" checked={hideWeak} onChange={(e) => setHideWeak(e.target.checked)} />
            hide weak links
          </label>
          <label className="flex items-center gap-1 text-3xs uppercase">
            <input type="checkbox" checked={conflictsOnly} onChange={(e) => setConflictsOnly(e.target.checked)} />
            rule conflicts only
          </label>
        </div>
      </div>
      <div className="flex flex-col gap-2 p-2 lg:flex-row">
        <div className="relative min-w-0 flex-1 overflow-x-auto">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 640 }}>
            {edges.map((e) => {
              const a = placed.get(e.source)!;
              const b = placed.get(e.target)!;
              return (
                <line
                  key={e.id}
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={e.tone === "blue" ? "#2563eb" : e.tone === "red" ? "#b91c1c" : "#999"}
                  strokeWidth={0.6 + e.strength * 1.4}
                  strokeDasharray={e.dotted ? "3 3" : undefined}
                  opacity={hoverEdge === e ? 0.95 : 0.4}
                  className="cursor-pointer"
                  onMouseEnter={() => setHoverEdge(e)}
                  onMouseLeave={() => setHoverEdge(null)}
                />
              );
            })}
            {[...placed.values()].map((n) => (
              <g
                key={n.id}
                className="cursor-pointer"
                onMouseEnter={() => setHoverNode(n)}
                onMouseLeave={() => setHoverNode(null)}
                onClick={() => {
                  if (n.type === "market" && n.meta?.conditionId) onSelectMarket(String(n.meta.conditionId));
                  if (n.type === "wallet" && n.meta?.walletId) onSelectWallet(String(n.meta.walletId));
                }}
              >
                <circle
                  cx={n.x} cy={n.y} r={n.size / 2}
                  fill={
                    n.type === "market" ? "#111"
                    : n.type === "category" ? "#000"
                    : n.type === "wallet" ? "#2563eb"
                    : n.type === "signal" ? "#555"
                    : n.type === "venue" ? "#fff"
                    : "#888"
                  }
                  stroke={n.type === "venue" ? "#111" : "none"}
                  strokeWidth={1}
                />
                {n.type === "category" || n.type === "venue" ? (
                  <text x={n.x} y={n.y - n.size / 2 - 3} textAnchor="middle" className="fill-current text-[9px] font-bold uppercase">
                    {n.label}
                  </text>
                ) : null}
              </g>
            ))}
          </svg>
          {(hoverNode || hoverEdge) ? (
            <div className="pointer-events-none absolute left-2 top-2 max-w-80 border border-line-strong bg-paper p-1.5 text-3xs shadow-sm">
              {hoverNode ? (
                <>
                  <div className="font-semibold">{hoverNode.label}</div>
                  <div className="text-ink-soft">
                    {hoverNode.type}
                    {hoverNode.score !== undefined ? ` · score ${hoverNode.score}` : ""}
                    {hoverNode.meta?.prob !== undefined ? ` · prob ${((hoverNode.meta.prob as number) * 100).toFixed(0)}%` : ""}
                    {hoverNode.meta?.label ? ` · ${String(hoverNode.meta.label).replace(/_/g, " ")}` : ""}
                  </div>
                  <div className="text-ink-faint">click to open drawer</div>
                </>
              ) : hoverEdge ? (
                <div className="text-ink-soft">
                  <span className="font-semibold uppercase">{hoverEdge.type.replace(/_/g, " ")}</span> — {hoverEdge.note}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="grid shrink-0 grid-cols-3 gap-x-4 gap-y-1 text-2xs lg:w-44 lg:grid-cols-1">
          <div><div className="label">rule conflicts</div><Num tone={s?.conflicts ? "warn" : undefined}>{s?.conflicts ?? 0}</Num></div>
          <div><div className="label">wallet consensus</div><Num>{s?.walletConsensus ?? 0}</Num></div>
          <div><div className="label">x-venue pairs</div><Num>{s?.crossVenuePairs ?? 0}</Num></div>
          <div><div className="label">avg rule match</div><Num>{((s?.avgMatchScore ?? 0) * 100).toFixed(0)}%</Num></div>
          <div className="col-span-3 lg:col-span-1">
            <div className="label">match-score distribution</div>
            <div className="flex h-12 items-end gap-px">
              {(data?.histogram ?? []).map((h) => (
                <div
                  key={h.bucket}
                  title={`${(h.bucket * 100).toFixed(0)}–${(h.bucket * 100 + 10).toFixed(0)}%: ${h.count}`}
                  className={cn("flex-1", h.bucket >= 0.7 ? "bg-accent" : "bg-ink/60")}
                  style={{ height: `${(h.count / histMax) * 100}%` }}
                />
              ))}
            </div>
          </div>
          <div className="col-span-3 text-3xs text-ink-faint lg:col-span-1">
            legend: ● market ● category hub <span className="text-accent">●</span> wallet
            ○ venue · blue = signal path · red = conflict/fade · dotted = weak
          </div>
        </div>
      </div>
    </div>
  );
}
