import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import type { Tone } from "@/lib/status";

export const TONE_CLASSES: Record<Tone, string> = {
  neutral: "border-neutral-border bg-neutral-soft text-neutral",
  info: "border-info-border bg-info-soft text-info",
  success: "border-success-border bg-success-soft text-success",
  warning: "border-warning-border bg-warning-soft text-warning",
  danger: "border-danger-border bg-danger-soft text-danger",
};

interface BadgeProps {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}

export function Badge({ tone = "neutral", children, className }: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3.5",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
