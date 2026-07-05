"use client";

// TAIL PROBABILITY RIDGE — stacked terminal-density ridgelines for crypto
// threshold markets (touch contracts excluded — spot can't price a period
// extreme). Selected market ridge in blue with its strike marker and shaded
// tail; the left column shows the honest metrics, including model vs market.

import { useMorphishRidge } from "@/hooks/api";
import { fmtCents } from "@/lib/format";
import { Num } from "@/components/ui/num";
import { cn } from "@/lib/utils";

const W = 700, ROW = 34, PADX = 40;

export function RidgePanel({
  selected,
  onSelect,
}: {
  selected?: string;
  onSelect: (id: string) => void;
}) {
  const { data } = useMorphishRidge(selected);
  const curves = data?.curves ?? [];
  const sel = curves.find((c) => c.selected) ?? curves[0];
  const H = Math.max(140, curves.length * ROW + 50);

  // shared x-domain across ridges so strikes are comparable
  const xLo = Math.min(-0.02, ...curves.map((c) => c.points[0]?.x ?? 0));
  const xHi = Math.max(0.02, ...curves.map((c) => c.points[c.points.length - 1]?.x ?? 0));
  const X = (x: number) => PADX + ((x - xLo) / (xHi - xLo)) * (W - PADX - 10);

  return (
    <div className="border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line/60 bg-paper px-2 py-1">
        <span className="text-3xs font-bold uppercase tracking-widest">
          tail probability ridge · strike landscape ({curves.length})
        </span>
        <span className="ml-auto text-3xs text-ink-faint">
          drift-free lognormal terminal densities — stated model, not fair value
        </span>
      </div>
      {curves.length === 0 ? (
        <p className="p-2 text-2xs text-ink-faint">
          no terminal crypto-threshold markets with fresh reference data in the
          current universe — ridges appear when parseable “above/below $X at
          close” markets exist within 120 days
        </p>
      ) : (
        <div className="flex flex-col gap-2 p-2 lg:flex-row">
          <div className="grid shrink-0 grid-cols-3 gap-x-4 gap-y-1 text-2xs lg:w-48 lg:grid-cols-1">
            {sel ? (
              <>
                <div className="col-span-3 lg:col-span-1">
                  <div className="label">selected</div>
                  <div className="truncate text-2xs font-semibold">{sel.question.slice(0, 60)}</div>
                </div>
                <div><div className="label">spot</div><Num>${sel.spot.toLocaleString()}</Num></div>
                <div><div className="label">strike</div><Num>${sel.threshold.toLocaleString()}</Num></div>
                <div><div className="label">required move</div><Num tone={sel.requiredMovePct}>{(sel.requiredMovePct * 100).toFixed(1)}%</Num></div>
                <div><div className="label">tail mass P({sel.direction === "above" ? ">" : "<"}strike)</div><Num tone="pos">{(sel.tailMass * 100).toFixed(1)}%</Num></div>
                <div><div className="label">shadow prob</div><Num tone="pos">{(sel.shadowProb * 100).toFixed(1)}%</Num></div>
                <div><div className="label">market prob</div><Num>{sel.marketProb !== undefined ? `${(sel.marketProb * 100).toFixed(1)}%` : "—"}</Num></div>
                <div>
                  <div className="label">model − market</div>
                  <Num tone={(sel.shadowProb - (sel.marketProb ?? sel.shadowProb))}>
                    {sel.marketProb !== undefined ? fmtCents(sel.shadowProb - sel.marketProb) : "—"}
                  </Num>
                </div>
                <div><div className="label">vol / day</div><Num>{(sel.volDaily * 100).toFixed(2)}%</Num></div>
                <div><div className="label">time left</div><Num>{sel.daysLeft.toFixed(1)}d</Num></div>
                <div><div className="label">spot freshness</div><Num tone={sel.spotFreshnessMs > 5_000 ? "warn" : undefined}>{(sel.spotFreshnessMs / 1000).toFixed(1)}s</Num></div>
              </>
            ) : null}
          </div>
          <div className="min-w-0 flex-1 overflow-x-auto">
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 520 }}>
              {curves.map((c, ci) => {
                const base = 26 + ci * ROW + ROW * 0.8;
                const yMax = Math.max(...c.points.map((p) => p.y), 1e-6);
                const amp = ROW * 1.5;
                const path = c.points
                  .map((p, i) => `${i === 0 ? "M" : "L"}${X(p.x).toFixed(1)},${(base - (p.y / yMax) * amp).toFixed(1)}`)
                  .join(" ");
                const tailPts = c.points.filter((p) => (c.direction === "above" ? p.x >= c.strikeX : p.x <= c.strikeX));
                const tail = tailPts.length > 1
                  ? tailPts.map((p, i) => `${i === 0 ? "M" : "L"}${X(p.x).toFixed(1)},${(base - (p.y / yMax) * amp).toFixed(1)}`).join(" ") +
                    ` L${X(tailPts[tailPts.length - 1].x).toFixed(1)},${base} L${X(tailPts[0].x).toFixed(1)},${base} Z`
                  : "";
                const active = c.selected || (!curves.some((x) => x.selected) && ci === 0);
                return (
                  <g key={c.conditionId} className="cursor-pointer" onClick={() => onSelect(c.conditionId)}>
                    <line x1={PADX} y1={base} x2={W - 10} y2={base} stroke="#ccc" strokeWidth={0.5} />
                    {tail ? <path d={tail} fill={active ? "#2563eb" : "#666"} opacity={active ? 0.25 : 0.12} /> : null}
                    <path d={path} fill="none" stroke={active ? "#2563eb" : "#555"} strokeWidth={active ? 1.6 : 0.9} opacity={active ? 1 : 0.7} />
                    <line x1={X(c.strikeX)} y1={base - ROW * 1.4} x2={X(c.strikeX)} y2={base + 2}
                      stroke="#111" strokeDasharray="3 2" strokeWidth={active ? 1.2 : 0.7} opacity={active ? 0.9 : 0.4} />
                    <text x={PADX - 36} y={base - 2} className={cn("fill-current text-[8px]", active ? "font-bold" : "")} opacity={0.75}>
                      {c.daysLeft.toFixed(0)}d
                    </text>
                    <text x={Math.min(W - 90, X(c.strikeX) + 3)} y={base - ROW * 1.2} className="fill-current text-[8px]" opacity={active ? 0.9 : 0.45}>
                      ${(c.threshold / 1000).toFixed(0)}k · {(c.tailMass * 100).toFixed(0)}%
                    </text>
                  </g>
                );
              })}
              <text x={PADX} y={H - 4} className="fill-current text-[9px] uppercase" opacity={0.5}>
                log price move → (0 = current spot; dashed = strike)
              </text>
            </svg>
          </div>
        </div>
      )}
      <p className="border-t border-line/60 px-2 py-1 text-3xs text-ink-faint">{data?.note}</p>
    </div>
  );
}
