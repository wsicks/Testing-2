"use client";

// WALLET RADAR — public Polymarket wallets with category-specific skill,
// honest labels, and evidence-gated follow/fade controls. Only public
// on-chain activity + the venue's own pseudonyms; no identity inference.

import { useState } from "react";
import {
  useAlphaWallets,
  usePatchSettings,
  useSettings,
  useSignals,
  useWalletAction,
  useWalletDetail,
} from "@/hooks/api";
import type { WalletFollowMode } from "@/lib/alpha/types";
import { fmtAgo, shortAddr } from "@/lib/format";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Num } from "@/components/ui/num";
import { EmptyNote, Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const FOLLOW_MODES: { key: WalletFollowMode; label: string; note: string }[] = [
  { key: "watch_only", label: "watch only", note: "signals surface; nothing executes" },
  { key: "confirm_only", label: "confirm only", note: "wallet stances confirm other signals" },
  { key: "paper_mimic", label: "paper mimic", note: "proposed follow signals place PAPER test orders (≤$25, risk-engine gated)" },
  { key: "paper_fade", label: "paper fade", note: "proposed fade signals place PAPER test orders" },
];

const LABEL_TONE: Record<string, "pos" | "neg" | "warn" | "default"> = {
  smart_specialist: "pos",
  broad_smart_wallet: "pos",
  closing_market_sniper: "pos",
  fade_candidate: "neg",
  lucky_outlier: "warn",
  whale_not_smart: "warn",
  high_risk_gambler: "warn",
  likely_market_maker: "default",
  possible_wash_noise: "default",
  low_sample_unknown: "default",
  ignore: "default",
};

function WalletDetail({ walletId, onClose }: { walletId: string; onClose: () => void }) {
  const { data, isLoading } = useWalletDetail(walletId);
  if (isLoading) return <Panel title="wallet detail"><Spinner /></Panel>;
  if (!data) return null;
  const w = data.wallet;
  return (
    <Panel
      title={`wallet ${w.pseudonym ?? shortAddr(w.walletId)} — ${w.label.replace(/_/g, " ")}`}
      right={<Button size="xs" onClick={onClose}>close</Button>}
    >
      <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-2xs sm:grid-cols-6">
        <div><div className="label">closed trades</div><Num>{w.totalClosed}</Num></div>
        <div><div className="label">total pnl</div><Num tone={w.totalPnl}>{`$${w.totalPnl.toFixed(0)}`}</Num></div>
        <div><div className="label">cost-adj roi</div><Num tone={w.costAdjTotalRoi}>{(w.costAdjTotalRoi * 100).toFixed(1)}%</Num></div>
        <div><div className="label">forward samples</div><Num>{w.forward?.samples ?? 0}</Num></div>
        <div><div className="label">fwd 1h drift</div><Num tone={w.forward?.avgDrift1h ?? 0}>{w.forward ? `${(w.forward.avgDrift1h * 100).toFixed(2)}c` : "—"}</Num></div>
        <div><div className="label">status</div><Badge variant={w.status === "tracked" ? "pos" : "default"}>{w.status}</Badge></div>
      </div>
      {w.rejectReason ? <p className="pt-1 text-2xs text-neg">discovery rejection: {w.rejectReason}</p> : null}
      <div className="pt-1">
        <div className="label">skill by dimension (cost-adjusted, est. 1.5c/share round-trip)</div>
        <table className="w-full text-2xs">
          <thead>
            <tr className="border-b border-line-strong text-left">
              {["dimension", "n", "roi (adj)", "roi (raw)", "win rate", "profit factor", "lucky", "confidence"].map((h) => (
                <th key={h} className="cell label">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {w.dimensions.slice(0, 12).map((d) => (
              <tr key={d.dimension} className="border-b border-line/60">
                <td className="cell font-semibold">{d.dimension}</td>
                <td className="cell"><Num>{d.sampleSize}</Num></td>
                <td className="cell"><Num tone={d.costAdjRoi}>{(d.costAdjRoi * 100).toFixed(1)}%</Num></td>
                <td className="cell"><Num className="text-ink-faint">{(d.rawRoi * 100).toFixed(1)}%</Num></td>
                <td className="cell"><Num>{(d.winRate * 100).toFixed(0)}%</Num></td>
                <td className="cell"><Num>{d.profitFactor.toFixed(2)}</Num></td>
                <td className="cell"><Num tone={d.luckyConcentration > 0.5 ? "warn" : undefined}>{(d.luckyConcentration * 100).toFixed(0)}%</Num></td>
                <td className="cell"><Num>{(d.confidence * 100).toFixed(0)}%</Num></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pt-1">
        <div className="label">recent public trades</div>
        {data.trades.slice(0, 12).map((t, i) => (
          <div key={i} className="flex items-center gap-2 border-b border-line/60 py-0.5 text-2xs">
            <Badge variant={t.side === "BUY" ? "pos" : "neg"}>{t.side}</Badge>
            <span className="min-w-0 flex-1 truncate">{t.title ?? t.conditionId.slice(0, 18)}</span>
            <Num>{t.outcome}</Num>
            <Num>{(t.price * 100).toFixed(1)}c</Num>
            <Num>×{t.size.toFixed(0)}</Num>
            <span className="text-3xs text-ink-faint">{fmtAgo(t.ts)}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

export default function WalletsPage() {
  const { data, isLoading } = useAlphaWallets();
  const { data: settingsData } = useSettings();
  const patch = usePatchSettings();
  const act = useWalletAction();
  const { data: shadowSignals } = useSignals({ strategy: "wallet_shadow", limit: 12 });
  const { data: fadeSignals } = useSignals({ strategy: "wallet_fade", limit: 8 });
  const [selected, setSelected] = useState<string | undefined>();
  const [addr, setAddr] = useState("");
  const alpha = settingsData?.settings.alpha;
  const wallets = data?.wallets ?? [];
  const walletSignals = [...(shadowSignals?.signals ?? []), ...(fadeSignals?.signals ?? [])]
    .sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="space-y-2">
      <Panel
        title={`wallet radar (${wallets.filter((w) => w.status === "tracked").length} tracked / ${wallets.length} known)`}
        right={
          <>
            {isLoading || act.isPending ? <Spinner /> : null}
            <Button size="xs" onClick={() => act.mutate({ action: "intel" })} disabled={act.isPending}>refresh intel</Button>
            <Button size="xs" onClick={() => act.mutate({ action: "rescore" })} disabled={act.isPending}>rescore</Button>
            <Button size="xs" variant="primary" onClick={() => act.mutate({ action: "discover" })} disabled={act.isPending}>discover now</Button>
          </>
        }
      >
        <p className="text-2xs text-ink-soft">
          Public wallets scored by <span className="font-semibold">category-specific</span> skill
          (never global fame), cost-adjusted, luck-tested (best trade removed), and
          only followable with measured forward evidence. Intel: {data?.intel.markets ?? 0} markets,
          built {data?.intel.builtAt ? fmtAgo(data.intel.builtAt) : "never"}. No
          deanonymization — addresses + venue pseudonyms only. Live auto-copy does not exist.
        </p>
        <div className="flex flex-wrap items-center gap-1 pt-1">
          <span className="label">follow mode</span>
          {FOLLOW_MODES.map((m) => (
            <button
              key={m.key}
              title={m.note}
              onClick={() => alpha && patch.mutate({ alpha: { ...alpha, walletFollowMode: m.key } })}
              className={cn(
                "border px-1.5 py-0.5 text-3xs font-bold uppercase",
                alpha?.walletFollowMode === m.key
                  ? "border-accent bg-accent text-white"
                  : "border-line text-ink-faint hover:border-line-strong hover:text-ink",
              )}
            >
              {m.label}
            </button>
          ))}
          <span className="pl-2 text-3xs text-ink-faint">
            live copy: <span className="font-bold text-neg">not available</span> (requires feature promotion + human approval + live gates; manual preview only)
          </span>
        </div>
        <div className="flex items-center gap-1 pt-1">
          <input
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            placeholder="0x… track a public wallet manually"
            className="w-96 border border-line bg-paper px-1.5 py-0.5 font-mono text-2xs"
          />
          <Button
            size="xs"
            disabled={!/^0x[a-fA-F0-9]{40}$/.test(addr) || act.isPending}
            onClick={() => { act.mutate({ action: "track", wallet: addr }); setAddr(""); }}
          >
            track
          </Button>
        </div>
      </Panel>

      {selected ? <WalletDetail walletId={selected} onClose={() => setSelected(undefined)} /> : null}

      <Panel title="wallets" bodyClassName="p-0">
        {!wallets.length ? (
          <EmptyNote>
            no wallets yet — run discovery (pulls public large trades + top
            holders, scores each, rejects low-sample/lucky/cost-fragile ones)
          </EmptyNote>
        ) : (
          <table className="w-full text-2xs">
            <thead>
              <tr className="border-b border-line-strong text-left">
                {["wallet", "label", "status", "closed", "pnl", "roi (adj)", "best dimension", "fwd n", "fwd 1h", "score", "last seen", ""].map((h) => (
                  <th key={h} className="cell label">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {wallets.slice(0, 60).map((w) => {
                const best = [...w.dimensions]
                  .filter((d) => d.dimension.startsWith("cat:") && d.sampleSize >= 10)
                  .sort((a, b) => b.costAdjRoi - a.costAdjRoi)[0];
                return (
                  <tr key={w.walletId} className="cursor-pointer border-b border-line/60 hover:bg-paper" onClick={() => setSelected(w.walletId)}>
                    <td className="cell font-mono">{w.pseudonym ?? shortAddr(w.walletId)}</td>
                    <td className="cell"><Badge variant={LABEL_TONE[w.label] ?? "default"}>{w.label.replace(/_/g, " ")}</Badge></td>
                    <td className="cell text-ink-faint">{w.status}{w.manuallyAdded ? " (manual)" : ""}</td>
                    <td className="cell"><Num>{w.totalClosed}</Num></td>
                    <td className="cell"><Num tone={w.totalPnl}>{`$${w.totalPnl.toFixed(0)}`}</Num></td>
                    <td className="cell"><Num tone={w.costAdjTotalRoi}>{(w.costAdjTotalRoi * 100).toFixed(1)}%</Num></td>
                    <td className="cell">{best ? `${best.dimension.slice(4)} ${(best.costAdjRoi * 100).toFixed(0)}% (n=${best.sampleSize})` : "—"}</td>
                    <td className="cell"><Num>{w.forward?.samples ?? 0}</Num></td>
                    <td className="cell"><Num tone={w.forward?.avgDrift1h ?? 0}>{w.forward ? `${(w.forward.avgDrift1h * 100).toFixed(2)}c` : "—"}</Num></td>
                    <td className="cell"><Num>{w.candidateScore?.toFixed(1) ?? "—"}</Num></td>
                    <td className="cell text-ink-faint">{fmtAgo(w.lastSeen)}</td>
                    <td className="cell">
                      {w.status !== "archived" ? (
                        <Button size="xs" onClick={(e) => { e.stopPropagation(); act.mutate({ action: "archive", wallet: w.walletId }); }}>
                          archive
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title={`wallet signals (${walletSignals.length})`}>
        {!walletSignals.length ? (
          <EmptyNote>
            no wallet signals yet — they appear when tracked smart wallets take
            fresh positions; most self-reject until forward evidence exists
            (that is the system working, not failing)
          </EmptyNote>
        ) : (
          walletSignals.map((s) => (
            <div key={s.id} className="border-b border-line/60 py-1 text-2xs">
              <div className="flex items-center gap-2">
                <Badge variant={s.status === "proposed" ? "pos" : "neg"}>
                  {s.status === "proposed" ? "all gates passed" : `${s.checks.filter((c) => !c.passed).length} gate(s) failed`}
                </Badge>
                <Badge variant={s.direction === "BUY_YES" ? "pos" : s.direction === "BUY_NO" ? "neg" : "default"}>
                  {s.direction.replace("_", " ")}
                </Badge>
                <span className="min-w-0 flex-1 truncate font-semibold">{s.marketQuestion}</span>
                <Num className="font-bold">{s.score}</Num>
                <span className="text-3xs text-ink-faint">{fmtAgo(s.createdAt)}</span>
              </div>
              <p className="text-ink-soft">{s.summary}</p>
              {s.checks.filter((c) => !c.passed).slice(0, 4).map((c, i) => (
                <div key={i} className="flex gap-2 text-3xs">
                  <span className="w-8 shrink-0 font-bold text-neg">FAIL</span>
                  <span className="w-36 shrink-0 font-semibold">{c.name}</span>
                  <span className="text-ink-faint">{c.detail}</span>
                </div>
              ))}
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}
