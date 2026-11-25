import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, children, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span className="grid size-10 place-items-center rounded-full border border-border bg-surface-2 text-muted">
        <Icon aria-hidden className="size-5" />
      </span>
      <h2 className="mt-4 text-sm font-semibold text-fg">{title}</h2>
      {children ? <div className="mt-1 max-w-sm text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
