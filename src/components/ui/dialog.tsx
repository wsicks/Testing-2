"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  title,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  title: string;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink/30" />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto border border-line-strong bg-panel shadow-lg focus:outline-none",
          className,
        )}
        {...props}
      >
        <div className="flex h-6 items-center justify-between border-b border-line bg-paper px-2">
          <DialogPrimitive.Title className="label">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Close className="text-ink-faint hover:text-ink">
            <X size={12} />
          </DialogPrimitive.Close>
        </div>
        <div className="p-3">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
