import { Ban, CircleCheck, CirclePause, CircleStop, CircleX, Clock3, LoaderCircle, type LucideIcon } from "lucide-react";
import { cx } from "@/lib/cx";
import type { StatusIcon, StatusMeta } from "@/lib/status";
import { Badge } from "./badge";

const ICONS: Record<StatusIcon, LucideIcon> = {
  queued: Clock3,
  running: LoaderCircle,
  waiting: CirclePause,
  stopping: CircleStop,
  completed: CircleCheck,
  failed: CircleX,
  cancelled: Ban,
};

/** A status always shows color, an icon and a text label together. */
export function StatusIconGlyph({ icon, className }: { icon: StatusIcon; className?: string }) {
  const Icon = ICONS[icon];
  const spin = icon === "running" ? "motion-safe:animate-spin" : "";
  return <Icon aria-hidden className={cx(spin, className)} />;
}

export function StatusPill({ meta, className }: { meta: StatusMeta; className?: string }) {
  return (
    <Badge tone={meta.tone} className={className}>
      <StatusIconGlyph icon={meta.icon} />
      {meta.label}
    </Badge>
  );
}
