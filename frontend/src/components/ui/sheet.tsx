"use client";

import type { ReactNode } from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Button } from "./button";

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}

/** A bottom sheet built on Radix Dialog: focus trap, Escape to close, focus returns to the trigger. */
export function Sheet({ open, onOpenChange, title, description, children }: SheetProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <RadixDialog.Content className="fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col rounded-t-xl border border-border bg-surface shadow-xl motion-safe:animate-enter">
          <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <RadixDialog.Title className="text-sm font-semibold">{title}</RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="mt-0.5 text-ui text-muted">{description}</RadixDialog.Description>
              ) : (
                <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
              )}
            </div>
            <RadixDialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close">
                <X aria-hidden />
              </Button>
            </RadixDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
