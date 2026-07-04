import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 border px-1 py-px text-3xs font-semibold uppercase tracking-wide leading-none",
  {
    variants: {
      variant: {
        default: "border-line-strong bg-paper text-ink-soft",
        pos: "border-pos/40 bg-pos-soft text-pos",
        neg: "border-neg/40 bg-neg-soft text-neg",
        warn: "border-warn/40 bg-warn-soft text-warn",
        accent: "border-accent/40 bg-accent-soft text-accent",
        ink: "border-ink bg-ink text-paper",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
