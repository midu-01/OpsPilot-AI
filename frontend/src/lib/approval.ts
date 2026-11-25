import type { ApprovalSnapshot } from "./api.ts";
import { formatMoneyWithCode } from "./format.ts";
import { asNumber, asRecord, asString, asStringArray } from "./json.ts";

/**
 * View model for a refund approval. `proposed_arguments` is
 * { order_id, reason, policy_version, amount_minor, currency, evidence } and
 * `evidence` is the order and ledger snapshot the backend froze with the proposal
 * (backend/app/tools/issue_refund.py, preview()).
 */
export interface RefundProposal {
  orderId: string | null;
  reason: string | null;
  policyVersion: string | null;
  amountMinor: number | null;
  currency: string;
  customerName: string | null;
  customerEmail: string | null;
  orderStatus: string | null;
  orderAmountMinor: number | null;
  priorRefundsMinor: number | null;
  remainingBalanceMinor: number | null;
  promisedShipAt: string | null;
  shippedAt: string | null;
  policyIds: string[];
}

export function parseRefundProposal(args: Record<string, unknown>): RefundProposal {
  const evidence = asRecord(args.evidence) ?? {};
  return {
    orderId: asString(args.order_id) ?? asString(evidence.order_id),
    reason: asString(args.reason) ?? asString(evidence.reason),
    policyVersion: asString(args.policy_version) ?? asString(evidence.policy_version),
    amountMinor: asNumber(args.amount_minor) ?? asNumber(evidence.refund_amount_minor),
    currency: asString(args.currency) ?? asString(evidence.currency) ?? "USD",
    customerName: asString(evidence.customer_name),
    customerEmail: asString(evidence.customer_email),
    orderStatus: asString(evidence.status),
    orderAmountMinor: asNumber(evidence.order_amount_minor),
    priorRefundsMinor: asNumber(evidence.prior_refunds_minor),
    remainingBalanceMinor: asNumber(evidence.remaining_balance_minor),
    promisedShipAt: asString(evidence.promised_ship_at),
    shippedAt: asString(evidence.shipped_at),
    policyIds: asStringArray(evidence.policy_ids),
  };
}

/** "$84.51 USD refund for ORD-1006" */
export function proposalTitle(proposal: RefundProposal): string {
  const order = proposal.orderId ?? "this order";
  if (proposal.amountMinor === null) return `Refund for ${order}`;
  return `${formatMoneyWithCode(proposal.amountMinor, proposal.currency)} refund for ${order}`;
}

/** The plain consequence of clicking Approve. */
export function consequenceLine(proposal: RefundProposal): string {
  const order = proposal.orderId ?? "this order";
  const amount = proposal.amountMinor === null ? "" : `${formatMoneyWithCode(proposal.amountMinor, proposal.currency)} `;
  return `Approving records a simulated ${amount}refund for ${order}. No money moves.`;
}

/** The approval for a tool call, if the call went through the approval gate. */
export function approvalForCall(approvals: ApprovalSnapshot[], toolCallId: string): ApprovalSnapshot | undefined {
  return approvals.findLast((approval) => approval.tool_call_id === toolCallId);
}
