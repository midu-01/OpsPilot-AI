import { CircleDot, History, LoaderCircle, RefreshCw, WifiOff, type LucideIcon } from "lucide-react";
import { cx } from "@/lib/cx";
import type { ConnectionState } from "./use-run-stream";

const CONNECTION: Record<ConnectionState, { label: string; icon: LucideIcon | null; className: string; spin?: boolean }> = {
  connecting: { label: "Connecting…", icon: LoaderCircle, className: "text-muted", spin: true },
  live: { label: "Live", icon: null, className: "text-success" },
  reconnecting: { label: "Reconnecting…", icon: RefreshCw, className: "text-warning", spin: true },
  offline: { label: "Offline, retrying", icon: WifiOff, className: "text-danger" },
  closed: { label: "Stream complete", icon: CircleDot, className: "text-muted" },
  history: { label: "Replayed from history", icon: History, className: "text-muted" },
};

/** The state of the run stream's WebSocket, separate from the run's own status. */
export function ConnectionBadge({ connection }: { connection: ConnectionState }) {
  const { label, icon: Icon, className, spin } = CONNECTION[connection];
  return (
    // A polite status: screen readers hear "Reconnecting…" or "Offline" without losing focus.
    <span role="status" className={cx("inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap", className)}>
      {Icon ? (
        <Icon aria-hidden className={cx("size-3.5", spin && "motion-safe:animate-spin")} />
      ) : (
        <span aria-hidden className="relative flex size-2">
          <span className="absolute inline-flex size-full rounded-full bg-success opacity-60 motion-safe:animate-ping" />
          <span className="relative inline-flex size-2 rounded-full bg-success" />
        </span>
      )}
      {label}
    </span>
  );
}
