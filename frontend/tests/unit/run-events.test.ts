import test from "node:test";
import assert from "node:assert/strict";
import { createInitialRunState, reduceRunEvent, type RunState } from "../../src/lib/run-events.ts";
import type { MessageSnapshot, RunEvent, RunSnapshot, ToolCallSnapshot } from "../../src/lib/api.ts";

const MOCK_SNAPSHOT: RunSnapshot = {
  id: "run-123",
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
    {
      id: "msg-user-1",
      index: 0,
      role: "user",
      text: "Test operations goal",
      tool_calls: [],
      created_at: "2026-11-22T12:00:00Z",
    },
  ],
  approvals: [],
  events: [
    {
      schema_version: 1,
      run_id: "run-123",
      sequence: 1,
      type: "run.queued",
      occurred_at: "2026-11-22T12:00:00Z",
      payload: {},
    },
  ],
  snapshot_cursor: 1,
  created_at: "2026-11-22T12:00:00Z",
  updated_at: "2026-11-22T12:00:00Z",
};

test("createInitialRunState initializes state and cursor from snapshot", () => {
  const state = createInitialRunState(MOCK_SNAPSHOT);
  assert.equal(state.id, "run-123");
  assert.equal(state.cursor, 1);
  assert.equal(state.status, "queued");
  assert.deepEqual(state.seen_sequences, [1]);
  assert.equal(state.has_sequence_gap, false);
});

test("reduceRunEvent ignores duplicate sequence or sequence <= cursor", () => {
  const state = createInitialRunState(MOCK_SNAPSHOT);

  const duplicateEvent: RunEvent = {
    schema_version: 1,
    run_id: "run-123",
    sequence: 1,
    type: "run.queued",
    occurred_at: "2026-11-22T12:00:01Z",
    payload: {},
  };

  const nextState = reduceRunEvent(state, duplicateEvent);
  assert.equal(nextState, state);
  assert.equal(nextState.cursor, 1);
});

test("reduceRunEvent detects sequence gaps", () => {
  const state = createInitialRunState(MOCK_SNAPSHOT); // cursor = 1

  // Event sequence jumps from 1 to 3
  const gapEvent: RunEvent = {
    schema_version: 1,
    run_id: "run-123",
    sequence: 3,
    type: "message.delta",
    occurred_at: "2026-11-22T12:00:02Z",
    payload: { message_id: "msg-asst-1", delta: "Hello" },
  };

  const nextState = reduceRunEvent(state, gapEvent);
  assert.equal(nextState.has_sequence_gap, true);
  assert.equal(nextState.cursor, 1);
  assert.equal(nextState.messages.some((message) => message.id === "msg-asst-1"), false);
});

test("reduceRunEvent accumulates text deltas into assistant messages", () => {
  let state = createInitialRunState(MOCK_SNAPSHOT);

  const delta1: RunEvent = {
    schema_version: 1,
    run_id: "run-123",
    sequence: 2,
    type: "message.delta",
    occurred_at: "2026-11-22T12:00:01Z",
    payload: { message_id: "msg-asst-1", delta: "Finding " },
  };

  const delta2: RunEvent = {
    schema_version: 1,
    run_id: "run-123",
    sequence: 3,
    type: "message.delta",
    occurred_at: "2026-11-22T12:00:02Z",
    payload: { message_id: "msg-asst-1", delta: "late orders..." },
  };

  state = reduceRunEvent(state, delta1);
  state = reduceRunEvent(state, delta2);

  const asstMsg = state.messages.find((m) => m.id === "msg-asst-1");
  assert.ok(asstMsg);
  assert.equal(asstMsg.text, "Finding late orders...");
});

test("reduceRunEvent tracks tool call lifecycle: requested -> started -> completed", () => {
  let state = createInitialRunState(MOCK_SNAPSHOT);

  const reqEvent: RunEvent = {
    schema_version: 1,
    run_id: "run-123",
    sequence: 2,
    type: "tool.requested",
    occurred_at: "2026-11-22T12:00:01Z",
    payload: {
      tool_call_id: "call-1",
      provider_call_id: "pcall-1",
      name: "query_orders",
      arguments: { status: "shipped" },
    },
  };

  const startEvent: RunEvent = {
    schema_version: 1,
    run_id: "run-123",
    sequence: 3,
    type: "tool.started",
    occurred_at: "2026-11-22T12:00:02Z",
    payload: { tool_call_id: "call-1", name: "query_orders" },
  };

  const compEvent: RunEvent = {
    schema_version: 1,
    run_id: "run-123",
    sequence: 4,
    type: "tool.completed",
    occurred_at: "2026-11-22T12:00:03Z",
    payload: {
      tool_call_id: "call-1",
      name: "query_orders",
      result: { ok: true, data: [{ id: "ORD-1" }] },
    },
  };

  state = reduceRunEvent(state, reqEvent);
  state = reduceRunEvent(state, startEvent);
  state = reduceRunEvent(state, compEvent);

  const call = state.tool_calls.find((c) => c.id === "call-1");
  assert.ok(call);
  assert.equal(call.status, "completed");
  assert.deepEqual(call.arguments, { status: "shipped" });
  assert.deepEqual(call.result, { ok: true, data: [{ id: "ORD-1" }] });
});

test("reduceRunEvent handles approval.required and approval.decided", () => {
  let state = createInitialRunState(MOCK_SNAPSHOT);

  const appReq: RunEvent = {
    schema_version: 1,
    run_id: "run-123",
    sequence: 2,
    type: "approval.required",
    occurred_at: "2026-11-22T12:00:01Z",
    payload: {
      approval_id: "app-1",
      tool_call_id: "call-refund-1",
      tool_name: "issue_refund",
      proposed_arguments: { order_id: "ORD-99", amount_minor: 5000 },
    },
  };

  state = reduceRunEvent(state, appReq);
  assert.equal(state.status, "awaiting_approval");
  assert.ok(state.pending_approval);
  assert.equal(state.pending_approval.id, "app-1");
  assert.equal(state.pending_approval.status, "pending");

  const appDec: RunEvent = {
    schema_version: 1,
    run_id: "run-123",
    sequence: 3,
    type: "approval.decided",
    occurred_at: "2026-11-22T12:00:02Z",
    payload: {
      approval_id: "app-1",
      tool_call_id: "call-refund-1",
      status: "approved",
      decision: "approve",
    },
  };

  state = reduceRunEvent(state, appDec);
  assert.equal(state.pending_approval, null);
  const recorded = state.approvals.find((a) => a.id === "app-1");
  assert.ok(recorded);
  assert.equal(recorded.status, "approved");
});

test("reduceRunEvent handles terminal events", () => {
  let state = createInitialRunState(MOCK_SNAPSHOT);

  const compEvent: RunEvent = {
    schema_version: 1,
    run_id: "run-123",
    sequence: 2,
    type: "run.completed",
    occurred_at: "2026-11-22T12:00:01Z",
    payload: { status: "completed" },
  };

  state = reduceRunEvent(state, compEvent);
  assert.equal(state.status, "completed");
});

test("message completion restores output even when its delta was not in the snapshot", () => {
  const state = createInitialRunState(MOCK_SNAPSHOT);
  const completed: RunEvent = {
    schema_version: 1, run_id: "run-123", sequence: 2, type: "message.completed",
    occurred_at: "2026-02-15T12:00:01Z",
    payload: { message_id: "new-message", status: "completed", text: "Final email drafts" },
  };
  const next = reduceRunEvent(state, completed);
  assert.equal(next.messages.find(message => message.id === "new-message")?.text, "Final email drafts");
});

test("the tool lifecycle does not mutate the snapshot or prior reducer state", () => {
  const initial = createInitialRunState(MOCK_SNAPSHOT);
  const requested = reduceRunEvent(initial, {
    schema_version: 1, run_id: "run-123", sequence: 2, type: "tool.requested",
    occurred_at: "2026-02-15T12:00:01Z",
    payload: { tool_call_id: "tool-1", name: "query_orders", provider_call_id: "p1", arguments: {} },
  });
  const started = reduceRunEvent(requested, {
    schema_version: 1, run_id: "run-123", sequence: 3, type: "tool.started",
    occurred_at: "2026-02-15T12:00:02Z", payload: { tool_call_id: "tool-1" },
  });
  assert.equal(requested.tool_calls[0].status, "requested");
  assert.equal(started.tool_calls[0].status, "running");
});

test("a failed persisted snapshot includes the stored failure explanation", () => {
  const snapshot: RunSnapshot = { ...MOCK_SNAPSHOT, status: "failed", snapshot_cursor: 2, events: [
    ...MOCK_SNAPSHOT.events,
    { schema_version: 1, run_id: "run-123", sequence: 2, type: "run.failed", occurred_at: "2026-02-15T12:00:01Z",
      payload: { code: "PROVIDER_CONFIGURATION_ERROR", message: "ANTHROPIC_API_KEY is missing" } },
  ] };
  assert.equal(createInitialRunState(snapshot).error, "ANTHROPIC_API_KEY is missing");
});

// ---------------------------------------------------------------------------
// Live trace vs replayed trace.
//
// The backend (backend/app/agent/loop.py) emits a turn's `tool.requested`
// events BEFORE that turn's `message.completed`, and `tool.requested` carries
// no message_id. The snapshot groups calls by message_id on the server, so the
// live reducer must arrive at the same grouping on its own.
// ---------------------------------------------------------------------------

const RUN_ID = "run-123";
const T0 = Date.parse("2026-02-15T12:00:00Z");

function ev(sequence: number, type: RunEvent["type"], payload: Record<string, unknown>): RunEvent {
  return {
    schema_version: 1,
    run_id: RUN_ID,
    sequence,
    type,
    occurred_at: new Date(T0 + sequence * 1000).toISOString(),
    payload,
  };
}

/** One tool-only model turn, in the exact order agent/loop.py commits it. */
function toolOnlyTurn(first: number, messageId: string, callId: string, name: string): RunEvent[] {
  const call = { tool_call_id: callId, provider_call_id: `p-${callId}`, name };
  return [
    ev(first, "tool.requested", { ...call, arguments: { probe: name } }),
    ev(first + 1, "usage.updated", { model_call_id: `mc-${messageId}`, total_tokens: 0, token_usage_complete: false }),
    ev(first + 2, "message.completed", { message_id: messageId, status: "completed", text: null }),
    ev(first + 3, "tool.started", call),
    ev(first + 4, "tool.completed", { ...call, result: { ok: true, data: { name } } }),
  ];
}

function snapshotCall(id: string, name: string): ToolCallSnapshot {
  return {
    id,
    provider_call_id: `p-${id}`,
    name,
    arguments: { probe: name },
    status: "completed",
    result: { ok: true, data: { name } },
  };
}

function message(id: string, index: number, role: MessageSnapshot["role"], text: string | null, calls: ToolCallSnapshot[] = []): MessageSnapshot {
  return { id, index, role, text, tool_calls: calls, created_at: "2026-02-15T12:00:00Z" };
}

/** Assistant turns in order, each with the IDs of the tool calls it requested. */
function turnStructure(state: RunState): { id: string; calls: string[] }[] {
  return state.messages
    .filter((m) => m.role === "assistant")
    .map((m) => ({ id: m.id, calls: m.tool_calls.map((c) => c.id) }));
}

function replay(initial: RunSnapshot, events: RunEvent[]): RunState {
  return events.reduce((state, event) => reduceRunEvent(state, event), createInitialRunState(initial));
}

/** The draft-only scenario (ScenarioProvider): three tool-only turns, then a text answer. */
function draftScenario(): { events: RunEvent[]; final: RunSnapshot } {
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
    ...MOCK_SNAPSHOT,
    status: "completed",
    step_count: 4,
    tool_call_count: 3,
    messages: [
      MOCK_SNAPSHOT.messages[0],
      message("m1", 1, "assistant", null, [snapshotCall("call-date", "date_math")]),
      message("t1", 2, "tool", '{"ok":true}'),
      message("m2", 3, "assistant", null, [snapshotCall("call-query", "query_orders")]),
      message("t2", 4, "tool", '{"ok":true}'),
      message("m3", 5, "assistant", null, [snapshotCall("call-policy", "search_policies")]),
      message("t3", 6, "tool", '{"ok":true}'),
      message("m4", 7, "assistant", "Here are the drafts."),
    ],
    events: [...MOCK_SNAPSHOT.events, ...events],
    snapshot_cursor: 21,
  };
  return { events, final };
}

test("live tool-only turns attach each call to the turn that requested it, like the replay", () => {
  const { events, final } = draftScenario();

  const live = replay(MOCK_SNAPSHOT, events);
  const replayed = createInitialRunState(final);

  assert.deepEqual(turnStructure(live), [
    { id: "m1", calls: ["call-date"] },
    { id: "m2", calls: ["call-query"] },
    { id: "m3", calls: ["call-policy"] },
    { id: "m4", calls: [] },
  ]);
  assert.deepEqual(turnStructure(live), turnStructure(replayed));
});

test("a requested call waits for its own turn instead of joining the previous message", () => {
  const { events } = draftScenario();
  // Stop right after turn 2 requested query_orders: turn 1 is complete, turn 2 is not.
  const midTurn = replay(MOCK_SNAPSHOT, events.slice(0, events.findIndex((e) => e.sequence === 8) + 1));

  assert.deepEqual(turnStructure(midTurn), [{ id: "m1", calls: ["call-date"] }]);
  assert.deepEqual(midTurn.pending_tool_call_ids, ["call-query"]);
  assert.equal(midTurn.tool_calls.find((c) => c.id === "call-query")?.status, "requested");
});

test("a turn with text and tool calls keeps both on the same message", () => {
  const events = [
    ev(2, "run.started", { status: "running" }),
    ev(3, "message.delta", { message_id: "m1", delta: "Let me check the orders." }),
    ev(4, "tool.requested", { tool_call_id: "c1", provider_call_id: "p1", name: "query_orders", arguments: {} }),
    ev(5, "tool.requested", { tool_call_id: "c2", provider_call_id: "p2", name: "search_policies", arguments: {} }),
    ev(6, "usage.updated", { total_tokens: 10 }),
    ev(7, "message.completed", { message_id: "m1", status: "completed", text: "Let me check the orders." }),
  ];

  const live = replay(MOCK_SNAPSHOT, events);

  assert.deepEqual(turnStructure(live), [{ id: "m1", calls: ["c1", "c2"] }]);
  assert.deepEqual(live.pending_tool_call_ids, []);
});

test("the approval flow replays with the same turns and decision as the snapshot", () => {
  const refund = { tool_call_id: "call-refund", provider_call_id: "p-call-refund", name: "issue_refund" };
  const proposal = { order_id: "ORD-1006", amount_minor: 8451, currency: "USD" };
  const events = [
    ev(2, "run.started", { status: "running" }),
    ...toolOnlyTurn(3, "m1", "call-query", "query_orders"),
    ...toolOnlyTurn(8, "m2", "call-policy", "search_policies"),
    ev(13, "tool.requested", { ...refund, arguments: { order_id: "ORD-1006", reason: "Late" } }),
    ev(14, "usage.updated", { total_tokens: 0 }),
    ev(15, "message.completed", { message_id: "m3", status: "completed", text: null }),
    ev(16, "tool.started", refund),
    ev(17, "approval.required", { approval_id: "app-1", tool_call_id: "call-refund", tool_name: "issue_refund", proposed_arguments: proposal, status: "pending" }),
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
    ...MOCK_SNAPSHOT,
    status: "completed",
    step_count: 4,
    tool_call_count: 3,
    messages: [
      MOCK_SNAPSHOT.messages[0],
      message("m1", 1, "assistant", null, [snapshotCall("call-query", "query_orders")]),
      message("t1", 2, "tool", '{"ok":true}'),
      message("m2", 3, "assistant", null, [snapshotCall("call-policy", "search_policies")]),
      message("t2", 4, "tool", '{"ok":true}'),
      message("m3", 5, "assistant", null, [refundCall]),
      message("t3", 6, "tool", '{"ok":true}'),
      message("m4", 7, "assistant", "Refund recorded."),
    ],
    approvals: [{ id: "app-1", tool_call_id: "call-refund", tool_name: "issue_refund", proposed_arguments: proposal, status: "approved", reason: null, decided_at: "2026-02-15T12:00:18Z" }],
    events: [...MOCK_SNAPSHOT.events, ...events],
    snapshot_cursor: 25,
  };

  const live = replay(MOCK_SNAPSHOT, events);
  const replayed = createInitialRunState(final);

  assert.deepEqual(turnStructure(live), turnStructure(replayed));
  assert.deepEqual(live.approvals.map((a) => [a.id, a.status]), replayed.approvals.map((a) => [a.id, a.status]));
  assert.equal(live.pending_approval, null);
  assert.equal(live.step_count, replayed.step_count);
  assert.equal(live.tool_call_count, replayed.tool_call_count);
});

test("a snapshot taken mid-turn is not counted twice when the turn completes", () => {
  // start_turn commits step_count + 1 and the assistant message without emitting an event,
  // so a snapshot taken during the turn already counts it.
  const midTurn: RunSnapshot = {
    ...MOCK_SNAPSHOT,
    status: "running",
    step_count: 1,
    messages: [MOCK_SNAPSHOT.messages[0], message("m1", 1, "assistant", "Checking")],
    events: [...MOCK_SNAPSHOT.events, ev(2, "run.started", {}), ev(3, "message.delta", { message_id: "m1", delta: "Checking" })],
    snapshot_cursor: 3,
  };

  const completed = reduceRunEvent(
    createInitialRunState(midTurn),
    ev(4, "message.completed", { message_id: "m1", status: "completed", text: "Checking orders." }),
  );
  const nextTurn = reduceRunEvent(completed, ev(5, "message.delta", { message_id: "m2", delta: "Done" }));

  assert.equal(completed.step_count, 1);
  assert.equal(nextTurn.step_count, 2);
});
