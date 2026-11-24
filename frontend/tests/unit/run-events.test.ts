import test from "node:test";
import assert from "node:assert/strict";
import { createInitialRunState, reduceRunEvent } from "../../src/lib/run-events.ts";
import type { RunEvent, RunSnapshot } from "../../src/lib/api.ts";

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
