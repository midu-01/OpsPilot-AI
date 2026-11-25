"use client";

import type { ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import type { Activity } from "@/lib/activity";
import { cx } from "@/lib/cx";
import type { RunState } from "@/lib/run-events";
import { runStatusMeta } from "@/lib/status";
import { StatusPill } from "@/components/ui/status-pill";
import { buttonClasses } from "@/components/ui/button";
import { revealElement } from "@/hooks/use-follow-scroll";
import { ConnectionBadge } from "./connection-badge";
import { StopControl } from "./stop-control";
import type { ConnectionState } from "./use-run-stream";

const NOW_DOT: Record<Activity["tone"], string> = {
  neutral: "bg-neutral",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

interface StatusBarProps {
  state: RunState;
  activity: Activity;
  connection: ConnectionState;
  onStopped: () => void;
  /** Extra actions, e.g. the inspector button on small screens. */
  actions?: ReactNode;
}

/** Sticky under the app header: status, connection, what the agent is doing now, and actions. */
export function StatusBar({ state, activity, connection, onStopped, actions }: StatusBarProps) {
  const approval = state.pending_approval;
  return (
    <div className="sticky top-14 z-30 -mx-4 border-y border-border bg-bg px-4 py-2.5 sm:-mx-6 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusPill meta={runStatusMeta(state.status)} />
        <ConnectionBadge connection={connection} />
        <p className="order-last flex min-w-0 basis-full items-center gap-2 text-sm text-fg md:order-none md:flex-1 md:basis-auto">
          <span aria-hidden className={cx("size-1.5 shrink-0 rounded-full", NOW_DOT[activity.tone], activity.live && "motion-safe:animate-live")} />
          <span className="min-w-0 md:truncate">{activity.text}</span>
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {approval ? (
            <button
              type="button"
              onClick={() => revealElement(`approval-${approval.id}`, `approval-${approval.id}-title`)}
              className={buttonClasses("secondary", "sm", "border-warning-border bg-warning-soft text-warning hover:bg-warning-soft")}
            >
              <ShieldAlert aria-hidden />
              Review approval
            </button>
          ) : null}
          <StopControl runId={state.id} status={state.status} onStopped={onStopped} />
          {actions}
        </div>
      </div>
    </div>
  );
}
