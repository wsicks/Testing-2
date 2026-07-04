"use client";

import { use, useEffect } from "react";
import { useTerminal } from "@/store/terminal";
import { useMarketDetail } from "@/hooks/api";
import { MarketWorkspace } from "@/components/terminal/MarketWorkspace";
import { RobustnessGrid } from "@/components/terminal/RobustnessGrid";

export default function MarketDetailPage({
  params,
}: {
  params: Promise<{ conditionId: string }>;
}) {
  const { conditionId } = use(params);
  const selectMarket = useTerminal((s) => s.selectMarket);
  const { data: detail } = useMarketDetail(conditionId);
  useEffect(() => selectMarket(conditionId), [conditionId, selectMarket]);

  return (
    <div className="space-y-2">
      <MarketWorkspace conditionId={conditionId} full />
      <RobustnessGrid detail={detail} />
    </div>
  );
}
