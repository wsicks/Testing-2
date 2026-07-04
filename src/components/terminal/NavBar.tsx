"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useTerminal } from "@/store/terminal";
import type { TerminalMode } from "@/lib/types";
import { useKillSwitch, useSettings } from "@/hooks/api";
import { Button } from "@/components/ui/button";

const LINKS: { href: string; label: string }[] = [
  { href: "/", label: "Dashboard" },
  { href: "/scanner", label: "Scanner" },
  { href: "/autopilot", label: "Autopilot" },
  { href: "/positions", label: "Positions" },
  { href: "/orders", label: "Orders" },
  { href: "/signals", label: "Signals" },
  { href: "/crossvenue", label: "Cross-Venue" },
  { href: "/sources", label: "Sources" },
  { href: "/backtesting", label: "Backtesting" },
  { href: "/settings/risk", label: "Risk" },
  { href: "/settings/api", label: "API/Wallet" },
  { href: "/audit", label: "Audit" },
  { href: "/perf", label: "Perf" },
];

export function NavBar() {
  const pathname = usePathname();
  const mode = useTerminal((s) => s.mode);
  const setMode = useTerminal((s) => s.setMode);
  const { data: settings } = useSettings();
  const killSwitch = useKillSwitch();
  const engaged = settings?.settings.killSwitch ?? false;

  const switchMode = (m: TerminalMode) => {
    if (m === "live") {
      const envOn = settings?.liveTradingEnv;
      const optIn = settings?.settings.liveModeEnabled;
      if (!envOn || !optIn) {
        window.alert(
          "Live mode is locked. Enable LIVE_TRADING_ENABLED on the server AND opt in under Settings → API/Wallet first. Orders always require explicit confirmation.",
        );
        return;
      }
      if (
        !window.confirm(
          "Switch to LIVE mode? Live order intents route to the real CLOB after explicit per-order confirmation. Event markets can lose 100% of position value.",
        )
      )
        return;
    }
    setMode(m);
  };

  return (
    <nav className="flex h-7 items-center gap-0.5 overflow-x-auto border-b border-line bg-paper px-1">
      {LINKS.map((l) => {
        const active =
          l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={cn(
              "px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide",
              active
                ? "border border-line-strong bg-panel text-ink"
                : "border border-transparent text-ink-faint hover:text-ink",
            )}
          >
            {l.label}
          </Link>
        );
      })}
      <div className="ml-auto flex items-center gap-1 pr-1">
        {(["demo", "paper", "live"] as TerminalMode[]).map((m) => (
          <button
            key={m}
            onClick={() => switchMode(m)}
            className={cn(
              "border px-1.5 py-0.5 text-3xs font-bold uppercase",
              mode === m
                ? m === "live"
                  ? "border-neg bg-neg text-white"
                  : m === "paper"
                    ? "border-accent bg-accent text-white"
                    : "border-warn bg-warn text-white"
                : "border-line text-ink-faint hover:border-line-strong hover:text-ink",
            )}
          >
            {m}
          </button>
        ))}
        <Button
          size="xs"
          variant={engaged ? "default" : "danger"}
          onClick={() => {
            if (
              engaged ||
              window.confirm(
                "Engage KILL SWITCH? This disables all trading, cancels open orders and live intents, and stops scanners.",
              )
            ) {
              killSwitch.mutate(!engaged);
            }
          }}
        >
          {engaged ? "release kill" : "kill"}
        </Button>
      </div>
    </nav>
  );
}
