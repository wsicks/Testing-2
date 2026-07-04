"use client";

import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

export function Switch({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex h-4 w-7 shrink-0 items-center border border-line-strong bg-paper transition-colors data-[state=checked]:border-pos data-[state=checked]:bg-pos-soft",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block h-3 w-3 translate-x-0.5 bg-ink-faint transition-transform data-[state=checked]:translate-x-3.5 data-[state=checked]:bg-pos" />
    </SwitchPrimitive.Root>
  );
}
