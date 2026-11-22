"use client";

import { useState } from "react";
import { type ApprovalSnapshot, decideApproval, ApiError } from "../lib/api";

interface ApprovalCardProps {
  approval: ApprovalSnapshot;
  runId: string;
  onDecisionSubmitted?: () => Promise<void> | void;
  disabled?: boolean;
}

export default function ApprovalCard({
  approval,
  runId,
  onDecisionSubmitted,
  disabled = false,
}: ApprovalCardProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const args = approval.proposed_arguments ?? {};
  const orderId = String(args.order_id ?? "Unknown");
  const amountMinor = typeof args.amount_minor === "number" ? args.amount_minor : 0;
  const currency = String(args.currency ?? "USD");
  const formattedAmount = `$${(amountMinor / 100).toFixed(2)} ${currency}`;
  const reason = String(args.reason ?? "Late shipment policy refund");
  const policyVersion = String(args.policy_version ?? "Shipping Policy v1");

  async function handleApprove() {
    setError(null);
    setIsSubmitting(true);
    try {
      await decideApproval(runId, approval.id, "approve", null);
      await onDecisionSubmitted?.();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("This proposal has already been decided or the run is no longer waiting for approval.");
      } else {
        setError(err instanceof Error ? err.message : "Failed to submit approval");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleReject(e: React.FormEvent) {
    e.preventDefault();
    if (!rejectionReason.trim()) {
      setError("A non-blank reason is required to reject a refund proposal.");
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      await decideApproval(runId, approval.id, "reject", rejectionReason.trim());
      await onDecisionSubmitted?.();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("This proposal has already been decided or the run is no longer waiting for approval.");
      } else {
        setError(err instanceof Error ? err.message : "Failed to submit rejection");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="approval-card" aria-labelledby={`approval-title-${approval.id}`}>
      <div className="approval-banner">
        <div>
          <span className="badge badge-awaiting_approval" style={{ marginRight: "10px" }}>
            Action Required
          </span>
          <span id={`approval-title-${approval.id}`} className="approval-title">
            Human Approval Required for Refund
          </span>
        </div>
        <span className="simulated-label">Simulated refund — no money will move</span>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      <div className="approval-details-grid">
        <div className="approval-detail-item">
          <div className="approval-detail-label">Order ID</div>
          <div className="approval-detail-value">{orderId}</div>
        </div>
        <div className="approval-detail-item">
          <div className="approval-detail-label">Proposed Refund</div>
          <div className="approval-detail-value">{formattedAmount}</div>
        </div>
        <div className="approval-detail-item">
          <div className="approval-detail-label">Policy Evidence</div>
          <div className="approval-detail-value">{policyVersion}</div>
        </div>
        <div className="approval-detail-item">
          <div className="approval-detail-label">Reason</div>
          <div className="approval-detail-value">{reason}</div>
        </div>
      </div>

      {!rejectMode ? (
        <div className="approval-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleApprove}
            disabled={disabled || isSubmitting}
          >
            {isSubmitting ? "Approving…" : "Approve Refund"}
          </button>
          <button
            type="button"
            className="btn btn-outline-danger"
            onClick={() => setRejectMode(true)}
            disabled={disabled || isSubmitting}
          >
            Reject Proposal…
          </button>
        </div>
      ) : (
        <form onSubmit={handleReject} className="rejection-box">
          <div className="form-group">
            <label htmlFor={`reject-reason-${approval.id}`} className="form-label">
              Reason for rejection (sent back to the agent) *
            </label>
            <textarea
              id={`reject-reason-${approval.id}`}
              className="form-textarea"
              style={{ minHeight: "80px" }}
              placeholder="e.g. Order had carrier exception, do not refund"
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              disabled={disabled || isSubmitting}
              required
            />
          </div>
          <div className="approval-actions">
            <button
              type="submit"
              className="btn btn-danger"
              disabled={disabled || isSubmitting || !rejectionReason.trim()}
            >
              {isSubmitting ? "Submitting rejection…" : "Confirm Rejection"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setRejectMode(false);
                setError(null);
              }}
              disabled={isSubmitting}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
