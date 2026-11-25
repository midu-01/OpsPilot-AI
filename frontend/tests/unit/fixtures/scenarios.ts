/**
 * Event sequences in the exact order the backend commits them (backend/app/agent/loop.py,
 * backend/app/runs/refunds.py), paired with the snapshot GET /runs/{id} returns afterwards.
 */
import type { MessageSnapshot, RunEvent, RunSnapshot, ToolCallSnapshot } from "../../../src/lib/api.ts";

export const RUN_ID = "0b4f3c52-6d1e-4c8a-9f3b-2a7d5e9c1f00";
const T0 = Date.parse("2026-02-15T12:00:00Z");

/** A queued run with only the user's goal and its run.queued event. */
export const QUEUED_SNAPSHOT: RunSnapshot = {
  id: RUN_ID,
  goal: "Test operations goal",
  status: "queued",
  provider: "groq",
  model: "gpt-oss-20b",
  reference_time: "2026-11-22T12:00:00Z",
  business_timezone: "UTC",
  step_count: 0,
  tool_call_count: 0,
  total_tokens: 0,
  active_elapsed_ms: 0,
  max_agent_steps: 20,
  max_tool_calls: 40,
  model_calls: [],
  messages: [
    { id: "msg-user-1", index: 0, role: "user", text: "Test operations goal", tool_calls: [], created_at: "2026-11-22T12:00:00Z" },
  ],
  approvals: [],
  events: [
    { schema_version: 1, run_id: RUN_ID, sequence: 1, type: "run.queued", occurred_at: "2026-11-22T12:00:00Z", payload: {} },
  ],
  snapshot_cursor: 1,
  created_at: "2026-11-22T12:00:00Z",
  updated_at: "2026-11-22T12:00:00Z",
};

/** Event `sequence` occurs `sequence` seconds after T0, so durations are easy to read in tests. */
export function ev(sequence: number, type: RunEvent["type"], payload: Record<string, unknown>): RunEvent {
  return {
    schema_version: 1,
    run_id: RUN_ID,
    sequence,
    type,
    occurred_at: new Date(T0 + sequence * 1000).toISOString(),
    payload,
  };
}

/** One tool-only model turn: the call is requested before its message completes. */
export function toolOnlyTurn(first: number, messageId: string, callId: string, name: string): RunEvent[] {
  const call = { tool_call_id: callId, provider_call_id: `p-${callId}`, name };
  return [
    ev(first, "tool.requested", { ...call, arguments: { probe: name } }),
    ev(first + 1, "usage.updated", { model_call_id: `mc-${messageId}`, total_tokens: 0, token_usage_complete: false }),
    ev(first + 2, "message.completed", { message_id: messageId, status: "completed", text: null }),
    ev(first + 3, "tool.started", call),
    ev(first + 4, "tool.completed", { ...call, result: { ok: true, data: { name } } }),
  ];
}

export function snapshotCall(id: string, name: string): ToolCallSnapshot {
  return {
    id,
    provider_call_id: `p-${id}`,
    name,
    arguments: { probe: name },
    status: "completed",
    result: { ok: true, data: { name } },
  };
}

export function message(
  id: string,
  index: number,
  role: MessageSnapshot["role"],
  text: string | null,
  calls: ToolCallSnapshot[] = [],
): MessageSnapshot {
  return { id, index, role, text, tool_calls: calls, created_at: "2026-02-15T12:00:00Z" };
}

/** Draft-only scenario (ScenarioProvider): three tool-only turns, then a text answer. */
export function draftScenario(): { events: RunEvent[]; final: RunSnapshot } {
  const events = [
    ev(2, "run.started", { status: "running" }),
    ...toolOnlyTurn(3, "m1", "call-date", "date_math"),
    ...toolOnlyTurn(8, "m2", "call-query", "query_orders"),
    ...toolOnlyTurn(13, "m3", "call-policy", "search_policies"),
    ev(18, "message.delta", { message_id: "m4", delta: "Here are the drafts." }),
    ev(19, "usage.updated", { model_call_id: "mc-m4", total_tokens: 430, token_usage_complete: false }),
    ev(20, "message.completed", { message_id: "m4", status: "completed", text: "Here are the drafts." }),
    ev(21, "run.completed", { status: "completed" }),
  ];
  const final: RunSnapshot = {
    ...QUEUED_SNAPSHOT,
    status: "completed",
    step_count: 4,
    tool_call_count: 3,
    total_tokens: 430,
    messages: [
      QUEUED_SNAPSHOT.messages[0],
      message("m1", 1, "assistant", null, [snapshotCall("call-date", "date_math")]),
      message("t1", 2, "tool", '{"ok":true}'),
      message("m2", 3, "assistant", null, [snapshotCall("call-query", "query_orders")]),
      message("t2", 4, "tool", '{"ok":true}'),
      message("m3", 5, "assistant", null, [snapshotCall("call-policy", "search_policies")]),
      message("t3", 6, "tool", '{"ok":true}'),
      message("m4", 7, "assistant", "Here are the drafts."),
    ],
    events: [...QUEUED_SNAPSHOT.events, ...events],
    snapshot_cursor: 21,
  };
  return { events, final };
}

export const REFUND_PROPOSAL = { order_id: "ORD-1006", amount_minor: 8451, currency: "USD" };

/** Approval scenario: query, policy, refund proposal, pause, approve, resume, answer. */
export function approvalScenario(): { events: RunEvent[]; final: RunSnapshot } {
  const refund = { tool_call_id: "call-refund", provider_call_id: "p-call-refund", name: "issue_refund" };
  const events = [
    ev(2, "run.started", { status: "running" }),
    ...toolOnlyTurn(3, "m1", "call-query", "query_orders"),
    ...toolOnlyTurn(8, "m2", "call-policy", "search_policies"),
    ev(13, "tool.requested", { ...refund, arguments: { order_id: "ORD-1006", reason: "Late" } }),
    ev(14, "usage.updated", { total_tokens: 0 }),
    ev(15, "message.completed", { message_id: "m3", status: "completed", text: null }),
    ev(16, "tool.started", refund),
    ev(17, "approval.required", {
      approval_id: "app-1",
      tool_call_id: "call-refund",
      tool_name: "issue_refund",
      proposed_arguments: REFUND_PROPOSAL,
      status: "pending",
    }),
    ev(18, "approval.decided", { approval_id: "app-1", tool_call_id: "call-refund", status: "approved", decision: "approve", reason: null }),
    ev(19, "run.queued", { status: "queued" }),
    ev(20, "run.started", { status: "running" }),
    ev(21, "tool.completed", { ...refund, result: { ok: true, data: { simulated: true, order_id: "ORD-1006" } } }),
    ev(22, "message.delta", { message_id: "m4", delta: "Refund recorded." }),
    ev(23, "usage.updated", { total_tokens: 265 }),
    ev(24, "message.completed", { message_id: "m4", status: "completed", text: "Refund recorded." }),
    ev(25, "run.completed", { status: "completed" }),
  ];
  const refundCall: ToolCallSnapshot = {
    id: "call-refund",
    provider_call_id: "p-call-refund",
    name: "issue_refund",
    arguments: { order_id: "ORD-1006", reason: "Late" },
    status: "completed",
    result: { ok: true, data: { simulated: true, order_id: "ORD-1006" } },
  };
  const final: RunSnapshot = {
    ...QUEUED_SNAPSHOT,
    status: "completed",
    step_count: 4,
    tool_call_count: 3,
    total_tokens: 265,
    messages: [
      QUEUED_SNAPSHOT.messages[0],
      message("m1", 1, "assistant", null, [snapshotCall("call-query", "query_orders")]),
      message("t1", 2, "tool", '{"ok":true}'),
      message("m2", 3, "assistant", null, [snapshotCall("call-policy", "search_policies")]),
      message("t2", 4, "tool", '{"ok":true}'),
      message("m3", 5, "assistant", null, [refundCall]),
      message("t3", 6, "tool", '{"ok":true}'),
      message("m4", 7, "assistant", "Refund recorded."),
    ],
    approvals: [
      {
        id: "app-1",
        tool_call_id: "call-refund",
        tool_name: "issue_refund",
        proposed_arguments: REFUND_PROPOSAL,
        status: "approved",
        reason: null,
        decided_at: "2026-02-15T12:00:18Z",
      },
    ],
    events: [...QUEUED_SNAPSHOT.events, ...events],
    snapshot_cursor: 25,
  };
  return { events, final };
}
