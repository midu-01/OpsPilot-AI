"use client";

import type { ComponentProps } from "react";
import * as RadixTabs from "@radix-ui/react-tabs";
import { cx } from "@/lib/cx";

/** Radix tabs give arrow-key navigation and the tab/tabpanel ARIA wiring. */
export const Tabs = RadixTabs.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof RadixTabs.List>) {
  return <RadixTabs.List className={cx("flex items-center gap-1 border-b border-border", className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof RadixTabs.Trigger>) {
  return (
    <RadixTabs.Trigger
      className={cx(
        "-mb-px inline-flex h-9 items-center gap-1.5 border-b-2 border-transparent px-2.5 text-ui font-medium text-muted",
        "transition-colors hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg",
        "[&_svg]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof RadixTabs.Content>) {
  return <RadixTabs.Content className={cx("outline-none", className)} {...props} />;
}
