"use client";

// CLAIM VALUE + TOTAL PNL — the big-number KPI card from the reference,
// bound to the REAL portfolio for the active mode. Demo state is labeled
// SAMPLE; negative expectancy is diagnosed, never hidden.

import { useMorphishSummary } from "@/hooks/api";
import { useTerminal } from "@/store/terminal";
import { fmtSignedUsd, fmtUsd } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Num } from "@/components/ui/num";
import { cn } from "@/lib/utils";

function Field({ k, v, tone }: { k: string; v: string; tone?: number | "warn" }) {
  return (
    <div>
      <div className="label">{k}</div>
      <Num tone={tone === "warn" ? "warn" : tone}>{v}</Num>
    </div>
  );
}

export function KpiCard() {
  const mode = useTerminal((s) => s.mode);
  const { data } = useMorphishSummary(mode);
  if (!data) return <div className="border border-line bg-panel p-3 text-2xs text-ink-faint">loading portfolio…</div>;
  const p = data.portfolio;
  const wr = p.winRate;
  const be = data.breakevenWinRate;

  return (
    <div className="border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-line/60 bg-paper px-2 py-1">
        <span className="text-3xs font-bold uppercase tracking-widest">claim value + total pnl</span>
        <Badge variant={mode === "live" ? "neg" : mode === "paper" ? "accent" : "warn"}>
          {mode}{data.isSample ? " · SAMPLE DATA" : ""}
        </Badge>
        <Badge variant={data.riskState === "SAFE" ? "pos" : data.riskState === "WATCH" ? "warn" : "neg"}>
          {data.riskState}
        </Badge>
        <Badge variant={(data.change24hUsd ?? 0) >= 0 ? "accent" : "neg"}>
          24h {fmtSignedUsd(data.change24hUsd ?? 0)}
        </Badge>
      </div>
      <div className="px-3 pt-2">
        <div className={cn("num text-4xl font-black tracking-tight", p.allTimePnl >= 0 ? "text-accent" : "text-ink")}>
          {fmtUsd(p.totalValue)}
        </div>
        <div className="flex flex-wrap items-center gap-2 pb-1 pt-0.5 text-2xs text-ink-soft">
          <span>all-time pnl <Num tone={p.allTimePnl}>{fmtSignedUsd(p.allTimePnl)}</Num></span>
          <span>· {p.closedTrades} closed trades</span>
          {wr !== undefined ? (
            <Badge variant={be !== undefined && wr >= be ? "accent" : "warn"}>
              {(wr * 100).toFixed(0)}% WR
            </Badge>
          ) : null}
          {p.avgRR !== undefined ? <Badge variant="default">R/R {p.avgRR.toFixed(2)}</Badge> : null}
        </div>
      </div>
      {data.negativeExpectancy && be !== undefined && wr !== undefined ? (
        <div className="mx-3 mb-1 border border-neg/40 bg-neg/5 px-2 py-1 text-2xs">
          <span className="font-bold text-neg">NEGATIVE EXPECTANCY DETECTED</span>
          <span className="pl-2 text-ink-soft">
            EDGE REQUIRED: {(be * 100).toFixed(1)}% WR at R/R {p.avgRR?.toFixed(2)} · CURRENT WIN
            RATE: {(wr * 100).toFixed(1)}% — the process loses money before variance; size stays
            crippled until this flips
          </span>
        </div>
      ) : null}
      <div className="grid grid-cols-3 gap-x-4 gap-y-1 border-t border-line/60 p-2 text-2xs sm:grid-cols-5 lg:grid-cols-7">
        <Field k="realized pnl" v={fmtSignedUsd(p.realizedPnl)} tone={p.realizedPnl} />
        <Field k="unrealized" v={fmtSignedUsd(p.unrealizedPnl)} tone={p.unrealizedPnl} />
        <Field k="daily pnl" v={fmtSignedUsd(p.dailyPnl)} tone={p.dailyPnl} />
        <Field k="win rate" v={wr !== undefined ? `${(wr * 100).toFixed(1)}%` : "—"} />
        <Field k="avg r/r" v={p.avgRR !== undefined ? p.avgRR.toFixed(2) : "—"} />
        <Field k="breakeven wr" v={be !== undefined ? `${(be * 100).toFixed(1)}%` : "—"} tone={data.negativeExpectancy ? "warn" : undefined} />
        <Field k="max drawdown" v={p.maxDrawdown !== undefined ? fmtUsd(p.maxDrawdown) : "—"} />
        <Field k="exposure" v={fmtUsd(p.exposure)} />
        <Field k="cash" v={fmtUsd(p.cash)} />
        <Field k="open orders" v={fmtUsd(data.openOrderExposure)} />
        <Field k="positions" v={String(p.positions.length)} />
        <Field
          k="liquidity risk"
          v={p.liquidityRiskScore !== undefined ? `${(p.liquidityRiskScore * 100).toFixed(0)}%` : "—"}
          tone={(p.liquidityRiskScore ?? 0) > 0.5 ? "warn" : undefined}
        />
        <Field k="wallet intel" v={`${data.walletIntelMarkets} mkts`} />
      </div>
    </div>
  );
}
