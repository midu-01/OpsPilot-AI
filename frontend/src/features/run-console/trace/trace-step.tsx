import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cx } from "@/lib/cx";
import type { Tone } from "@/lib/status";
import { TONE_CLASSES } from "@/components/ui/badge";

export interface StepPosition {
  /** 1-based position in the feed. */
  position: number;
  /** Total items, or -1 while the trace is still growing (ARIA feed pattern). */
  total: number;
  isLast: boolean;
}

interface TraceStepProps extends StepPosition {
  id: string;
  icon: LucideIcon;
  tone: Tone;
  title: ReactNode;
  meta?: ReactNode;
  spinning?: boolean;
  children?: ReactNode;
}

/** One node of the vertical trace: a status-colored marker, a connector line and content. */
export function TraceStep(props: TraceStepProps) {
  const { id, icon: Icon, tone, title, meta, spinning, children, position, total, isLast } = props;
  const titleId = `${id}-title`;
  return (
    // tabIndex -1: not in the tab order, but focusable, so actions can move focus to their result.
    <article
      id={id}
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-posinset={position}
      aria-setsize={total}
      className="relative rounded-md pb-7 pl-10 motion-safe:animate-enter"
    >
      {isLast ? null : <span aria-hidden className="absolute top-8 bottom-0 left-[13px] w-px bg-border" />}
      <span
        aria-hidden
        className={cx("absolute top-0 left-0 grid size-7 place-items-center rounded-full border", TONE_CLASSES[tone])}
      >
        <Icon className={cx("size-3.5", spinning && "motion-safe:animate-spin")} />
      </span>
      <header className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-0.5">
        <h3 id={titleId} className="text-sm font-semibold text-fg">
          {title}
        </h3>
        {meta ? <span className="text-xs text-muted">{meta}</span> : null}
      </header>
      {children ? <div className="mt-2 min-w-0">{children}</div> : null}
    </article>
  );
}
