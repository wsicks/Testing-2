"use client";

// MINDMAP — relationship graph over markets, wallets, signals, venues and
// cross-venue links. Layout is deterministic (category hubs on a band,
// venues top, signals bottom, satellites on hash-angle orbits) and computed
// in a memo — no force simulation, no dropped frames.
//
// Interactions: click a node to SELECT it — its relationship paths light up,
// everything else dims, and the side column explains every edge on the path.
// Click an edge to pin its explanation. Filters: venue, category, weak
// links, rule conflicts, wallet clusters, cross-venue only.
//
// Blue = useful signal relationship, gray = neutral, red = rule conflict /
// fade risk; dotted = weak candidate.

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
  hubs.forEach((h, i) => {
    placed.set(h.id, { ...h, x: ((i + 1) / (hubs.length + 1)) * W, y: H / 2 });
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

/** gentle quadratic curve so parallel relationships stay distinguishable */
function edgePath(a: Placed, b: Placed): string {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.max(1, Math.hypot(dx, dy));
  const bow = Math.min(18, len * 0.12);
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${(mx - (dy / len) * bow).toFixed(1)},${(my + (dx / len) * bow).toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
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
  const [walletsOnly, setWalletsOnly] = useState(false);
  const [xVenueOnly, setXVenueOnly] = useState(false);
  const [venueFilter, setVenueFilter] = useState("all");
  const [catFilter, setCatFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pinnedEdge, setPinnedEdge] = useState<GraphEdge | null>(null);
  const [hoverEdge, setHoverEdge] = useState<GraphEdge | null>(null);
  const [hoverNode, setHoverNode] = useState<Placed | null>(null);

  const placed = useMemo(
    () => (data ? layout(data.nodes, data.edges) : new Map<string, Placed>()),
    [data],
  );

  const categories = useMemo(
    () => [...new Set((data?.nodes ?? []).filter((n) => n.type === "category").map((n) => n.label))].sort(),
    [data],
  );

  const edges = useMemo(
    () =>
      (data?.edges ?? []).filter((e) => {
        if (!placed.has(e.source) || !placed.has(e.target)) return false;
        if (hideWeak && e.dotted) return false;
        if (conflictsOnly && e.type !== "rule_conflict") return false;
        if (walletsOnly && e.type !== "wallet_position") return false;
        if (xVenueOnly && e.type !== "cross_venue" && e.type !== "rule_conflict") return false;
        if (venueFilter !== "all") {
          const a = placed.get(e.source)!, b = placed.get(e.target)!;
          if (a.venueId !== venueFilter && b.venueId !== venueFilter) return false;
        }
        if (catFilter !== "all") {
          const catId = `cat:${catFilter}`;
          const a = placed.get(e.source)!, b = placed.get(e.target)!;
          // keep edges touching the category hub or nodes orbiting it
          const touches = (n: Placed) =>
            n.id === catId ||
            (data?.edges ?? []).some(
              (x) =>
                (x.source === catId && x.target === n.id) ||
                (x.target === catId && x.source === n.id),
            );
          if (!touches(a) && !touches(b)) return false;
        }
        return true;
      }),
    [data, hideWeak, conflictsOnly, walletsOnly, xVenueOnly, venueFilter, catFilter, placed],
  );

  // selection path: the selected node, its edges, and their endpoints
  const path = useMemo(() => {
    if (!selectedId) return null;
    const pathEdges = edges.filter((e) => e.source === selectedId || e.target === selectedId);
    const nodeIds = new Set<string>([selectedId]);
    for (const e of pathEdges) {
      nodeIds.add(e.source);
      nodeIds.add(e.target);
    }
    return { edges: pathEdges, nodeIds };
  }, [selectedId, edges]);

  const s = data?.stats;
  const histMax = Math.max(1, ...(data?.histogram ?? []).map((h) => h.count));
  const infoEdge = pinnedEdge ?? hoverEdge;
  const selectedNode = selectedId ? placed.get(selectedId) : undefined;

  const clickNode = (n: Placed) => {
    if (selectedId === n.id) {
      // second click on the selected node opens its drawer
      if (n.type === "market" && n.meta?.conditionId) onSelectMarket(String(n.meta.conditionId));
      if (n.type === "wallet" && n.meta?.walletId) onSelectWallet(String(n.meta.walletId));
      return;
    }
    setSelectedId(n.id);
    setPinnedEdge(null);
  };

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
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            value={venueFilter}
            onChange={(e) => setVenueFilter(e.target.value)}
            className="border border-line bg-paper px-1 py-0.5 text-3xs uppercase"
          >
            {["all", "polymarket", "kalshi", "coinbase"].map((v) => (
              <option key={v} value={v}>{v === "all" ? "all venues" : v}</option>
            ))}
          </select>
          <select
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
            className="border border-line bg-paper px-1 py-0.5 text-3xs uppercase"
          >
            <option value="all">all categories</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          {[
            { label: "hide weak", val: hideWeak, set: setHideWeak },
            { label: "conflicts", val: conflictsOnly, set: setConflictsOnly },
            { label: "wallet clusters", val: walletsOnly, set: setWalletsOnly },
            { label: "x-venue", val: xVenueOnly, set: setXVenueOnly },
          ].map((f) => (
            <label key={f.label} className="flex items-center gap-1 text-3xs uppercase">
              <input type="checkbox" checked={f.val} onChange={(e) => f.set(e.target.checked)} />
              {f.label}
            </label>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2 p-2 lg:flex-row">
        <div className="relative min-w-0 flex-1 overflow-x-auto">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full"
            style={{ minWidth: 640 }}
            onClick={(e) => {
              // click on empty canvas clears selection + pin
              if (e.target === e.currentTarget) {
                setSelectedId(null);
                setPinnedEdge(null);
              }
            }}
          >
            {edges.map((e) => {
              const a = placed.get(e.source)!;
              const b = placed.get(e.target)!;
              const onPath = path?.edges.includes(e) ?? false;
              const dimmed = (path !== null && !onPath) || (infoEdge !== null && infoEdge !== e && !onPath);
              return (
                <path
                  key={e.id}
                  d={edgePath(a, b)}
                  fill="none"
                  stroke={e.tone === "blue" ? "#2563eb" : e.tone === "red" ? "#b91c1c" : "#999"}
                  strokeWidth={(0.6 + e.strength * 1.4) * (onPath ? 1.6 : 1)}
                  strokeDasharray={e.dotted ? "3 3" : undefined}
                  opacity={onPath || infoEdge === e ? 0.95 : dimmed ? 0.08 : 0.35}
                  className="cursor-pointer"
                  onMouseEnter={() => setHoverEdge(e)}
                  onMouseLeave={() => setHoverEdge(null)}
                  onClick={() => setPinnedEdge(pinnedEdge === e ? null : e)}
                />
              );
            })}
            {[...placed.values()].map((n) => {
              const onPath = path?.nodeIds.has(n.id) ?? false;
              const dimmed = path !== null && !onPath;
              return (
                <g
                  key={n.id}
                  className="cursor-pointer"
                  opacity={dimmed ? 0.2 : 1}
                  onMouseEnter={() => setHoverNode(n)}
                  onMouseLeave={() => setHoverNode(null)}
                  onClick={() => clickNode(n)}
                >
                  <circle
                    cx={n.x} cy={n.y} r={(n.size / 2) * (n.id === selectedId ? 1.35 : 1)}
                    fill={
                      n.type === "market" ? "#111"
                      : n.type === "category" ? "#000"
                      : n.type === "wallet" ? "#2563eb"
                      : n.type === "signal" ? "#555"
                      : n.type === "venue" ? "#fff"
                      : "#888"
                    }
                    stroke={n.id === selectedId ? "#2563eb" : n.type === "venue" ? "#111" : "none"}
                    strokeWidth={n.id === selectedId ? 2 : 1}
                  />
                  {n.type === "category" || n.type === "venue" || n.id === selectedId ? (
                    <text x={n.x} y={n.y - n.size / 2 - 4} textAnchor="middle" className="fill-current text-[9px] font-bold uppercase">
                      {n.label.slice(0, 28)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
          {(hoverNode || infoEdge) ? (
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
                  <div className="text-ink-faint">
                    {hoverNode.id === selectedId ? "click again to open drawer" : "click to trace relationships"}
                  </div>
                </>
              ) : infoEdge ? (
                <div className="text-ink-soft">
                  <span className="font-semibold uppercase">{infoEdge.type.replace(/_/g, " ")}</span> — {infoEdge.note}
                  {pinnedEdge === infoEdge ? <span className="text-ink-faint"> (pinned — click edge to unpin)</span> : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="grid shrink-0 grid-cols-3 gap-x-4 gap-y-1 text-2xs lg:w-48 lg:grid-cols-1">
          {selectedNode && path ? (
            <div className="col-span-3 border-b border-line/60 pb-1 lg:col-span-1">
              <div className="label">selected path</div>
              <div className="truncate text-2xs font-semibold">{selectedNode.label}</div>
              <div className="text-3xs text-ink-faint">
                {path.edges.length} relationship(s) · {path.nodeIds.size - 1} connected node(s)
              </div>
              <div className="max-h-24 space-y-0.5 overflow-y-auto pt-0.5">
                {path.edges.slice(0, 6).map((e) => (
                  <div key={e.id} className="truncate text-3xs text-ink-soft" title={e.note}>
                    <span className={cn("font-bold", e.tone === "red" ? "text-neg" : e.tone === "blue" ? "text-accent" : "")}>
                      {e.type.replace(/_/g, " ")}
                    </span>{" "}
                    {e.note.slice(0, 60)}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="col-span-3 text-3xs text-ink-faint lg:col-span-1">
              click a node to trace its relationships; click again to open its drawer
            </div>
          )}
          <div><div className="label">rule conflicts</div><Num tone={s?.conflicts ? "warn" : undefined}>{s?.conflicts ?? 0}</Num></div>
          <div><div className="label">wallet consensus</div><Num>{s?.walletConsensus ?? 0}</Num></div>
          <div><div className="label">x-venue pairs</div><Num>{s?.crossVenuePairs ?? 0}</Num></div>
          <div><div className="label">avg rule match</div><Num>{((s?.avgMatchScore ?? 0) * 100).toFixed(0)}%</Num></div>
          <div><div className="label">shown edges</div><Num>{edges.length}</Num></div>
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
