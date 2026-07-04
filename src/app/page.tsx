"use client";

// Dashboard — hero metrics, scanner, selected-market workspace, live feed,
// robustness grid and Monte Carlo, in a dense terminal grid.

import { useTerminal } from "@/store/terminal";
import { useMarketDetail } from "@/hooks/api";
import { HeroMetrics } from "@/components/terminal/HeroMetrics";
import { ScannerTable } from "@/components/terminal/ScannerTable";
import { MarketWorkspace } from "@/components/terminal/MarketWorkspace";
import { LiveFeed } from "@/components/terminal/LiveFeed";
import { RobustnessGrid } from "@/components/terminal/RobustnessGrid";
import { MonteCarloPanel } from "@/components/terminal/MonteCarloPanel";

export default function DashboardPage() {
  const selected = useTerminal((s) => s.selectedConditionId);
  const { data: detail } = useMarketDetail(selected);

  return (
    <div className="space-y-2">
      <HeroMetrics />
      <div className="grid grid-cols-1 gap-2 xl:grid-cols-3">
        <ScannerTable compact className="max-h-[420px] xl:col-span-2" />
        <LiveFeed className="max-h-[420px]" />
      </div>
      <MarketWorkspace conditionId={selected} />
      <RobustnessGrid detail={detail} />
      <MonteCarloPanel />
    </div>
  );
}
