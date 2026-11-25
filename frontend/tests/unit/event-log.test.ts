import assert from "node:assert/strict";
import test from "node:test";
import { summarizeEvent } from "../../src/lib/event-log.ts";
import { ev, REFUND_PROPOSAL } from "./fixtures/scenarios.ts";

test("each event type gets a short, readable summary", () => {
  assert.equal(summarizeEvent(ev(2, "message.delta", { message_id: "m", delta: "Hello there" })), "+11 chars");
  assert.equal(summarizeEvent(ev(3, "message.completed", { message_id: "m", status: "completed", text: null })), "completed, no text");
  assert.equal(summarizeEvent(ev(4, "message.completed", { message_id: "m", status: "failed", text: "Partial" })), "failed, 7 chars");
  assert.equal(summarizeEvent(ev(5, "tool.started", { name: "query_orders" })), "query_orders");
  assert.equal(summarizeEvent(ev(6, "tool.failed", { name: "issue_refund", code: "APPROVAL_REJECTED" })), "issue_refund · APPROVAL_REJECTED");
  assert.equal(
    summarizeEvent(ev(7, "approval.required", { tool_name: "issue_refund", proposed_arguments: REFUND_PROPOSAL })),
    "issue_refund · $84.51 USD · ORD-1006",
  );
  assert.equal(summarizeEvent(ev(8, "approval.decided", { status: "rejected" })), "rejected");
  assert.equal(summarizeEvent(ev(9, "usage.updated", { total_tokens: 1530, token_usage_complete: false })), "1,530 tokens (partial)");
  assert.equal(summarizeEvent(ev(10, "run.failed", { code: "MODEL_TIMEOUT" })), "MODEL_TIMEOUT");
  assert.equal(summarizeEvent(ev(11, "run.started", {})), "");
});
