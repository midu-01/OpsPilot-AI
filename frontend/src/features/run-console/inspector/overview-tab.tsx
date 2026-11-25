import type { ReactNode } from "react";
import { formatDateTime, plural } from "@/lib/format";
import type { RunState } from "@/lib/run-events";
import { approvalStatusMeta, runStatusMeta } from "@/lib/status";
import { CopyButton } from "@/components/ui/copy-button";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3 px-4 py-2">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-fg">{children}</dd>
    </div>
  );
}

/** Everything the snapshot says about the run itself. */
export function OverviewTab({ state }: { state: RunState }) {
  const timeZone = state.business_timezone;
  return (
    <dl className="divide-y divide-border text-ui">
      <Row label="Status">{runStatusMeta(state.status).label}</Row>
      <Row label="Run ID">
        <span className="flex items-start gap-1">
          <code className="font-mono break-all">{state.id}</code>
          <CopyButton text={state.id} label="Copy run ID" showLabel={false} />
        </span>
      </Row>
      <Row label="Provider / model">
        {state.provider} / {state.model}
      </Row>
      <Row label="Reference time">{formatDateTime(state.reference_time, timeZone)}</Row>
      <Row label="Business timezone">{timeZone}</Row>
      <Row label="Created">{formatDateTime(state.created_at, timeZone)}</Row>
      <Row label="Last updated">{formatDateTime(state.updated_at, timeZone)}</Row>
      <Row label="Limits">
        {plural(state.max_agent_steps, "turn")}, {plural(state.max_tool_calls, "tool call")}
      </Row>
      <Row label="Approvals">
        {state.approvals.length === 0
          ? "None"
          : state.approvals.map((approval) => approvalStatusMeta(approval.status).label).join(", ")}
      </Row>
      <Row label="Events applied">
        <span className="tabular-nums">
          {plural(state.events.length, "event")}, cursor {state.cursor}
        </span>
      </Row>
    </dl>
  );
}
