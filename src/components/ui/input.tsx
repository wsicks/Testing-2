"use client";

import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const Input = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn("terminal-input w-full", className)} {...props} />
));
Input.displayName = "Input";

export const Select = forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn("terminal-input w-full appearance-none pr-4", className)}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = "Select";

export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex flex-col gap-0.5", className)}>
      <span className="label">{label}</span>
      {children}
    </label>
  );
}
