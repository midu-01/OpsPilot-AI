import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "@/lib/cx";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("rounded-lg border border-border bg-surface", className)} {...props} />;
}

interface CardHeaderProps {
  title: ReactNode;
  titleId?: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function CardHeader({ title, titleId, description, actions, className }: CardHeaderProps) {
  return (
    <div className={cx("flex items-start justify-between gap-3 border-b border-border px-4 py-3", className)}>
      <div className="min-w-0">
        <h2 id={titleId} className="text-sm font-semibold text-fg">
          {title}
        </h2>
        {description ? <p className="mt-0.5 text-ui text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
