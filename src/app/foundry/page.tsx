"use client";

// ALPHA FOUNDRY — the research machine's dashboard: feature lifecycle with
// measured evidence and decay curves, prosecutor verdicts, the graveyard
// (failed ideas + lessons), research-agent ideas, and Disclosure Radar
// context. Promotion is a human act performed here, and only after the
// prosecutor passes.

import { useState } from "react";
import {
  useDisclosures,
  useFoundry,
  useFoundryAction,
} from "@/hooks/api";
import type { AlphaFeature, FeatureEvidence } from "@/lib/alpha/types";
import { fmtAgo } from "@/lib/format";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Num } from "@/components/ui/num";
import { EmptyNote, Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type FeatureRow = AlphaFeature & { evidence: FeatureEvidence };
type PaperPnl = Record<string, { realizedUsd: number; wins: number; losses: number }>;

const STATUS_TONE: Record<string, "pos" | "neg" | "warn" | "default"> = {
  promoted: "pos",
  shadow_live: "pos",
  paper_testing: "warn",
  backtesting: "warn",
  data_connected: "warn",
  idea: "default",
  degraded: "neg",
  rejected: "neg",
  retired: "neg",
};

function Drift({ v }: { v: number | undefined }) {
  if (v === undefined) return <Num tone="muted">—</Num>;
  return <Num tone={v > 0 ? "pos" : v < 0 ? "neg" : "muted"}>{(v * 100).toFixed(2)}c</Num>;
}

function FeatureCard({ f, pnl }: { f: FeatureRow; pnl?: PaperPnl[string] }) {
  const [open, setOpen] = useState(false);
  const act = useFoundryAction();
  const oneH = f.evidence.curve.find((c) => c.bucket === "b1h");
  const verdict = f.lastVerdict;
  return (
    <div className="border border-line bg-panel">
      <button
        className="flex w-full items-center gap-2 border-b border-line/60 bg-paper px-2 py-1 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <Badge variant={STATUS_TONE[f.status] ?? "default"}>{f.status.replace(/_/g, " ")}</Badge>
        <span className="min-w-0 flex-1 truncate text-2xs font-semibold">{f.name}</span>
        {f.humanApprovedAt ? <span className="text-3xs text-ink-faint">approved</span> : null}
        <span className="label">alpha</span>
        <Num className="text-sm font-bold">{f.alphaScore !== undefined ? f.alphaScore.toFixed(0) : "—"}</Num>
        <span className="label">1h drift</span>
        <Drift v={oneH && oneH.n > 0 ? oneH.avgDrift : undefined} />
        <span className="label">n</span>
        <Num>{f.evidence.outcomes}</Num>
        {pnl && (pnl.wins + pnl.losses > 0) ? (
          <>
            <span className="label" title="realized paper PnL from AUTOPILOT-managed trades only">ap pnl</span>
            <Num tone={pnl.realizedUsd}>${pnl.realizedUsd.toFixed(2)}</Num>
            <span className="text-3xs text-ink-faint">{pnl.wins}W/{pnl.losses}L</span>
          </>
        ) : null}
      </button>
      {open ? (
        <div className="space-y-1 p-2 text-2xs">
          <p className="text-ink-soft">{f.thesis}</p>
          {f.whyMissed ? <p className="text-ink-faint">why others miss it: {f.whyMissed}</p> : null}
          <div className="flex flex-wrap gap-x-4 gap-y-0.5">
            <span><span className="label">sources</span> {f.dataSources.join(", ") || "internal"}</span>
            <span><span className="label">scope</span> {f.categoryScope.join(", ")}</span>
            <span><span className="label">kill criteria</span> {f.killCriteria}</span>
          </div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-0.5 sm:grid-cols-6">
            <div><div className="label">outcomes</div><Num>{f.evidence.outcomes}</Num></div>
            <div><div className="label">tradable</div><Num>{f.evidence.tradableOutcomes}</Num></div>
            <div><div className="label">markets</div><Num>{f.evidence.distinctMarkets}</Num></div>
            <div><div className="label">days</div><Num>{f.evidence.distinctDays}</Num></div>
            <div><div className="label">lucky conc.</div><Num tone={f.evidence.luckyConcentration > 0.25 ? "warn" : undefined}>{(f.evidence.luckyConcentration * 100).toFixed(0)}%</Num></div>
            <div><div className="label">adverse run</div><Num>{f.evidence.maxAdverseRun}</Num></div>
          </div>
          <div className="flex items-end gap-3 border-t border-line/60 pt-1">
            <span className="label">edge decay</span>
            {f.evidence.curve.map((c) => (
              <div key={c.bucket} className="text-center">
                <div className="label">{c.bucket.slice(1)}</div>
                <Drift v={c.n > 0 ? c.avgDrift : undefined} />
                <div className="text-3xs text-ink-faint">n={c.n}{c.missed ? ` m${c.missed}` : ""}</div>
              </div>
            ))}
          </div>
          {verdict ? (
            <div className="border-t border-line/60 pt-1">
              <div className="flex items-center gap-2">
                <span className="label">prosecutor</span>
                <Badge variant={verdict.passed ? "pos" : "neg"}>
                  {verdict.passed ? "SURVIVED" : "BLOCKED"}
                </Badge>
                <span className="text-3xs text-ink-faint">{fmtAgo(verdict.ranAt)}</span>
              </div>
              {verdict.tests.map((t) => (
                <div key={t.name} className="flex items-start gap-2">
                  <span className={cn("num w-10 shrink-0 font-bold", t.passed ? "text-pos" : "text-neg")}>
                    {t.passed ? "PASS" : "FAIL"}
                  </span>
                  <span className="w-52 shrink-0 font-semibold">{t.name}</span>
                  <span className="text-ink-soft">{t.evidence}</span>
                </div>
              ))}
            </div>
          ) : null}
          {f.lastBacktest ? (
            <div className="border-t border-line/60 pt-1">
              <div className="flex items-center gap-2">
                <span className="label">walk-forward backtest</span>
                <Badge variant={f.lastBacktest.avgNet > 0 ? "pos" : "neg"}>
                  {(f.lastBacktest.avgNet * 100).toFixed(2)}c net / entry
                </Badge>
                <span className="text-3xs text-ink-faint">
                  {f.lastBacktest.outcomes} entries · {f.lastBacktest.markets} markets ·{" "}
                  {f.lastBacktest.positiveFolds}/{f.lastBacktest.folds.length} folds positive ·
                  best market {(f.lastBacktest.singleMarketShare * 100).toFixed(0)}% of gross ·{" "}
                  {fmtAgo(f.lastBacktest.ranAt)}
                </span>
              </div>
              <div className="flex gap-3 pt-0.5">
                {f.lastBacktest.folds.map((fold) => (
                  <span key={fold.fold} className="text-3xs">
                    <span className="label">fold {fold.fold + 1}</span>{" "}
                    <Num tone={fold.avgNet}>{(fold.avgNet * 100).toFixed(2)}c</Num>
                    <span className="text-ink-faint"> n={fold.n}</span>
                  </span>
                ))}
              </div>
              <p className="text-3xs text-ink-faint">
                historical simulation — {f.lastBacktest.assumptions[0]}
              </p>
            </div>
          ) : null}
          {f.failureReason ? (
            <p className="text-neg">failure: {f.failureReason}{f.lessons ? ` — lessons: ${f.lessons}` : ""}</p>
          ) : null}
          <div className="flex gap-1 border-t border-line/60 pt-1">
            <Button size="xs" onClick={() => act.mutate({ action: "backtest", featureId: f.id })} disabled={act.isPending}>
              run backtest
            </Button>
            <Button size="xs" onClick={() => act.mutate({ action: "prosecute", featureId: f.id })} disabled={act.isPending}>
              run prosecutor
            </Button>
            {f.status !== "promoted" && verdict?.passed ? (
              <Button
                size="xs"
                variant="primary"
                onClick={() => {
                  const by = window.prompt(
                    "HUMAN PROMOTION APPROVAL — the prosecutor passed, but promotion also requires your name for the audit trail. Promoted features become eligible for live routing (still behind live gates + per-order confirmation).",
                  );
                  if (by) act.mutate({ action: "approve", featureId: f.id, approvedBy: by });
                }}
              >
                approve promotion
              </Button>
            ) : null}
          </div>
          {act.isError ? (
            <p className="text-3xs text-neg">{(act.error as Error)?.message ?? "action failed"}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function FoundryPage() {
  const { data, isLoading } = useFoundry();
  const { data: disc } = useDisclosures();
  const act = useFoundryAction();
  const features = data?.features ?? [];
  const byStatus = (s: string) => features.filter((f) => f.status === s).length;
  const best = [...features]
    .filter((f) => f.alphaScore !== undefined)
    .sort((a, b) => (b.alphaScore ?? 0) - (a.alphaScore ?? 0))[0];

  return (
    <div className="space-y-2">
      <Panel
        title="alpha foundry — continuous research lifecycle"
        right={
          <>
            {isLoading || act.isPending ? <Spinner /> : null}
            <Button size="xs" onClick={() => act.mutate({ action: "research" })} disabled={act.isPending}>
              generate ideas
            </Button>
            <Button size="xs" variant="primary" onClick={() => act.mutate({ action: "tick" })} disabled={act.isPending}>
              run foundry tick
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-2xs sm:grid-cols-9">
          <div><div className="label">ideas</div><Num>{byStatus("idea")}</Num></div>
          <div><div className="label">data-connected</div><Num>{byStatus("data_connected")}</Num></div>
          <div><div className="label">paper testing</div><Num>{byStatus("paper_testing")}</Num></div>
          <div><div className="label">shadow live</div><Num>{byStatus("shadow_live")}</Num></div>
          <div><div className="label">promoted</div><Num tone="pos">{byStatus("promoted")}</Num></div>
          <div><div className="label">degraded</div><Num tone={byStatus("degraded") ? "neg" : "muted"}>{byStatus("degraded")}</Num></div>
          <div><div className="label">graveyard</div><Num>{data?.graveyard.length ?? 0}</Num></div>
          <div><div className="label">wallet intel</div><Num>{data?.walletIntel.markets ?? 0} mkts</Num></div>
          <div><div className="label">best alpha</div><Num tone="pos">{best ? `${best.name.slice(0, 14)} ${best.alphaScore?.toFixed(0)}` : "—"}</Num></div>
        </div>
        <p className="pt-1 text-3xs text-ink-faint">
          Lifecycle: idea → data-connected → backtesting → paper testing →
          shadow live → promoted (prosecutor pass + HUMAN approval) → degraded
          → retired. No feature trades live without promotion; nothing here
          promises profit — every number is a measurement with its sample size.
        </p>
      </Panel>

      {data?.attention.length ? (
        <Panel title="news attention (gdelt, topic-level, reference-only)">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-2xs">
            {data.attention.map((t) => (
              <div key={t.label}>
                <div className="label">{t.label} ({t.category})</div>
                <Num tone={t.zScore >= 2 ? "warn" : undefined}>
                  z {t.zScore.toFixed(1)}
                </Num>
                <span className="pl-1 text-3xs text-ink-faint">
                  vol {t.recent.toFixed(2)} vs {t.baseline.toFixed(2)} · {fmtAgo(t.fetchedAt)}
                </span>
              </div>
            ))}
          </div>
          <p className="pt-1 text-3xs text-ink-faint">
            aggregate news volume per topic (15-min buckets, 3-day baseline).
            Spikes (z ≥ 2) enter the disclosure feed as context — topic-level
            data is never presented as market-level signal.
          </p>
        </Panel>
      ) : null}

      <Panel title={`features (${features.length})`}>
        <div className="space-y-1">
          {features.map((f) => <FeatureCard key={f.id} f={f} pnl={data?.paperPnl?.[f.id]} />)}
        </div>
      </Panel>

      <Panel title={`signal graveyard (${data?.graveyard.length ?? 0})`}>
        {!data?.graveyard.length ? (
          <EmptyNote>
            empty — features that fail (no edge, overfit, slippage, decay, …)
            are buried here with their failure class and lessons so bad ideas
            are never rebuilt from scratch
          </EmptyNote>
        ) : (
          <div className="space-y-1">
            {data.graveyard.map((f) => <FeatureCard key={f.id} f={f} pnl={data?.paperPnl?.[f.id]} />)}
          </div>
        )}
      </Panel>

      <Panel title={`research agent — ideas (${data?.ideas.length ?? 0})`}>
        <p className="pb-1 text-3xs text-ink-faint">
          deterministic ideation over the source registry (source × category
          lag studies with theses + kill criteria). The full research-agent
          prompt for richer LLM-assisted ideation is documented below — its
          output enters the same lifecycle, never a fast lane.
        </p>
        {!data?.ideas.length ? (
          <EmptyNote>no ideas yet — run the foundry tick or generate ideas</EmptyNote>
        ) : (
          data.ideas.slice(0, 10).map((i) => (
            <div key={i.id} className="border-b border-line/60 py-1 text-2xs">
              <div className="flex items-center gap-2">
                <Badge variant="default">{i.status}</Badge>
                <span className="font-semibold">{i.title}</span>
                <span className="text-3xs text-ink-faint">{i.accessMethod} · {i.expectedLatency}</span>
              </div>
              <p className="text-ink-soft">{i.alphaThesis}</p>
              <p className="text-3xs text-ink-faint">risks: {i.risks} · kill: {i.killCriteria}</p>
            </div>
          ))
        )}
        {data?.researchAgentPrompt ? (
          <p className="border-t border-line/60 pt-1 text-3xs text-ink-faint">
            prompt: {data.researchAgentPrompt}
          </p>
        ) : null}
      </Panel>

      <Panel title={`disclosure radar — delayed public context (${disc?.disclosures.length ?? 0})`}>
        <p className="pb-1 text-3xs text-ink-faint">
          Federal Register documents mapped to markets by term overlap.
          Congressional financial disclosures are registered but NOT integrated
          (no permitted structured API — we don&apos;t scrape). Everything here is
          DELAYED context requiring human review; nothing trades from this panel.
        </p>
        {!disc?.disclosures.length ? (
          <EmptyNote>no disclosures fetched yet — the foundry tick pulls every 6h</EmptyNote>
        ) : (
          disc.disclosures.slice(0, 15).map((d) => (
            <div key={d.id} className="border-b border-line/60 py-1 text-2xs">
              <div className="flex items-center gap-2">
                <Badge variant="warn">human review</Badge>
                <a href={d.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-semibold hover:underline">
                  {d.title}
                </a>
                <span className="text-3xs text-ink-faint">{d.docType} · {d.filingDate} · lag {d.lagDays?.toFixed(0)}d</span>
              </div>
              {d.relatedMarkets.length ? (
                <p className="text-ink-soft">
                  possible markets: {d.relatedMarkets.map((r) => `${r.question.slice(0, 50)} (${(r.overlap * 100).toFixed(0)}%)`).join(" · ")}
                </p>
              ) : null}
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}
