import assert from "node:assert/strict";
import test from "node:test";
import { describeActivity } from "../../src/lib/activity.ts";
import { createInitialRunState, reduceRunEvent, reduceRunState, type RunState } from "../../src/lib/run-events.ts";
import type { RunEvent } from "../../src/lib/api.ts";
import { approvalScenario, draftScenario, ev, QUEUED_SNAPSHOT } from "./fixtures/scenarios.ts";

function at(events: RunEvent[], lastSequence: number): RunState {
  return events.filter((e) => e.sequence <= lastSequence).reduce(reduceRunEvent, createInitialRunState(QUEUED_SNAPSHOT));
}

test("queued runs wait for the worker", () => {
  assert.deepEqual(describeActivity(createInitialRunState(QUEUED_SNAPSHOT)), {
    text: "Queued. Waiting for the worker to start this run…",
    tone: "neutral",
    live: true,
  });
});

test("the now line follows the tool lifecycle", () => {
  const { events } = draftScenario();
  assert.equal(describeActivity(at(events, 2)).text, "Waiting for the model (turn 1 of 20)…");
  assert.equal(describeActivity(at(events, 3)).text, "Preparing date_math…");
  assert.equal(describeActivity(at(events, 6)).text, "Calling date_math…");
  assert.equal(describeActivity(at(events, 7)).text, "Waiting for the model (turn 2 of 20)…");
  assert.equal(describeActivity(at(events, 18)).text, "Writing a response…");
  assert.deepEqual(describeActivity(at(events, 21)), { text: "Completed in 4 turns and 3 tool calls.", tone: "success", live: false });
});

test("approval waits name the amount and the order, then the decision resumes the run", () => {
  const { events } = approvalScenario();
  assert.deepEqual(describeActivity(at(events, 17)), {
    text: "Waiting for your approval: $84.51 USD refund for ORD-1006.",
    tone: "warning",
    live: true,
  });
  assert.equal(describeActivity(at(events, 19)).text, "Your decision is recorded. Resuming the run…");
  assert.equal(describeActivity(at(events, 20)).text, "Applying your decision to issue_refund…");
});

test("stopping, failure and cancellation read plainly", () => {
  const running = reduceRunEvent(createInitialRunState(QUEUED_SNAPSHOT), ev(2, "run.started", {}));
  const stopping = reduceRunState(running, { type: "stop-accepted" });
  const failed = reduceRunEvent(running, ev(3, "run.failed", { code: "MODEL_TIMEOUT", message: "The model turn timed out." }));
  const cancelled = reduceRunEvent(stopping, ev(3, "run.cancelled", {}));

  assert.equal(describeActivity(stopping).text, "Stopping… the agent halts at its next checkpoint.");
  assert.deepEqual(describeActivity(failed), { text: "Failed: Model timed out.", tone: "danger", live: false });
  assert.equal(describeActivity(cancelled).live, false);
});

test("several running calls are listed together", () => {
  const state = [
    ev(2, "run.started", {}),
    ev(3, "tool.requested", { tool_call_id: "a", name: "query_orders", arguments: {} }),
    ev(4, "tool.requested", { tool_call_id: "b", name: "search_policies", arguments: {} }),
    ev(5, "tool.requested", { tool_call_id: "c", name: "date_math", arguments: {} }),
    ev(6, "message.completed", { message_id: "m1", text: null }),
    ev(7, "tool.started", { tool_call_id: "a" }),
    ev(8, "tool.started", { tool_call_id: "b" }),
    ev(9, "tool.started", { tool_call_id: "c" }),
  ].reduce(reduceRunEvent, createInitialRunState(QUEUED_SNAPSHOT));
  assert.equal(describeActivity(state).text, "Calling query_orders, search_policies and date_math…");
});
