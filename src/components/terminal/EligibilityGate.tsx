"use client";

// First-run eligibility & terms acknowledgment. Blocks the terminal until the
// user confirms; acceptance is recorded server-side for the audit trail.

import { useEffect, useState } from "react";
import { usePatchSettings, useSettings } from "@/hooks/api";
import { useTerminal } from "@/store/terminal";
import { Button } from "@/components/ui/button";
import { APP_NAME } from "@/lib/constants";

const POINTS = [
  "This terminal is an analytics and research tool for Polymarket event markets. It is not investment, legal, or tax advice.",
  "Event markets are risky: positions can lose 100% of their value. Only risk funds you can afford to lose entirely.",
  "You are responsible for confirming you are legally eligible to access and trade on Polymarket in your jurisdiction, and for complying with Polymarket's terms of service. This tool will not help bypass region or platform restrictions.",
  "Demo mode shows clearly-labeled SAMPLE data that does not represent real performance. Backtests and Monte Carlo outputs are hypothetical simulations, not profit claims.",
  "The default mode is analytics + paper trading. Live trading stays locked until you explicitly enable it on the server and in settings, and every live order requires manual confirmation.",
  "All actions — signals, approvals, orders, cancels, fills, and errors — are recorded in the audit log.",
];

export function EligibilityGate({ children }: { children: React.ReactNode }) {
  const ackLocal = useTerminal((s) => s.ackTerms);
  const setAckLocal = useTerminal((s) => s.setAckTerms);
  const { data, isLoading } = useSettings();
  const patch = usePatchSettings();
  const [checked, setChecked] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const acknowledged = ackLocal || Boolean(data?.settings.termsAcceptedAt);

  if (!hydrated || isLoading || acknowledged) return <>{children}</>;

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper p-4">
      <div className="w-full max-w-xl border border-line-strong bg-panel">
        <div className="border-b border-line bg-paper px-3 py-1.5">
          <span className="font-mono text-sm font-bold tracking-[0.2em]">
            {APP_NAME}
          </span>
          <span className="label ml-2">eligibility &amp; terms acknowledgment</span>
        </div>
        <div className="space-y-2 p-4">
          <ul className="space-y-1.5">
            {POINTS.map((p, i) => (
              <li key={i} className="flex gap-2 text-xs leading-snug">
                <span className="num text-ink-faint">{String(i + 1).padStart(2, "0")}</span>
                <span>{p}</span>
              </li>
            ))}
          </ul>
          <label className="flex items-start gap-2 border border-line bg-paper p-2 text-xs">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              I have read and understood the above. I confirm I am eligible to
              use this tool in my jurisdiction and I accept full responsibility
              for any trading decisions.
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button
              variant="primary"
              size="md"
              disabled={!checked || patch.isPending}
              onClick={async () => {
                await patch.mutateAsync({ termsAcceptedAt: Date.now() });
                setAckLocal(true);
              }}
            >
              acknowledge &amp; enter terminal
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
