"use client";

// ALPHA FOUNDRY — the research machine's dashboard: feature lifecycle with
// measured evidence and decay curves, prosecutor verdicts, the graveyard
// (failed ideas + lessons), research-agent ideas, and Disclosure Radar
// context. Promotion is a human act performed here, and only after the
// prosecutor passes.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
            <span className="label" title="realized paper PnL from AUTOPILOT-managed trades only">paper pnl</span>
            <Num tone={pnl.realizedUsd}>${pnl.realizedUsd.toFixed(2)}</Num>
            <span className="text-3xs text-ink-faint">{pnl.wins}W/{pnl.losses}L · simulated</span>
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
            {/* graveyard is terminal from this door — no approve button on
                retired/rejected features (server enforces the same) */}
            {f.status !== "promoted" && f.status !== "retired" && f.status !== "rejected" && verdict?.passed ? (
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
  const qc = useQueryClient();
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

      <Panel title="evidence lab — the machine reading its own outcome archive">
        <div className="grid gap-3 lg:grid-cols-2">
          <div>
            <div className="label">signal confluence (joint 1h drift vs best solo, pairs with n ≥ {data?.confluence.minSamples ?? 8})</div>
            {!data?.confluence.cells.length ? (
              <EmptyNote>
                no strategy pair has fired together often enough yet — the
                matrix fills as strategies co-fire on the same markets within
                {" "}{Math.round((data?.confluence.windowMs ?? 900000) / 60000)}min
              </EmptyNote>
            ) : (
              <table className="w-full text-2xs">
                <thead>
                  <tr className="border-b border-line-strong text-left">
                    {["pair", "n", "joint 1h", "solo A", "solo B", "lift"].map((h) => (
                      <th key={h} className="cell label">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.confluence.cells.slice(0, 8).map((c) => (
                    <tr key={`${c.a}|${c.b}`} className="border-b border-line/60">
                      <td className="cell font-semibold">{c.a} + {c.b}</td>
                      <td className="cell"><Num>{c.n}</Num></td>
                      <td className="cell"><Num tone={c.jointAvg1h}>{(c.jointAvg1h * 100).toFixed(2)}c</Num></td>
                      <td className="cell"><Num className="text-ink-faint">{(c.soloAvgA * 100).toFixed(2)}c</Num></td>
                      <td className="cell"><Num className="text-ink-faint">{(c.soloAvgB * 100).toFixed(2)}c</Num></td>
                      <td className="cell"><Num tone={c.lift}>{(c.lift * 100).toFixed(2)}c</Num></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="pt-0.5 text-3xs text-ink-faint">
              positive lift = the combination adds information; ~zero = the two
              strategies are counting the same fact twice
            </p>
          </div>
          <div>
            <div className="label">
              drift by price level ({data?.driftProfile.totalSamples ?? 0} samples, 24h raw drift)
            </div>
            <div className="flex h-20 items-end gap-0.5 pt-1">
              {(data?.driftProfile.buckets ?? []).map((b) => {
                // 24h drift once available; 1h fills within the first hour
                const use24 = b.n > 0;
                const val = use24 ? b.avgRawDrift24h : b.avgRawDrift1h;
                const n = use24 ? b.n : b.n1h;
                const h = Math.min(36, Math.abs(val) * 900);
                return (
                  <div key={b.lo} className="flex flex-1 flex-col items-center" title={`${(b.lo * 100).toFixed(0)}–${(b.hi * 100).toFixed(0)}c: ${(val * 100).toFixed(2)}c avg ${use24 ? "24h" : "1h"} drift, n=${n}`}>
                    <div className="flex h-16 w-full flex-col justify-center">
                      <div
                        className={cn("w-full", val >= 0 ? "self-end bg-accent" : "self-start bg-neg", !use24 && "opacity-60")}
                        style={{ height: `${n > 0 ? Math.max(2, h) : 0}px`, marginTop: val >= 0 ? `${36 - h}px` : "36px" }}
                      />
                    </div>
                    <span className="text-3xs text-ink-faint">{(b.lo * 100).toFixed(0)}</span>
                    <span className="text-3xs text-ink-faint">n{n}{!use24 && n > 0 ? "·1h" : ""}</span>
                  </div>
                );
              })}
            </div>
            <p className="pt-0.5 text-3xs text-ink-faint">{data?.driftProfile.note}</p>
          </div>
        </div>
        <div className="border-t border-line/60 pt-1">
          <div className="label">narrative half-life — per-category repricing speed (n ≥ 15 real 24h moves)</div>
          {!data?.halfLives.length ? (
            <p className="text-3xs text-ink-faint">
              accumulating — needs categories with ≥15 outcomes where a real
              (≥1c) 24h move followed the signal; sets honest per-category
              horizons instead of one global constant
            </p>
          ) : (
            <div className="flex flex-wrap gap-x-6 gap-y-1 pt-0.5 text-2xs">
              {data.halfLives.map((h) => (
                <span key={h.category}>
                  <span className="label">{h.category}</span>{" "}
                  <Badge variant={h.speed === "minutes" ? "warn" : h.speed === "hours" ? "accent" : "default"}>{h.speed}</Badge>{" "}
                  <Num className="text-ink-faint">
                    {h.share5m !== undefined ? `${(h.share5m * 100).toFixed(0)}%@5m · ` : ""}
                    {(h.share1h * 100).toFixed(0)}%@1h · n={h.n}
                  </Num>
                </span>
              ))}
            </div>
          )}
        </div>
      </Panel>

      <Panel title="strategy tournament — promotion ladder">
        {!data?.tournament.length ? (
          <EmptyNote>no strategy tournament yet — waiting for measured outcomes</EmptyNote>
        ) : (
          <table className="w-full text-2xs">
            <thead>
              <tr className="border-b border-line-strong text-left">
                {["strategy", "tier", "score", "samples", "net hit", "private edge", "fill quality", "why"].map((h) => (
                  <th key={h} className="cell label">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.tournament.map((t) => (
                <tr key={t.strategy} className="border-b border-line/60">
                  <td className="cell font-semibold">{t.strategy}</td>
                  <td className="cell">
                    <Badge
                      variant={
                        t.tier === "promote"
                          ? "pos"
                          : t.tier === "shadow"
                            ? "accent"
                            : t.tier === "retire"
                              ? "neg"
                              : "warn"
                      }
                    >
                      {t.tier}
                    </Badge>
                  </td>
                  <td className="cell"><Num tone={t.score - 50}>{t.score}</Num></td>
                  <td className="cell"><Num>{t.evidence.samples}</Num></td>
                  <td className="cell"><Num tone={t.evidence.netHitRate - 0.5}>{(t.evidence.netHitRate * 100).toFixed(0)}%</Num></td>
                  <td className="cell">
                    {t.evidence.privateEdgeCents !== undefined ? (
                      <Num tone={t.evidence.privateEdgeCents}>{t.evidence.privateEdgeCents.toFixed(2)}c</Num>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                  <td className="cell"><Num tone={(t.evidence.fillQuality ?? 0.5) - 0.5}>{((t.evidence.fillQuality ?? 0) * 100).toFixed(0)}%</Num></td>
                  <td className="cell text-3xs text-ink-faint">{t.reasons.join(" · ") || "measuring"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="pt-0.5 text-3xs text-ink-faint">
          The tournament blends sample count, Wilson floor, net hit rate,
          private edge after friction and execution quality. It is a promotion
          queue, not a profit claim.
        </p>
      </Panel>

      <Panel title="measured win rates — what the governor gates on">
        {!data?.hitRates.length ? (
          <EmptyNote>
            no 1h outcomes captured yet — win rates appear as the outcome
            tracker fills (they are measured, never assumed)
          </EmptyNote>
        ) : (
          <table className="w-full text-2xs">
            <thead>
              <tr className="border-b border-line-strong text-left">
                {["strategy", "n", "hit rate", "wilson floor", "net hit rate", "avg 1h drift", "governor"].map((h) => (
                  <th key={h} className="cell label">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.hitRates.map((h) => {
                const proven = h.n >= 20;
                const blocked = proven && h.hitRate < 0.45;
                return (
                  <tr key={h.strategy} className="border-b border-line/60">
                    <td className="cell font-semibold">{h.strategy}</td>
                    <td className="cell"><Num>{h.n}</Num></td>
                    <td className="cell"><Num tone={h.hitRate >= 0.5 ? "pos" : "neg"}>{(h.hitRate * 100).toFixed(0)}%</Num></td>
                    <td className="cell"><Num className="text-ink-faint">{proven ? `${(h.wilsonLo * 100).toFixed(0)}%` : "—"}</Num></td>
                    <td className="cell"><Num tone={h.netHitRate >= 0.5 ? "pos" : undefined}>{(h.netHitRate * 100).toFixed(0)}%</Num></td>
                    <td className="cell"><Num tone={h.avgDrift1h}>{(h.avgDrift1h * 100).toFixed(2)}c</Num></td>
                    <td className="cell">
                      {blocked ? (
                        <Badge variant="neg">entries blocked</Badge>
                      ) : proven ? (
                        <Badge variant="pos">eligible</Badge>
                      ) : (
                        <span className="text-3xs text-ink-faint">unproven (n&lt;20)</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="pt-0.5 text-3xs text-ink-faint">
          hit rate = share of captured 1h drifts &gt; 0; net clears each
          signal&apos;s own friction (half-spread + 50bps). The Wilson floor is
          the 95% lower bound — the win rate the sample has actually PROVEN.
          The autopilot blocks entries from strategies measuring &lt;45% over
          n≥20 and ranks proven strategies by their floor.
        </p>
      </Panel>

      <Panel title={`complement arbitrage — profit locked at entry (${data?.arb.pairs ?? 0} pairs, paper)`}>
        {!data?.arb.pairs ? (
          <EmptyNote>
            no cross-book mispricing captured yet — the executor verifies
            both books live whenever gamma mids hint YES+NO &lt; $1 and pairs
            only when the NET discount clears 0.5c after fees. Rare by
            nature; every capture is arithmetic, not a forecast.
          </EmptyNote>
        ) : (
          <div className="space-y-1 text-2xs">
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <span><span className="label">pairs</span> <Num>{data.arb.pairs}</Num></span>
              <span><span className="label">locked net (at resolution)</span> <Num tone="pos">${data.arb.lockedNetUsd.toFixed(2)}</Num></span>
              <span><span className="label">unwound (leg-2 miss)</span> <Num tone={data.arb.unwound ? "warn" : undefined}>{data.arb.unwound}</Num></span>
            </div>
            {data.arb.recent.map((p) => (
              <div key={p.id} className="flex items-center gap-2 border-t border-line/60 pt-1">
                <Badge variant={p.status === "filled" ? "pos" : "warn"}>{p.status}</Badge>
                <span className="min-w-0 flex-1 truncate">{p.question}</span>
                <Num>{p.pairs}×</Num>
                <Num tone="pos">+${p.lockedNetUsd.toFixed(2)}</Num>
                <span className="text-3xs text-ink-faint">{(p.netDiscount * 100).toFixed(1)}c/pair · {fmtAgo(p.ts)}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title={`runtime errors (${data?.runtimeErrors.filter((e) => !e.resolved).length ?? 0} open)`}>
        {!data?.runtimeErrors.length ? (
          <EmptyNote>
            no runtime errors captured — scanner/foundry/autopilot/strategy
            failures are deduped here and triaged into ERRORLOG.md in the repo
          </EmptyNote>
        ) : (
          <div className="space-y-1">
            {data.runtimeErrors.slice(0, 12).map((e) => (
              <div key={e.id} className="flex items-start gap-2 border-b border-line/60 pb-1 text-2xs">
                <Badge variant={e.resolved ? "default" : "neg"}>{e.resolved ? "resolved" : `×${e.count}`}</Badge>
                <span className="w-40 shrink-0 font-semibold">{e.source}</span>
                <span className="min-w-0 flex-1 text-ink-soft">
                  {e.message}
                  {e.detail ? <span className="text-ink-faint"> — {e.detail}</span> : null}
                </span>
                <span className="shrink-0 text-3xs text-ink-faint">{fmtAgo(e.lastAt)}</span>
                {!e.resolved ? (
                  <Button
                    size="xs"
                    onClick={() =>
                      fetch("/api/errors", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ action: "resolve", id: e.id }),
                      }).then(() => qc.invalidateQueries({ queryKey: ["alpha"] }))
                    }
                  >
                    resolve
                  </Button>
                ) : null}
              </div>
            ))}
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
