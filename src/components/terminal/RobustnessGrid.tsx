"use client";

// Grid of system/market robustness checks for the selected market + account.

import { useHealth, useSettings, type MarketDetail } from "@/hooks/api";
import { usePortfolio } from "@/hooks/api";
import { useTerminal } from "@/store/terminal";
import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/utils";
import { fmtAgo } from "@/lib/format";

type CheckState = "ok" | "warn" | "fail" | "na";

function Cell({ label, state, detail }: { label: string; state: CheckState; detail: string }) {
  return (
    <div
      className={cn(
        "border px-1.5 py-1",
        state === "ok" && "border-pos/40 bg-pos-soft",
        state === "warn" && "border-warn/40 bg-warn-soft",
        state === "fail" && "border-neg/40 bg-neg-soft",
        state === "na" && "border-line bg-paper",
      )}
      title={detail}
    >
      <div className="label">{label}</div>
      <div
        className={cn(
          "num text-2xs font-bold",
          state === "ok" && "text-pos",
          state === "warn" && "text-warn",
          state === "fail" && "text-neg",
          state === "na" && "text-ink-faint",
        )}
      >
        {state === "na" ? "n/a" : state}
      </div>
      <div className="truncate text-3xs text-ink-faint">{detail}</div>
    </div>
  );
}

export function RobustnessGrid({
  detail,
  className,
}: {
  detail?: MarketDetail;
  className?: string;
}) {
  const mode = useTerminal((s) => s.mode);
  const { data: health } = useHealth();
  const { data: settingsData } = useSettings();
  const { data: pf } = usePortfolio(mode);
  const s = settingsData?.settings;
  const m = detail?.market;
  const book = detail?.yesBook;

  const freshSecs = m ? (Date.now() - m.fetchedAt) / 1000 : undefined;
  const spread = book?.spread ?? m?.spread;
  const depth = book ? book.bidDepthUsd + book.askDepthUsd : undefined;
  const move = Math.abs(m?.oneDayPriceChange ?? 0);
  const exposurePct =
    pf && pf.portfolio.totalValue > 0
      ? (pf.portfolio.exposure / pf.portfolio.totalValue) * 100
      : 0;
  const hrsLeft = m?.endDate
    ? (new Date(m.endDate).getTime() - Date.now()) / 3_600_000
    : undefined;
  const catCount = Object.keys(pf?.portfolio.exposureByCategory ?? {}).length;

  const cells: { label: string; state: CheckState; detail: string }[] = [
    {
      label: "api freshness",
      state:
        freshSecs === undefined
          ? health?.gamma.ok
            ? "ok"
            : "fail"
          : freshSecs <= (s?.staleDataMaxSecs ?? 60)
            ? "ok"
            : "fail",
      detail:
        freshSecs !== undefined
          ? `data ${Math.round(freshSecs)}s old`
          : `gamma ${health?.gamma.ok ? "up" : "down"}`,
    },
    {
      label: "book depth",
      state:
        depth === undefined ? "na" : depth >= 2_000 ? "ok" : depth >= 500 ? "warn" : "fail",
      detail: depth !== undefined ? `$${Math.round(depth).toLocaleString()} near mid` : "no book loaded",
    },
    {
      label: "spread quality",
      state:
        spread === undefined
          ? "na"
          : spread <= (s?.maxSpread ?? 0.03)
            ? "ok"
            : spread <= (s?.maxSpread ?? 0.03) * 2
              ? "warn"
              : "fail",
      detail: spread !== undefined ? `${(spread * 100).toFixed(1)}c vs ${(100 * (s?.maxSpread ?? 0.03)).toFixed(0)}c max` : "—",
    },
    {
      label: "volatility",
      state: move < 0.05 ? "ok" : move < 0.15 ? "warn" : "fail",
      detail: `Δ24h ${(move * 100).toFixed(1)}c`,
    },
    {
      label: "resolution clarity",
      state:
        m === undefined
          ? "na"
          : m.tradability === "avoid" && m.gradeFactors.includes("unclear resolution rules")
            ? "fail"
            : m.gradeFactors.includes("unclear resolution rules")
              ? "warn"
              : "ok",
      detail: m ? `grade ${m.riskGrade}` : "—",
    },
    {
      label: "exposure limit",
      state: exposurePct < 60 ? "ok" : exposurePct < 85 ? "warn" : "fail",
      detail: `${exposurePct.toFixed(1)}% deployed`,
    },
    {
      label: "slippage est.",
      state:
        depth === undefined ? "na" : depth > 5_000 ? "ok" : depth > 1_000 ? "warn" : "fail",
      detail: depth !== undefined ? "sized vs near-mid depth" : "—",
    },
    {
      label: "correlation risk",
      state: catCount === 0 ? "na" : catCount >= 3 ? "ok" : "warn",
      detail: `${catCount} categor${catCount === 1 ? "y" : "ies"} held`,
    },
    {
      label: "closing time",
      state:
        hrsLeft === undefined
          ? "na"
          : hrsLeft > 48
            ? "ok"
            : hrsLeft > 6
              ? "warn"
              : "fail",
      detail: hrsLeft !== undefined ? `${hrsLeft.toFixed(1)}h to close` : "—",
    },
    {
      label: "wallet/api",
      state: s?.killSwitch
        ? "fail"
        : mode === "live"
          ? health?.liveTradingEnv && s?.liveModeEnabled
            ? "ok"
            : "fail"
          : "ok",
      detail: s?.killSwitch
        ? "kill switch engaged"
        : mode === "live"
          ? "live gate status"
          : `${mode} mode — checked ${fmtAgo(health?.checkedAt)}`,
    },
  ];

  return (
    <Panel title="robustness checks" className={className} bodyClassName="grid grid-cols-2 gap-1 md:grid-cols-5">
      {cells.map((c) => (
        <Cell key={c.label} {...c} />
      ))}
    </Panel>
  );
}
