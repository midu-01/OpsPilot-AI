import assert from "node:assert/strict";
import test from "node:test";
import { approvalForCall, consequenceLine, parseRefundProposal, proposalTitle } from "../../src/lib/approval.ts";

// The proposal refunds.propose() stores for the ORD-1006 demo.
const PROPOSAL = {
  order_id: "ORD-1006",
  reason: "Review the late shipment under policy v1",
  policy_version: "v1",
  amount_minor: 8451,
  currency: "USD",
  evidence: {
    order_id: "ORD-1006",
    status: "shipped",
    customer_name: "Demo Customer 06",
    customer_email: "customer06@example.test",
    order_amount_minor: 84505,
    currency: "USD",
    shipped_at: "2026-01-06T12:00:00+00:00",
    promised_ship_at: "2026-01-03T12:00:00+00:00",
    prior_refunds_minor: 0,
    remaining_balance_minor: 84505,
    eligible: true,
    refund_amount_minor: 8451,
    policy_ids: ["SHIP-01", "LATE-01", "AMOUNT-01"],
  },
};

test("a refund proposal reads the arguments and the frozen evidence", () => {
  const proposal = parseRefundProposal(PROPOSAL);
  assert.equal(proposal.orderId, "ORD-1006");
  assert.equal(proposal.amountMinor, 8451);
  assert.equal(proposal.customerName, "Demo Customer 06");
  assert.equal(proposal.orderAmountMinor, 84505);
  assert.equal(proposal.remainingBalanceMinor, 84505);
  assert.deepEqual(proposal.policyIds, ["SHIP-01", "LATE-01", "AMOUNT-01"]);
});

test("the title and the consequence line state the exact amount", () => {
  const proposal = parseRefundProposal(PROPOSAL);
  assert.equal(proposalTitle(proposal), "$84.51 USD refund for ORD-1006");
  assert.equal(consequenceLine(proposal), "Approving records a simulated $84.51 USD refund for ORD-1006. No money moves.");
});

test("missing fields degrade to readable text", () => {
  const proposal = parseRefundProposal({});
  assert.equal(proposal.currency, "USD");
  assert.deepEqual(proposal.policyIds, []);
  assert.equal(proposalTitle(proposal), "Refund for this order");
  assert.equal(consequenceLine(proposal), "Approving records a simulated refund for this order. No money moves.");
});

test("the latest approval for a call is found by tool call id", () => {
  const first = { id: "a1", tool_call_id: "c1", tool_name: "issue_refund", proposed_arguments: {}, status: "rejected" as const };
  const second = { ...first, id: "a2", status: "approved" as const };
  assert.equal(approvalForCall([first, second], "c1")?.id, "a2");
  assert.equal(approvalForCall([first], "c9"), undefined);
});
