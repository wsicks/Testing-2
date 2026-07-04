"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex select-none items-center justify-center gap-1 whitespace-nowrap border font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-40",
  {
    variants: {
      variant: {
        default:
          "border-line-strong bg-panel text-ink hover:bg-paper active:bg-line",
        primary:
          "border-ink bg-ink text-paper hover:bg-ink-soft hover:border-ink-soft",
        buy: "border-pos bg-pos-soft text-pos hover:bg-pos hover:text-white",
        sell: "border-neg bg-neg-soft text-neg hover:bg-neg hover:text-white",
        danger: "border-neg bg-neg text-white hover:opacity-90",
        ghost: "border-transparent text-ink-soft hover:bg-paper hover:text-ink",
      },
      size: {
        xs: "h-5 px-1.5 text-3xs",
        sm: "h-6 px-2 text-2xs",
        md: "h-7 px-3 text-xs",
      },
    },
    defaultVariants: { variant: "default", size: "sm" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type, ...props }, ref) => (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";
