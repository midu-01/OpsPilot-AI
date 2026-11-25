"use client";

import type { ReactElement, ReactNode } from "react";
import * as RadixTooltip from "@radix-ui/react-tooltip";

interface TooltipProps {
  content: ReactNode;
  /** Must be a focusable element (button, link) so keyboard users get the tooltip too. */
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
}

export function Tooltip({ content, children, side = "top" }: TooltipProps) {
  return (
    <RadixTooltip.Provider delayDuration={250}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            side={side}
            sideOffset={6}
            className="z-50 max-w-xs rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg shadow-md motion-safe:animate-enter"
          >
            {content}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
