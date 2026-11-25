import { cx } from "@/lib/cx";

/** A placeholder block. Size it to match the content it stands in for, so nothing shifts. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx("skeleton motion-safe:animate-shimmer", className)} />;
}
