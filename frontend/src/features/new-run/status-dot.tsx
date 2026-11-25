import { CircleCheck, CircleDashed, CircleX } from "lucide-react";
import { cx } from "@/lib/cx";

const ICONS = { success: CircleCheck, danger: CircleX, neutral: CircleDashed };
const COLORS = { success: "text-success", danger: "text-danger", neutral: "text-muted" };

/** A status with a shape (icon) and a word, never color alone. */
export function StatusDot({ tone, label }: { tone: "success" | "danger" | "neutral"; label: string }) {
  const Icon = ICONS[tone];
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-ui font-medium", COLORS[tone])}>
      <Icon aria-hidden className="size-4" />
      {label}
    </span>
  );
}
