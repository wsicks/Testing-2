"use client";

// Right-side drawer — market, wallet or signal detail. The market view
// carries the honest trade panel: reasons for/against straight from signal
// check trails, a PAPER preview (full risk engine, nothing placed) and a
// LIVE preview that is preview-ONLY: placing live orders from this board
// does not exist; the button routes through the normal risk preview and
// shows the live-gate verdict.

import { useState } from "react";
import Link from "next/link";
import {
  useMorphishLivePreview,
  useMorphishPaperPreview,
  useMorphishSelected,
  useSettings,
  useWalletDetail,
} from "@/hooks/api";
import type { RiskAssessment } from "@/lib/types";
import { fmtCents, fmtUsd, shortAddr, fmtAgo } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Num } from "@/components/ui/num";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export type DrawerTarget =
  | { kind: "market"; id: string }
  | { kind: "wallet"; id: string }
  | null;

function Assessment({ a, title }: { a: RiskAssessment; title: string }) {
  return (
    <div className="border border-line bg-paper p-1.5 text-2xs">
      <div className="flex items-center gap-2">
        <span className="label">{title}</span>
        <Badge variant={a.approved ? "pos" : "neg"}>{a.approved ? "APPROVED" : "BLOCKED"}</Badge>
        <span className="text-3xs text-ink-faint">
          net edge {fmtCents(a.netEdge)} · max loss {fmtUsd(a.maxLossUsd)}
        </span>
      </div>
      {a.checks.filter((c) => !c.passed).map((c, i) => (
        <div key={i} className="flex gap-2 text-3xs">
          <span className={cn("w-10 shrink-0 font-bold", c.severity === "block" ? "text-neg" : "text-warn")}>
            {c.severity === "block" ? "BLOCK" : "WARN"}
          </span>
          <span className="text-ink-soft">{c.detail}</span>
        </div>
      ))}
    </div>
  );
}

function MarketContent({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading } = useMorphishSelected(id);
  const { data: settings } = useSettings();
  const paper = useMorphishPaperPreview();
  const live = useMorphishLivePreview();
  const [side, setSide] = useState<"YES" | "NO">("YES");
  if (isLoading || !data) return <Spinner />;
  const m = data.market;
  const buyYes = side === "YES";
  const tokenId = buyYes ? m.yesTokenId : m.noTokenId;
  const price = buyYes
    ? data.book?.bestAsk ?? m.bestAsk
    : data.book?.bestBid !== undefined
      ? 1 - data.book.bestBid
      : m.noPrice;
  const size = price ? Math.max(1, Math.floor(10 / price)) : 0;
  const previewBody = tokenId && price
    ? { conditionId: id, tokenId, outcome: side === "YES" ? "Yes" : "No", side: "BUY" as const, price: Number(price.toFixed(3)), size }
    : null;
  const liveAllowed = settings?.liveTradingEnv && settings.settings.liveModeEnabled;

  return (
    <>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-2xs font-bold">{m.question}</div>
          <div className="text-3xs uppercase text-ink-faint">
            {m.venueId} · {m.category ?? "uncategorized"}
            {m.referenceOnly ? " · REFERENCE-ONLY" : ""}
          </div>
        </div>
        <Button size="xs" onClick={onClose}>close</Button>
      </div>
      <div className="grid grid-cols-3 gap-x-3 gap-y-1 border-t border-line/60 pt-1 text-2xs">
        <div><div className="label">bid</div><Num>{fmtCents(data.book?.bestBid ?? m.bestBid)}</Num></div>
        <div><div className="label">ask</div><Num>{fmtCents(data.book?.bestAsk ?? m.bestAsk)}</Num></div>
        <div><div className="label">mid</div><Num>{fmtCents(data.book?.midpoint ?? m.midpoint)}</Num></div>
        <div><div className="label">spread</div><Num>{fmtCents(data.book?.spread ?? m.spread)}</Num></div>
        <div><div className="label">liquidity</div><Num>{fmtUsd(m.liquidity, 0)}</Num></div>
        <div><div className="label">24h vol</div><Num>{fmtUsd(m.volume24h, 0)}</Num></div>
        <div><div className="label">rule clarity</div><Num tone={data.ruleClarity < 0.9 ? "warn" : "pos"}>{data.ruleClarity.toFixed(2)}</Num></div>
        <div className="col-span-2"><div className="label">clarity basis</div><span className="text-3xs text-ink-soft">{data.clarityReason}</span></div>
      </div>
      {data.walletIntel?.entries.length ? (
        <div className="border-t border-line/60 pt-1 text-2xs">
          <div className="label">tracked wallets in this market</div>
          {data.walletIntel.entries.slice(0, 4).map((e) => (
            <div key={e.walletId} className="flex items-center gap-2">
              <Badge variant={e.label.includes("smart") ? "pos" : e.label === "fade_candidate" ? "neg" : "default"}>
                {e.label.replace(/_/g, " ")}
              </Badge>
              <span>{e.displayName ?? shortAddr(e.walletId)} {e.side} @ {fmtCents(e.avgEntryPrice)} (${Math.round(e.sizeUsd)}){e.exiting ? " — exiting" : ""}</span>
            </div>
          ))}
        </div>
      ) : null}
      {data.crossLinks.length ? (
        <div className="border-t border-line/60 pt-1 text-2xs">
          <div className="label">cross-venue</div>
          {data.crossLinks.slice(0, 3).map((l) => (
            <div key={l.id} className="truncate">
              <Badge variant={l.matchStatus === "conflict" ? "neg" : l.matchStatus === "strong_candidate" ? "pos" : "default"}>
                {l.matchStatus.replace(/_/g, " ")}
              </Badge>{" "}
              {l.sourceMarketId === id ? l.targetTitle : l.sourceTitle}
            </div>
          ))}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2 border-t border-line/60 pt-1 text-2xs">
        <div>
          <div className="label text-pos">reasons to trade</div>
          {data.reasonsFor.length === 0 ? <p className="text-3xs text-ink-faint">none recorded</p> :
            data.reasonsFor.map((r, i) => <p key={i} className="text-3xs text-ink-soft">✓ {r}</p>)}
        </div>
        <div>
          <div className="label text-neg">reasons not to</div>
          {data.reasonsAgainst.length === 0 ? <p className="text-3xs text-ink-faint">none recorded</p> :
            data.reasonsAgainst.map((r, i) => <p key={i} className="text-3xs text-ink-soft">✗ {r}</p>)}
        </div>
      </div>
      <div className="flex items-center gap-1 border-t border-line/60 pt-1">
        {(["YES", "NO"] as const).map((s) => (
          <button key={s} onClick={() => setSide(s)}
            className={cn("border px-2 py-0.5 text-3xs font-bold",
              side === s ? "border-accent bg-accent text-white" : "border-line text-ink-faint")}>
            {s}
          </button>
        ))}
        <Button size="xs" variant="primary" disabled={!previewBody || paper.isPending || m.referenceOnly}
          onClick={() => previewBody && paper.mutate(previewBody)}>
          paper preview ($10 test)
        </Button>
        <Button size="xs" disabled={!previewBody || live.isPending || m.referenceOnly}
          title={liveAllowed ? "risk preview only — live orders require the intent flow" : "live is locked (env + settings opt-in required)"}
          onClick={() => previewBody && live.mutate(previewBody)}>
          live preview {liveAllowed ? "" : "(locked)"}
        </Button>
        <Link href={`/market/${id}`} className="text-3xs underline">full workspace →</Link>
      </div>
      {paper.data ? <Assessment a={paper.data.assessment} title="paper risk preview" /> : null}
      {live.data ? (
        <>
          <Assessment a={live.data.assessment} title="live risk preview (preview ONLY)" />
          {!live.data.liveGateOpen ? (
            <p className="text-3xs text-neg">live gate closed: {live.data.liveGateReasons.join("; ")}</p>
          ) : null}
          <p className="text-3xs text-ink-faint">{live.data.note}</p>
        </>
      ) : null}
      {data.signals.length ? (
        <div className="border-t border-line/60 pt-1 text-2xs">
          <div className="label">signals on this market</div>
          {data.signals.map((s) => (
            <details key={s.id} className="py-0.5">
              <summary className="cursor-pointer">
                <Badge variant={s.status === "proposed" ? "pos" : "neg"}>{s.status}</Badge>{" "}
                <span className="font-semibold">{s.strategyLabel}</span> {s.score}/100 · {s.direction.replace("_", " ")} · {fmtAgo(s.createdAt)}
              </summary>
              {s.checks.map((c, i) => (
                <div key={i} className="flex gap-2 text-3xs">
                  <span className={cn("w-8 shrink-0 font-bold", c.passed ? "text-pos" : "text-neg")}>
                    {c.passed ? "PASS" : "FAIL"}
                  </span>
                  <span className="text-ink-soft">{c.detail}</span>
                </div>
              ))}
            </details>
          ))}
        </div>
      ) : null}
    </>
  );
}

function WalletContent({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading } = useWalletDetail(id);
  if (isLoading || !data) return <Spinner />;
  const w = data.wallet;
  return (
    <>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-2xs font-bold">{w.pseudonym ?? shortAddr(w.walletId)}</div>
          <div className="text-3xs uppercase text-ink-faint">{w.label.replace(/_/g, " ")} · {w.status}</div>
        </div>
        <Button size="xs" onClick={onClose}>close</Button>
      </div>
      <div className="grid grid-cols-3 gap-x-3 gap-y-1 border-t border-line/60 pt-1 text-2xs">
        <div><div className="label">closed</div><Num>{w.totalClosed}</Num></div>
        <div><div className="label">pnl</div><Num tone={w.totalPnl}>{fmtUsd(w.totalPnl, 0)}</Num></div>
        <div><div className="label">roi (adj)</div><Num tone={w.costAdjTotalRoi}>{(w.costAdjTotalRoi * 100).toFixed(1)}%</Num></div>
        <div><div className="label">fwd samples</div><Num>{w.forward?.samples ?? 0}</Num></div>
        <div><div className="label">fwd 1h</div><Num tone={w.forward?.avgDrift1h ?? 0}>{w.forward ? fmtCents(w.forward.avgDrift1h) : "—"}</Num></div>
        <div><div className="label">best dim</div><span className="text-3xs">{w.dimensions[0]?.dimension ?? "—"}</span></div>
      </div>
      <p className="pt-1 text-3xs text-ink-faint">
        follow/fade controls live on the <Link href="/wallets" className="underline">Wallets</Link> page —
        watch-only by default; live auto-copy does not exist.
      </p>
      <div className="border-t border-line/60 pt-1 text-2xs">
        <div className="label">recent public trades</div>
        {data.trades.slice(0, 8).map((t, i) => (
          <div key={i} className="flex items-center gap-2 py-0.5 text-3xs">
            <Badge variant={t.side === "BUY" ? "pos" : "neg"}>{t.side}</Badge>
            <span className="min-w-0 flex-1 truncate">{t.title ?? t.conditionId.slice(0, 16)}</span>
            <Num>{fmtCents(t.price)}</Num>
            <span className="text-ink-faint">{fmtAgo(t.ts)}</span>
          </div>
        ))}
      </div>
    </>
  );
}

export function MorphishDrawer({
  target,
  onClose,
}: {
  target: DrawerTarget;
  onClose: () => void;
}) {
  if (!target) return null;
  return (
    <div className="fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto border-l border-line-strong bg-panel p-2 shadow-xl">
      <div className="space-y-1.5">
        {target.kind === "market" ? (
          <MarketContent id={target.id} onClose={onClose} />
        ) : (
          <WalletContent id={target.id} onClose={onClose} />
        )}
      </div>
    </div>
  );
}
