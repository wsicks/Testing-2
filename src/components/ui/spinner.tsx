import { cn } from "@/lib/utils";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-3 w-3 animate-spin rounded-full border border-ink-faint border-t-transparent",
        className,
      )}
      aria-label="loading"
    />
  );
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-12 items-center justify-center p-3 text-2xs text-ink-faint">
      {children}
    </div>
  );
}
