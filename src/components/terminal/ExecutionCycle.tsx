"use client";

// Five-stage execution workflow visual: Detect → Validate → Size → Execute →
// Monitor/Settle, with per-stage status derived from the current ticket state.

import type { ExecutionStage, StageStatus } from "@/lib/types";
import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<StageStatus, string> = {
  waiting: "border-line text-ink-faint bg-paper",
  running: "border-accent text-accent bg-accent-soft animate-pulse",
  passed: "border-pos text-pos bg-pos-soft",
  failed: "border-neg text-neg bg-neg-soft",
  approval_required: "border-warn text-warn bg-warn-soft",
};

const STATUS_TEXT: Record<StageStatus, string> = {
  waiting: "waiting",
  running: "running",
  passed: "passed",
  failed: "failed",
  approval_required: "approval req.",
};

export function ExecutionCycle({
  stages,
  className,
}: {
  stages: ExecutionStage[];
  className?: string;
}) {
  return (
    <Panel title="execution cycle" className={className}>
      <ol className="grid grid-cols-5 gap-1">
        {stages.map((s, i) => (
          <li key={s.key} className="flex flex-col gap-0.5">
            <div
              className={cn(
                "flex flex-col border px-1.5 py-1",
                STATUS_STYLE[s.status],
              )}
            >
              <span className="text-3xs font-bold uppercase tracking-wide">
                {i + 1}. {s.label}
              </span>
              <span className="num text-3xs">{STATUS_TEXT[s.status]}</span>
            </div>
            {s.detail ? (
              <span className="truncate text-3xs text-ink-faint" title={s.detail}>
                {s.detail}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </Panel>
  );
}

export function defaultStages(): ExecutionStage[] {
  return [
    { key: "detect", label: "Detect", status: "waiting" },
    { key: "validate", label: "Validate", status: "waiting" },
    { key: "size", label: "Size", status: "waiting" },
    { key: "execute", label: "Execute", status: "waiting" },
    { key: "monitor", label: "Monitor/Settle", status: "waiting" },
  ];
}
