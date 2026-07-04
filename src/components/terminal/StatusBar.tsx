"use client";

import { useEffect, useState } from "react";
import { useAutopilot, useHealth, usePortfolio, useSettings } from "@/hooks/api";
import { useFeed } from "@/hooks/useFeed";
import { useTerminal } from "@/store/terminal";
import { fmtAgo, fmtUsd, shortAddr } from "@/lib/format";
import { APP_NAME } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { Num } from "@/components/ui/num";
import { ModeBadge } from "./ModeBadge";

function Dot({ ok }: { ok: boolean | undefined }) {
  return (
    <span
      className={`inline-block h-1.5 w-1.5 rounded-full ${
        ok === undefined ? "bg-line-strong" : ok ? "bg-pos" : "bg-neg"
      }`}
    />
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1">
      <span className="label">{label}</span>
      <span className="num text-2xs">{children}</span>
    </div>
  );
}

export function StatusBar() {
  const mode = useTerminal((s) => s.mode);
  const { data: health } = useHealth();
  const { data: settings } = useSettings();
  const { data: pf } = usePortfolio(mode);
  const { data: ap } = useAutopilot();
  const { status: streamStatus } = useFeed(1);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 5_000);
    return () => clearInterval(t);
  }, []);

  const wallet = settings?.settings.watchWallet;
  const dailyBudget = settings?.settings.maxDailyLossUsd ?? 0;
  const dailyLossUsed = Math.max(0, -(pf?.portfolio.dailyRealizedPnl ?? 0));
  const budgetLeft = Math.max(0, dailyBudget - dailyLossUsed);

  return (
    <div className="flex h-7 items-center gap-3 overflow-x-auto border-b border-line-strong bg-panel px-2">
      <span className="font-mono text-xs font-bold tracking-[0.2em]">
        {APP_NAME}
      </span>
      <ModeBadge mode={mode} />
      {settings?.settings.killSwitch ? (
        <Badge variant="neg">KILL SWITCH</Badge>
      ) : null}
      <Item label="wallet">{wallet ? shortAddr(wallet) : "—"}</Item>
      <div className="flex items-center gap-1">
        <span className="label">api</span>
        <Dot ok={health?.gamma.ok} />
        <span className="label">gamma</span>
        <Dot ok={health?.clob.ok} />
        <span className="label">clob</span>
      </div>
      <div className="flex items-center gap-1">
        <span className="label">stream</span>
        <Dot ok={streamStatus === "open"} />
      </div>
      <Item label="lat">
        {health?.gamma.latencyMs !== undefined ? `${health.gamma.latencyMs}ms` : "—"}
      </Item>
      <Item label="sync">{fmtAgo(health?.checkedAt)}</Item>
      <Item label="open ord">{health?.openOrdersCount ?? "—"}</Item>
      <Item label="cash">
        {pf ? (
          <>
            {fmtUsd(pf.portfolio.cash)}
            {pf.portfolio.isSample ? <span className="text-warn"> (sample)</span> : null}
          </>
        ) : (
          "—"
        )}
      </Item>
      <Item label="risk budget">
        <Num tone={budgetLeft <= 0 ? "neg" : budgetLeft < dailyBudget * 0.3 ? "warn" : "pos"}>
          {fmtUsd(budgetLeft)}
        </Num>
      </Item>
      <div className="ml-auto flex items-center gap-1">
        {pf?.portfolio.isSample ? <Badge variant="warn">sample data</Badge> : null}
        {ap && ap.config.mode !== "off" ? (
          <Badge
            variant={
              ap.session.breakerTripped
                ? "neg"
                : ap.config.mode === "live"
                  ? "neg"
                  : ap.config.mode === "paper"
                    ? "pos"
                    : "accent"
            }
          >
            autopilot {ap.config.mode}
            {ap.session.breakerTripped ? " · breaker" : ""}
          </Badge>
        ) : null}
        <Badge variant={health?.scannersEnabled ? "pos" : "default"}>
          scanners {health?.scannersEnabled ? "on" : "off"}
        </Badge>
      </div>
    </div>
  );
}
