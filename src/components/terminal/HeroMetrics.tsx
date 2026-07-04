"use client";

import { usePortfolio } from "@/hooks/api";
import { useTerminal } from "@/store/terminal";
import { fmtPct, fmtSignedUsd, fmtUsd } from "@/lib/format";
import { Panel } from "@/components/ui/panel";
import { Num } from "@/components/ui/num";
import { SampleTag } from "./ModeBadge";

function Metric({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "pos" | "neg" | "warn" | number;
  sub?: string;
}) {
  return (
    <div className="border border-line bg-paper px-2 py-1">
      <div className="label">{label}</div>
      <div className="text-sm">
        <Num tone={tone}>{value}</Num>
      </div>
      {sub ? <div className="text-3xs text-ink-faint">{sub}</div> : null}
    </div>
  );
}

export function HeroMetrics() {
  const mode = useTerminal((s) => s.mode);
  const { data } = usePortfolio(mode);
  const p = data?.portfolio;
  const sample = p?.isSample;

  return (
    <Panel
      title={`portfolio — ${mode}`}
      right={sample ? <SampleTag label="sample pnl" /> : undefined}
      bodyClassName="grid grid-cols-2 gap-1 sm:grid-cols-4 xl:grid-cols-11"
    >
      <Metric label={sample ? "total value (sample)" : "total value"} value={fmtUsd(p?.totalValue)} />
      <Metric
        label="realized pnl"
        value={fmtSignedUsd(p?.realizedPnl)}
        tone={p?.realizedPnl ?? 0}
      />
      <Metric
        label="unrealized pnl"
        value={fmtSignedUsd(p?.unrealizedPnl)}
        tone={p?.unrealizedPnl ?? 0}
      />
      <Metric
        label="all-time pnl"
        value={fmtSignedUsd(p?.allTimePnl)}
        tone={p?.allTimePnl ?? 0}
      />
      <Metric
        label="daily pnl"
        value={fmtSignedUsd(p?.dailyPnl)}
        tone={p?.dailyPnl ?? 0}
      />
      <Metric
        label="win rate"
        value={p?.winRate !== undefined ? fmtPct(p.winRate, 0) : "—"}
        sub={p ? `${p.closedTrades} closed` : undefined}
      />
      <Metric
        label="avg r/r"
        value={p?.avgRR !== undefined ? p.avgRR.toFixed(2) : "—"}
      />
      <Metric
        label="max drawdown"
        value={p?.maxDrawdown !== undefined ? fmtPct(p.maxDrawdown) : "—"}
        tone={p?.maxDrawdown && p.maxDrawdown > 0.1 ? "warn" : undefined}
      />
      <Metric label="exposure" value={fmtUsd(p?.exposure)} />
      <Metric
        label="liquidity risk"
        value={
          p?.liquidityRiskScore !== undefined
            ? p.liquidityRiskScore.toFixed(2)
            : "—"
        }
        tone={
          p?.liquidityRiskScore !== undefined && p.liquidityRiskScore > 0.5
            ? "warn"
            : undefined
        }
      />
      <Metric
        label="active positions"
        value={p ? p.positions.filter((x) => x.size > 0).length : "—"}
      />
    </Panel>
  );
}
