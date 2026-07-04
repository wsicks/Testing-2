import { cn } from "@/lib/utils";

/** monospace numeric cell with pos/neg/warn coloring */
export function Num({
  children,
  tone,
  className,
}: {
  children: React.ReactNode;
  tone?: "pos" | "neg" | "warn" | "muted" | number;
  className?: string;
}) {
  const t =
    typeof tone === "number"
      ? tone > 0
        ? "pos"
        : tone < 0
          ? "neg"
          : undefined
      : tone;
  return (
    <span
      className={cn(
        "num",
        t === "pos" && "text-pos",
        t === "neg" && "text-neg",
        t === "warn" && "text-warn",
        t === "muted" && "text-ink-faint",
        className,
      )}
    >
      {children}
    </span>
  );
}
