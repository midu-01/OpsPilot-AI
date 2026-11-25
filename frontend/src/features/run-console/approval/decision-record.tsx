import type { ApprovalSnapshot } from "@/lib/api";
import { parseRefundProposal, proposalTitle } from "@/lib/approval";

/** What was decided about a refund proposal, shown in the trace after the decision. */
export function DecisionRecord({ approval }: { approval: ApprovalSnapshot }) {
  const title = proposalTitle(parseRefundProposal(approval.proposed_arguments));
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5 text-sm">
      <p className="font-medium text-fg">{title}</p>
      {approval.status === "approved" ? <p className="mt-1 text-muted">The run resumed with your approval.</p> : null}
      {approval.status === "rejected" ? (
        <p className="mt-1 text-muted">
          Your reason, sent to the agent: <q className="text-fg">{approval.reason ?? "No reason recorded."}</q>
        </p>
      ) : null}
      {approval.status === "cancelled" ? (
        <p className="mt-1 text-muted">{approval.reason ?? "The run was stopped"}. No refund was recorded.</p>
      ) : null}
    </div>
  );
}
