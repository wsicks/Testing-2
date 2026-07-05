"use client";

// TOP GEM + TOP MOVEMENT — the strongest live opportunity that survives
// every hard gate. The big ×N.NN is a normalized opportunity INTENSITY (the
// card says so — it is not leverage and not a payout multiple), and the
// dollar figure is the measured edge at the crippled test size. When nothing
// survives the gates, the card says exactly that and lists the blockers.

import { useMorphishTopGem } from "@/hooks/api";
import { fmtCents } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Num } from "@/components/ui/num";
import { cn } from "@/lib/utils";

function Spark({ pts, createdAt }: { pts: { t: number; p: number }[]; createdAt?: number }) {
  if (pts.length < 3) return null;
  const w = 220, h = 56;
  const xs = pts.map((p) => p.t), ys = pts.map((p) => p.p);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const X = (t: number) => ((t - x0) / Math.max(1, x1 - x0)) * (w - 4) + 2;
  const Y = (p: number) => h - 4 - ((p - y0) / Math.max(1e-6, y1 - y0)) * (h - 8);
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${X(p.t).toFixed(1)},${Y(p.p).toFixed(1)}`).join(" ");
  const sigX = createdAt ? X(createdAt / 1000) : undefined;
  return (
    <svg width={w} height={h} className="shrink-0">
      <path d={d} fill="none" stroke="var(--accent, #2563eb)" strokeWidth={1.5} />
      {sigX !== undefined && sigX >= 0 && sigX <= w ? (
        <line x1={sigX} y1={2} x2={sigX} y2={h - 2} stroke="#111" strokeDasharray="3 2" strokeWidth={1} />
      ) : null}
    </svg>
  );
}

export function TopGemCard({ onSelect }: { onSelect: (conditionId: string) => void }) {
  const { data } = useMorphishTopGem();
  const gem = data?.gem;

  return (
    <div className="border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line/60 bg-paper px-2 py-1">
        <span className="text-3xs font-bold uppercase tracking-widest">top gem + top movement</span>
        {gem ? <Badge variant="pos">all gates passed</Badge> : <Badge variant="warn">no qualified gem</Badge>}
        {gem?.experimental ? <Badge variant="warn">experimental</Badge> : null}
      </div>
      {gem ? (
        <div className="p-2">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="num text-3xl font-black tracking-tight">
                ×{gem.intensity.toFixed(2)}
                <span className="pl-2 align-middle text-2xs font-semibold text-pos">
                  {gem.edgeUsdAtTestSize !== undefined ? `+$${gem.edgeUsdAtTestSize.toFixed(2)} at $${gem.testSizeUsd.toFixed(0)} test` : ""}
                </span>
              </div>
              <div className="text-3xs uppercase text-ink-faint">
                opportunity intensity — not leverage, not a payout multiple
              </div>
              <button
                onClick={() => onSelect(gem.conditionId)}
                className="block max-w-full truncate pt-1 text-left text-2xs font-semibold hover:underline"
              >
                {gem.question}
              </button>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-1 text-2xs">
                <span><span className="label">signal</span> {gem.strategyLabel}</span>
                <span><span className="label">venue</span> {gem.venueId}</span>
                <span><span className="label">dir</span> {gem.direction.replace("_", " ")}</span>
                <span><span className="label">entry</span> <Num>{fmtCents(gem.entryPrice)}</Num></span>
                {gem.shadowProb !== undefined ? (
                  <span><span className="label">shadow</span> <Num tone="pos">{(gem.shadowProb * 100).toFixed(0)}%</Num></span>
                ) : null}
              </div>
            </div>
            <Spark pts={data?.spark ?? []} createdAt={gem.createdAt} />
          </div>
          <div className="grid grid-cols-3 gap-x-3 gap-y-0.5 border-t border-line/60 pt-1 text-2xs sm:grid-cols-6">
            <div><div className="label">edge after cost</div><Num tone="pos">{fmtCents(gem.edgeAfterCost)}</Num></div>
            <div><div className="label">spread</div><Num>{fmtCents(gem.spread)}</Num></div>
            <div><div className="label">liquidity</div><Num>{((gem.liquidityScore ?? 0) * 100).toFixed(0)}%</Num></div>
            <div><div className="label">rule clarity</div><Num>{(gem.ruleClarity ?? 0).toFixed(2)}</Num></div>
            <div><div className="label">freshness</div><Num tone={gem.freshnessMs > 30_000 ? "warn" : undefined}>{(gem.freshnessMs / 1000).toFixed(0)}s</Num></div>
            <div><div className="label">to close</div><Num>{gem.minutesToClose !== undefined ? `${Math.round(gem.minutesToClose)}m` : "—"}</Num></div>
          </div>
        </div>
      ) : (
        <div className="p-2 text-2xs text-ink-soft">
          no opportunity currently survives every hard gate (tradable at
          displayed price, clarity ≥ 0.90, fresh data, spread &lt; remaining
          edge, depth ≥ 5× size, promoted-or-proposed). Blocked candidates:
        </div>
      )}
      <div className="border-t border-line/60 px-2 py-1">
        {(data?.candidates ?? []).slice(0, 5).map((c) => (
          <div key={c.signalId} className="flex items-center gap-2 py-0.5 text-3xs">
            <span className={cn("w-14 shrink-0 font-bold", c.blocked ? "text-neg" : "text-pos")}>
              {c.blocked ? "BLOCKED" : "OK"}
            </span>
            <span className="w-28 shrink-0 font-semibold">{c.strategy}</span>
            <button onClick={() => onSelect(c.conditionId)} className="min-w-0 flex-1 truncate text-left hover:underline">
              {c.question}
            </button>
            <span className="max-w-64 truncate text-ink-faint" title={c.blockReasons.join("; ")}>
              {c.blockReasons[0] ?? `gem ${c.gemScore.toFixed(1)}`}
            </span>
          </div>
        ))}
        <p className="pt-0.5 text-3xs text-ink-faint">{data?.note}</p>
      </div>
    </div>
  );
}
