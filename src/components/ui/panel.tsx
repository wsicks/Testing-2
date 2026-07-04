import { cn } from "@/lib/utils";

export function Panel({
  title,
  right,
  children,
  className,
  bodyClassName,
}: {
  title: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("flex flex-col border border-line bg-panel", className)}>
      <header className="flex h-6 shrink-0 items-center justify-between gap-2 border-b border-line px-2">
        <h3 className="label truncate">{title}</h3>
        {right ? <div className="flex items-center gap-1.5">{right}</div> : null}
      </header>
      <div className={cn("min-h-0 flex-1 p-2", bodyClassName)}>{children}</div>
    </section>
  );
}
