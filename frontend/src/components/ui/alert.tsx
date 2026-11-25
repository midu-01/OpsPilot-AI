import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import { cx } from "@/lib/cx";
import type { Tone } from "@/lib/status";
import { TONE_CLASSES } from "./badge";

const ICONS: Record<Tone, LucideIcon> = {
  neutral: Info,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
};

interface AlertProps {
  tone?: Tone;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  /** "alert" interrupts screen readers; use it only for errors the user must act on. */
  role?: "alert" | "status";
  className?: string;
}

export function Alert({ tone = "danger", title, children, action, role, className }: AlertProps) {
  const Icon = ICONS[tone];
  return (
    <div role={role} className={cx("flex gap-3 rounded-lg border px-3.5 py-3 text-sm", TONE_CLASSES[tone], className)}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {children ? <div className="mt-1 text-fg">{children}</div> : null}
        {action ? <div className="mt-3 flex flex-wrap gap-2">{action}</div> : null}
      </div>
    </div>
  );
}
