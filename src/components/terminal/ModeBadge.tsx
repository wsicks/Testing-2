"use client";

import { Badge } from "@/components/ui/badge";
import type { TerminalMode } from "@/lib/types";

export function ModeBadge({ mode }: { mode: TerminalMode }) {
  return (
    <Badge
      variant={mode === "live" ? "neg" : mode === "paper" ? "accent" : "warn"}
    >
      {mode}
    </Badge>
  );
}

/** mandatory label for anything sourced from sample/mock data */
export function SampleTag({ label = "sample" }: { label?: string }) {
  return (
    <Badge variant="warn" title="Demo-mode sample data — not real performance">
      {label}
    </Badge>
  );
}
