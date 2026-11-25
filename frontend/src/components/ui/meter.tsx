import { cx } from "@/lib/cx";

interface MeterProps {
  label: string;
  value: number;
  max: number;
  /** Readable value for screen readers, e.g. "3 of 20 turns used". */
  valueText: string;
  className?: string;
}

/** A thin usage bar. It turns amber past 80% of the limit and red at the limit. */
export function Meter({ label, value, max, valueText, className }: MeterProps) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const fill = ratio >= 1 ? "bg-danger" : ratio >= 0.8 ? "bg-warning" : "bg-accent";
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      className={cx("h-1 w-full overflow-hidden rounded-full bg-surface-3", className)}
    >
      <div className={cx("h-full rounded-full transition-[width] duration-300", fill)} style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}
