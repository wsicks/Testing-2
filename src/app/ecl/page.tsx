"use client";

// ECL — Entropy Collapse Lag panel. Every candidate shows the full math:
// shadow vs market probability, entropy gap, source lag, friction stack,
// edge after cost, and the mechanical exit plan. Failed gates stay visible —
// a rejected candidate teaches as much as a passed one.

import Link from "next/link";
import { useRunScan, useSignals } from "@/hooks/api";
import { fmtAgo, fmtCents } from "@/lib/format";
import type { SignalResult } from "@/lib/types";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Num } from "@/components/ui/num";
import { EmptyNote, Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

function n(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function EclCard({ s }: { s: SignalResult }) {
  const m = s.meta ?? {};
  const exit = m.exitPlan as
    | { entry: number; partialExitAt: number; fullExitAt: number; rule: string }
    | undefined;
  const failed = s.checks.filter((c) => !c.passed);
  return (
    <div className={cn("border border-line bg-panel", s.status === "rejected" && "opacity-90")}>
      <div className="flex items-center gap-2 border-b border-line bg-paper px-2 py-1">
        <Badge variant={s.status === "proposed" ? "pos" : "neg"}>
          {s.status === "proposed" ? "all gates passed" : `${failed.length} gate(s) failed`}
        </Badge>
        <Badge variant={s.direction === "BUY_YES" ? "pos" : "neg"}>{s.direction.replace("_", " ")}</Badge>
        <Link href={`/market/${s.conditionId}`} className="min-w-0 flex-1 truncate text-2xs font-semibold hover:underline">
          {s.marketQuestion}
        </Link>
        <Num className="text-sm font-bold">{s.score}</Num>
        <span className="label">ecl</span>
        <span className="text-3xs text-ink-faint">{fmtAgo(s.createdAt)}</span>
      </div>
      {/* a missing meta value renders "—", never a measured-looking zero */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 p-2 text-2xs sm:grid-cols-4 lg:grid-cols-7">
        <Field k="P market" v={n(m.pMarket) !== undefined ? `${(n(m.pMarket)! * 100).toFixed(1)}%` : "—"} />
        <Field k="P shadow" v={n(m.pShadow) !== undefined ? `${(n(m.pShadow)! * 100).toFixed(1)}%` : "—"} pos />
        <Field k="entropy gap" v={n(m.entropyGap) !== undefined ? `${n(m.entropyGap)!.toFixed(3)} nats` : "—"} />
        <Field k="source lag" v={n(m.sourceLag)?.toFixed(2) ?? "—"} />
        <Field k="rule clarity" v={n(m.ruleClarity)?.toFixed(2) ?? "—"} />
        <Field k="spread" v={fmtCents(n(m.spread))} />
        <Field k="friction" v={fmtCents(n(m.friction))} />
        <Field k="edge after cost" v={fmtCents(n(m.edgeAfterCost))} pos />
        <Field k="source" v={String(m.shadowSource ?? "—")} />
        <Field k="source age" v={n(m.sourceAgeMs) !== undefined ? `${(n(m.sourceAgeMs)! / 1000).toFixed(1)}s` : "—"} />
        <Field k="liquidity score" v={n(m.liquidityScore)?.toFixed(2) ?? "—"} />
        <Field k="max test size" v={n(m.suggestedTestUsd) !== undefined ? `$${n(m.suggestedTestUsd)!.toFixed(2)}` : "—"} warn />
        {exit ? (
          <>
            <Field k="exit 50% at" v={fmtCents(exit.partialExitAt)} />
            <Field k="exit rest at" v={fmtCents(exit.fullExitAt)} />
          </>
        ) : null}
      </div>
      <div className="border-t border-line/60 px-2 py-1">
        {s.checks.map((c, i) => (
          <div key={i} className="flex items-start gap-2 text-2xs">
            <span className={cn("num w-10 shrink-0 font-bold", c.passed ? "text-pos" : "text-neg")}>
              {c.passed ? "PASS" : "FAIL"}
            </span>
            <span className="w-36 shrink-0 font-semibold">{c.name}</span>
            <span className="text-ink-soft">{c.detail}</span>
          </div>
        ))}
        {exit ? <p className="pt-0.5 text-3xs text-ink-faint">exit rule: {exit.rule}</p> : null}
      </div>
    </div>
  );
}

function Field({ k, v, pos, warn }: { k: string; v: string; pos?: boolean; warn?: boolean }) {
  return (
    <div>
      <div className="label">{k}</div>
      <Num tone={pos ? "pos" : warn ? "warn" : undefined}>{v}</Num>
    </div>
  );
}

export default function EclPage() {
  const { data, isLoading } = useSignals({ strategy: "ecl", limit: 40 });
  const runScan = useRunScan();
  const signals = data?.signals ?? [];

  return (
    <div className="space-y-2">
      <Panel
        title={`entropy collapse lag (${signals.length} candidates)`}
        right={
          <>
            {isLoading || runScan.isPending ? <Spinner /> : null}
            <Button size="xs" variant="primary" onClick={() => runScan.mutate()} disabled={runScan.isPending}>
              scan now
            </Button>
          </>
        }
      >
        <p className="text-2xs text-ink-soft">
          ECL hunts <span className="font-semibold">repricing debt</span>: the
          source of truth has already collapsed the event&apos;s uncertainty,
          but the order book hasn&apos;t repriced. It does not predict events —
          it detects when H(market) stays high after H(shadow) collapsed, and
          only surfaces trades whose edge survives spread, slippage, fees,
          latency and ambiguity penalties. Shadow sources: Coinbase
          spot+realized-vol for crypto thresholds; rule-comparable cross-venue
          partners that already repriced. Official-release feeds (CPI/Fed/
          weather) are a roadmap item — not faked. Test sizing is deliberately
          crippled (min of 10% Kelly, 0.25% of account, depth/5, $25) until
          100 qualified signals are logged; the win-rate math that motivates
          this lives in your portfolio stats, not in this panel.
        </p>
      </Panel>
      {signals.length === 0 && !isLoading ? (
        <Panel title="candidates">
          <EmptyNote>
            no ECL candidates in the current universe — this signal is rare by
            design; it appears when a threshold market drifts out of sync with
            fresh reference data, typically near closes and during fast moves
          </EmptyNote>
        </Panel>
      ) : (
        signals.map((s) => <EclCard key={s.id} s={s} />)
      )}
    </div>
  );
}
