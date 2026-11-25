import test from "node:test";
import assert from "node:assert/strict";
import { createInitialRunState, reduceRunEvent, reduceRunState, type RunState } from "../../src/lib/run-events.ts";
import type { RunEvent, RunSnapshot } from "../../src/lib/api.ts";
import { approvalScenario, draftScenario, ev, message, QUEUED_SNAPSHOT } from "./fixtures/scenarios.ts";

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
  assert.deepEqual(state.events.map((event) => event.sequence), [1]);
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
// Live trace vs replayed trace. The backend commits a turn's `tool.requested`
// BEFORE that turn's `message.completed`, and `tool.requested` has no message_id.
// The snapshot groups calls by message_id on the server; live state must agree.
// ---------------------------------------------------------------------------

/** Assistant turns in order, each with the IDs of the tool calls it requested. */
function turnStructure(state: RunState): { id: string; calls: string[] }[] {
  return state.messages.filter((m) => m.role === "assistant").map((m) => ({ id: m.id, calls: m.tool_call_ids }));
}

function replay(initial: RunSnapshot, events: RunEvent[]): RunState {
  return events.reduce((state, event) => reduceRunEvent(state, event), createInitialRunState(initial));
}

test("live tool-only turns attach each call to the turn that requested it, like the replay", () => {
  const { events, final } = draftScenario();

  const live = replay(QUEUED_SNAPSHOT, events);
  const replayed = createInitialRunState(final);

  assert.deepEqual(turnStructure(live), [
    { id: "m1", calls: ["call-date"] },
    { id: "m2", calls: ["call-query"] },
    { id: "m3", calls: ["call-policy"] },
    { id: "m4", calls: [] },
  ]);
  assert.deepEqual(turnStructure(live), turnStructure(replayed));
  assert.equal(live.step_count, replayed.step_count);
  assert.equal(live.tool_call_count, replayed.tool_call_count);
});

test("a requested call waits for its own turn instead of joining the previous message", () => {
  const { events } = draftScenario();
  const midTurn = replay(QUEUED_SNAPSHOT, events.filter((e) => e.sequence <= 8));

  assert.deepEqual(turnStructure(midTurn), [{ id: "m1", calls: ["call-date"] }]);
  assert.deepEqual(midTurn.pending_tool_call_ids, ["call-query"]);
  assert.equal(midTurn.tool_calls.find((c) => c.id === "call-query")?.status, "requested");
});

test("a turn with text and tool calls keeps both on the same message", () => {
  const live = replay(QUEUED_SNAPSHOT, [
    ev(2, "run.started", { status: "running" }),
    ev(3, "message.delta", { message_id: "m1", delta: "Let me check the orders." }),
    ev(4, "tool.requested", { tool_call_id: "c1", provider_call_id: "p1", name: "query_orders", arguments: {} }),
    ev(5, "tool.requested", { tool_call_id: "c2", provider_call_id: "p2", name: "search_policies", arguments: {} }),
    ev(6, "usage.updated", { total_tokens: 10 }),
    ev(7, "message.completed", { message_id: "m1", status: "completed", text: "Let me check the orders." }),
  ]);

  assert.deepEqual(turnStructure(live), [{ id: "m1", calls: ["c1", "c2"] }]);
  assert.deepEqual(live.pending_tool_call_ids, []);
  assert.equal(live.messages.find((m) => m.id === "m1")?.status, "completed");
});

test("the approval flow replays with the same turns and decision as the snapshot", () => {
  const { events, final } = approvalScenario();

  const live = replay(QUEUED_SNAPSHOT, events);
  const replayed = createInitialRunState(final);

  assert.deepEqual(turnStructure(live), turnStructure(replayed));
  assert.deepEqual(live.approvals.map((a) => [a.id, a.status]), replayed.approvals.map((a) => [a.id, a.status]));
  assert.equal(live.pending_approval, null);
  assert.equal(live.step_count, replayed.step_count);
  assert.equal(live.tool_call_count, replayed.tool_call_count);
});

test("approval.required pauses the run and marks the refund call as awaiting approval", () => {
  const { events } = approvalScenario();
  const paused = replay(QUEUED_SNAPSHOT, events.filter((e) => e.sequence <= 17));

  assert.equal(paused.status, "awaiting_approval");
  assert.equal(paused.pending_approval?.id, "app-1");
  assert.equal(paused.tool_calls.find((c) => c.id === "call-refund")?.status, "awaiting_approval");
});

test("a snapshot taken mid-turn is not counted twice when the turn completes", () => {
  // start_turn commits step_count + 1 and the assistant message without emitting an event.
  const midTurn: RunSnapshot = {
    ...QUEUED_SNAPSHOT,
    status: "running",
    step_count: 1,
    messages: [QUEUED_SNAPSHOT.messages[0], message("m1", 1, "assistant", "Checking")],
    events: [...QUEUED_SNAPSHOT.events, ev(2, "run.started", {}), ev(3, "message.delta", { message_id: "m1", delta: "Checking" })],
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

// ---------------------------------------------------------------------------
// State details the UI relies on
// ---------------------------------------------------------------------------

test("a delta replaces only its own message object, so other turns keep their identity", () => {
  const { events } = draftScenario();
  const before = replay(QUEUED_SNAPSHOT, events.filter((e) => e.sequence <= 18));
  const after = reduceRunEvent(before, ev(19, "usage.updated", { total_tokens: 1 }));
  const streamed = reduceRunEvent(
    createInitialRunState({ ...QUEUED_SNAPSHOT, status: "running" }),
    ev(2, "message.delta", { message_id: "m1", delta: "Hel" }),
  );
  const more = reduceRunEvent(streamed, ev(3, "message.delta", { message_id: "m1", delta: "lo" }));

  assert.equal(after.messages[1], before.messages[1]);
  assert.equal(after.tool_calls, before.tool_calls);
  assert.equal(more.messages[0], streamed.messages[0]); // the user's goal message
  assert.notEqual(more.messages[1], streamed.messages[1]);
  assert.equal(more.messages[1].text, "Hello");
  assert.equal(more.messages[1].status, "streaming");
});

test("the event log grows with each applied event", () => {
  const { events } = draftScenario();
  const live = replay(QUEUED_SNAPSHOT, events.slice(0, 3));
  assert.deepEqual(live.events.map((e) => e.sequence), [1, 2, 3, 4]);
});

test("unknown event types still advance the cursor", () => {
  const state = createInitialRunState(QUEUED_SNAPSHOT);
  const next = reduceRunEvent(state, { ...ev(2, "run.started", {}), type: "run.paused" as RunEvent["type"] });
  assert.equal(next.cursor, 2);
  assert.equal(next.status, "queued");
});

test("active time runs only while the run is running", () => {
  const { events } = approvalScenario();
  // run.started at +2 s, approval.required at +17 s, run.started at +20 s, run.completed at +25 s.
  const paused = replay(QUEUED_SNAPSHOT, events.filter((e) => e.sequence <= 17));
  const resumed = replay(QUEUED_SNAPSHOT, events.filter((e) => e.sequence <= 20));
  const finished = replay(QUEUED_SNAPSHOT, events);

  assert.equal(paused.active_since, null);
  assert.equal(paused.active_elapsed_ms, 15_000);
  assert.equal(resumed.active_since, "2026-02-15T12:00:20.000Z");
  assert.equal(finished.active_since, null);
  assert.equal(finished.active_elapsed_ms, 20_000);
});

test("a running snapshot starts the stopwatch at the server's last checkpoint", () => {
  const state = createInitialRunState({ ...QUEUED_SNAPSHOT, status: "running", active_elapsed_ms: 4200, updated_at: "2026-02-15T12:00:09Z" });
  assert.equal(state.active_elapsed_ms, 4200);
  assert.equal(state.active_since, "2026-02-15T12:00:09Z");
});

test("an older snapshot never rolls back newer streamed state", () => {
  const { events, final } = draftScenario();
  const live = replay(QUEUED_SNAPSHOT, events);
  const stale = reduceRunState(live, { type: "snapshot", snapshot: QUEUED_SNAPSHOT });
  const fresh = reduceRunState(live, { type: "snapshot", snapshot: { ...final, model_calls: [] } });

  assert.equal(stale, live);
  assert.notEqual(fresh, live);
  assert.equal(fresh.cursor, 21);
});

test("an accepted stop shows cancelling until run.cancelled arrives, and never revives a finished run", () => {
  const running = reduceRunEvent(createInitialRunState(QUEUED_SNAPSHOT), ev(2, "run.started", {}));
  const stopping = reduceRunState(running, { type: "stop-accepted" });
  const cancelled = reduceRunEvent(stopping, ev(3, "run.cancelled", { status: "cancelled", code: "CANCELLED" }));
  const completed = replay(QUEUED_SNAPSHOT, draftScenario().events);

  assert.equal(stopping.status, "cancelling");
  assert.equal(stopping.active_since, running.active_since);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(reduceRunState(completed, { type: "stop-accepted" }), completed);
});

test("stopping a paused run does not count the approval wait as active time", () => {
  const { events } = approvalScenario();
  const paused = replay(QUEUED_SNAPSHOT, events.filter((e) => e.sequence <= 17));
  const stopping = reduceRunState(paused, { type: "stop-accepted" });
  const cancelled = reduceRunEvent(stopping, ev(18, "run.cancelled", { status: "cancelled" }));

  assert.equal(cancelled.active_elapsed_ms, paused.active_elapsed_ms);
});

test("a rejected approval fails the refund call with the reviewer's reason", () => {
  const { events } = approvalScenario();
  const paused = replay(QUEUED_SNAPSHOT, events.filter((e) => e.sequence <= 17));
  const rejected = [
    ev(18, "approval.decided", { approval_id: "app-1", tool_call_id: "call-refund", status: "rejected", reason: "Store credit instead" }),
    ev(19, "run.queued", {}),
    ev(20, "run.started", {}),
    ev(21, "tool.failed", {
      tool_call_id: "call-refund",
      name: "issue_refund",
      code: "APPROVAL_REJECTED",
      message: "Store credit instead",
      result: { ok: false, error: { code: "APPROVAL_REJECTED", message: "Store credit instead" } },
    }),
  ].reduce(reduceRunEvent, paused);

  const call = rejected.tool_calls.find((c) => c.id === "call-refund");
  assert.equal(call?.status, "failed");
  assert.equal(call?.error, "Store credit instead");
  assert.deepEqual(call?.result, { ok: false, error: { code: "APPROVAL_REJECTED", message: "Store credit instead" } });
  assert.equal(rejected.approvals[0].reason, "Store credit instead");
  assert.equal(rejected.approvals[0].decided_at, "2026-02-15T12:00:18.000Z");
});

test("usage updates carry token completeness and the decimal cost string", () => {
  const state = reduceRunEvent(
    createInitialRunState(QUEUED_SNAPSHOT),
    ev(2, "usage.updated", { total_tokens: 512, token_usage_complete: false, cost_is_upper_bound: true, estimated_cost_usd: "0.0012345" }),
  );
  assert.equal(state.total_tokens, 512);
  assert.equal(state.token_usage_complete, false);
  assert.equal(state.cost_is_upper_bound, true);
  assert.equal(state.estimated_cost_usd, "0.0012345");
});

test("a failed run keeps the error code for a readable title", () => {
  const state = reduceRunEvent(
    createInitialRunState(QUEUED_SNAPSHOT),
    ev(2, "run.failed", { status: "failed", code: "MODEL_TIMEOUT", message: "The model turn timed out." }),
  );
  assert.equal(state.status, "failed");
  assert.equal(state.error_code, "MODEL_TIMEOUT");
  assert.equal(state.error, "The model turn timed out.");
});
