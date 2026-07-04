"use client";

import { useTerminal } from "@/store/terminal";
import { ScannerTable } from "@/components/terminal/ScannerTable";
import { MarketWorkspace } from "@/components/terminal/MarketWorkspace";

export default function ScannerPage() {
  const selected = useTerminal((s) => s.selectedConditionId);
  return (
    <div className="space-y-2">
      <ScannerTable className="max-h-[60vh]" />
      <MarketWorkspace conditionId={selected} />
    </div>
  );
}
