"use client";

import { useRef, useState, type ReactNode } from "react";
import { Check, Info, X } from "lucide-react";
import { ApiError, decideApproval, type ApprovalDecision, type ApprovalSnapshot } from "@/lib/api";
import { consequenceLine, parseRefundProposal } from "@/lib/approval";
import { formatDate, formatMoneyMinor, formatMoneyWithCode, lateness } from "@/lib/format";
import { redirectIfUnauthorized } from "@/lib/login-redirect";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RejectForm } from "./reject-form";

interface ApprovalCardProps {
  runId: string;
  approval: ApprovalSnapshot;
  timeZone: string;
  /** Called after the backend accepted the decision. */
  onDecided: (approvalId: string) => void;
  /** Called on 409: someone already decided, or the run stopped waiting. */
  onConflict: (detail: string) => void;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-fg">{children}</dd>
    </div>
  );
}

/**
 * The pending refund proposal. It comes from snapshot.pending_approval, so it is
 * still here after a page refresh. Once decided, approval.decided removes it and a
 * decision record takes its place in the trace.
 */
export function ApprovalCard({ runId, approval, timeZone, onDecided, onConflict }: ApprovalCardProps) {
  const proposal = parseRefundProposal(approval.proposed_arguments);
  const [submitting, setSubmitting] = useState<ApprovalDecision | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false); // blocks a second click before React re-renders
  const approveButton = useRef<HTMLButtonElement>(null);
  const rejectButton = useRef<HTMLButtonElement>(null);
  const late = lateness(proposal.promisedShipAt, proposal.shippedAt);
  const money = (minor: number | null) => (minor === null ? "—" : formatMoneyMinor(minor, proposal.currency));

  async function decide(decision: ApprovalDecision, reason?: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(decision);
    setError(null);
    try {
      await decideApproval(runId, approval.id, decision, reason ?? null);
      onDecided(approval.id); // stays busy until approval.decided replaces this card
    } catch (caught) {
      if (redirectIfUnauthorized(caught)) return; // the decision was not sent; it is still pending after sign-in
      inFlight.current = false;
      setSubmitting(null);
      (decision === "approve" ? approveButton : rejectButton).current?.focus();
      if (caught instanceof ApiError && caught.status === 409) {
        onConflict(caught.detail ?? "The approval is no longer pending.");
      } else if (caught instanceof ApiError && caught.status !== 0) {
        setError(caught.detail ?? caught.message);
      } else {
        setError("Your decision was not sent. Check that the backend is running, then try again.");
      }
    }
  }

  function cancelReject() {
    setRejecting(false);
    rejectButton.current?.focus();
  }

  return (
    <div className="overflow-hidden rounded-xl border border-warning-border bg-surface shadow-md">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-warning-border bg-warning-soft px-4 py-3">
        <div>
          <p className="text-xs font-medium text-warning">Proposed refund</p>
          <p className="text-2xl font-semibold tracking-tight text-fg tabular-nums">
            {proposal.amountMinor === null ? "—" : formatMoneyWithCode(proposal.amountMinor, proposal.currency)}
          </p>
        </div>
        <Badge tone="neutral">Simulated ledger</Badge>
      </div>

      <dl className="grid gap-x-6 gap-y-3 px-4 py-4 sm:grid-cols-2">
        <Field label="Order">
          <span className="font-mono font-medium">{proposal.orderId ?? "—"}</span>
          {proposal.orderStatus ? <span className="text-muted"> · {proposal.orderStatus.replaceAll("_", " ")}</span> : null}
        </Field>
        <Field label="Customer">
          {proposal.customerName ?? "—"}
          {proposal.customerEmail ? <span className="block text-ui text-muted">{proposal.customerEmail}</span> : null}
        </Field>
        <Field label="Order total">
          <span className="tabular-nums">{money(proposal.orderAmountMinor)}</span>
        </Field>
        <Field label="Promised → shipped">
          <span className="tabular-nums">
            {proposal.promisedShipAt ? formatDate(proposal.promisedShipAt, timeZone) : "—"} →{" "}
            {proposal.shippedAt ? formatDate(proposal.shippedAt, timeZone) : "not shipped"}
          </span>
          <span className="ml-2 align-middle">
            <Badge tone={late.days ? "warning" : "neutral"}>{late.label}</Badge>
          </span>
        </Field>
        <Field label="Prior refunds">
          <span className="tabular-nums">{money(proposal.priorRefundsMinor)}</span>
        </Field>
        <Field label="Remaining balance">
          <span className="tabular-nums">{money(proposal.remainingBalanceMinor)}</span>
        </Field>
        <Field label={`Cited policies${proposal.policyVersion ? ` (${proposal.policyVersion})` : ""}`}>
          {proposal.policyIds.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {proposal.policyIds.map((id) => (
                <span key={id} className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-xs font-medium text-link">
                  {id}
                </span>
              ))}
            </span>
          ) : (
            "—"
          )}
        </Field>
        <Field label="Agent's reason">{proposal.reason ? <q>{proposal.reason}</q> : "—"}</Field>
      </dl>

      <div className="space-y-3 border-t border-border px-4 py-4">
        <p className="flex gap-2 text-sm text-fg">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info" />
          {consequenceLine(proposal)}
        </p>
        {error ? <Alert tone="danger" role="alert" title={error} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button ref={approveButton} variant="primary" onClick={() => decide("approve")} aria-disabled={submitting !== null}>
            <Check aria-hidden />
            {submitting === "approve" ? "Approving…" : "Approve refund"}
          </Button>
          <Button
            ref={rejectButton}
            variant="danger-outline"
            onClick={() => setRejecting(true)}
            aria-disabled={submitting !== null}
            aria-expanded={rejecting}
          >
            <X aria-hidden />
            Reject…
          </Button>
        </div>
        {rejecting ? (
          <RejectForm
            busy={submitting !== null}
            rejecting={submitting === "reject"}
            onSubmit={(reason) => decide("reject", reason)}
            onCancel={cancelReject}
          />
        ) : null}
      </div>
    </div>
  );
}
