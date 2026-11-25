import type { ApprovalStatus, RunStatus } from "./api.ts";

/** Semantic color of a status. Every tone is always paired with an icon and a label. */
export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export type StatusIcon = "queued" | "running" | "waiting" | "stopping" | "completed" | "failed" | "cancelled";

export interface StatusMeta {
  label: string;
  tone: Tone;
  icon: StatusIcon;
}

const RUN_STATUS: Record<RunStatus, StatusMeta> = {
  queued: { label: "Queued", tone: "neutral", icon: "queued" },
  running: { label: "Running", tone: "info", icon: "running" },
  awaiting_approval: { label: "Needs approval", tone: "warning", icon: "waiting" },
  cancelling: { label: "Stopping", tone: "warning", icon: "stopping" },
  completed: { label: "Completed", tone: "success", icon: "completed" },
  failed: { label: "Failed", tone: "danger", icon: "failed" },
  cancelled: { label: "Cancelled", tone: "neutral", icon: "cancelled" },
};

/** Tool call status is a free string on the API, so unknown values get a neutral fallback. */
const TOOL_STATUS: Record<string, StatusMeta> = {
  requested: { label: "Requested", tone: "neutral", icon: "queued" },
  running: { label: "Running", tone: "info", icon: "running" },
  awaiting_approval: { label: "Awaiting approval", tone: "warning", icon: "waiting" },
  completed: { label: "Done", tone: "success", icon: "completed" },
  failed: { label: "Failed", tone: "danger", icon: "failed" },
};

const APPROVAL_STATUS: Record<ApprovalStatus, StatusMeta> = {
  pending: { label: "Pending", tone: "warning", icon: "waiting" },
  approved: { label: "Approved", tone: "success", icon: "completed" },
  rejected: { label: "Rejected", tone: "danger", icon: "failed" },
  cancelled: { label: "Cancelled", tone: "neutral", icon: "cancelled" },
};

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status);
}

/** Stop is offered while the run can still be cancelled. */
export function canStop(status: string): boolean {
  return status === "queued" || status === "running" || status === "awaiting_approval";
}

export function humanizeStatus(status: string): string {
  const words = status.replace(/[_.-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Unknown";
}

function fallback(status: string): StatusMeta {
  return { label: humanizeStatus(status), tone: "neutral", icon: "queued" };
}

export function runStatusMeta(status: string): StatusMeta {
  return RUN_STATUS[status as RunStatus] ?? fallback(status);
}

export function toolStatusMeta(status: string): StatusMeta {
  return TOOL_STATUS[status] ?? fallback(status);
}

export function approvalStatusMeta(status: string): StatusMeta {
  return APPROVAL_STATUS[status as ApprovalStatus] ?? fallback(status);
}
