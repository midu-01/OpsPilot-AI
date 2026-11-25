import assert from "node:assert/strict";
import test from "node:test";
import { createInitialRunState, reduceRunEvent, type RunState } from "../../src/lib/run-events.ts";
import { buildTimeline, isTraceStreaming, type TimelineItem } from "../../src/lib/timeline.ts";
import type { RunEvent, RunSnapshot } from "../../src/lib/api.ts";
import { approvalScenario, draftScenario, ev, QUEUED_SNAPSHOT } from "./fixtures/scenarios.ts";

function replay(initial: RunSnapshot, events: RunEvent[]): RunState {
  return events.reduce(reduceRunEvent, createInitialRunState(initial));
}

/** The visible structure of a trace: item kinds in order, with each turn's calls. */
function shape(items: TimelineItem[]): string[] {
  return items.map((item) => {
    if (item.kind === "turn") return `${item.key}:${item.callIds.join(",")}`;
    if (item.kind === "approval") return `approval:${item.approval.id}:${item.approval.status}`;
    if (item.kind === "outcome") return `outcome:${item.status}`;
    return item.kind;
  });
}

test("the live draft trace has the same structure as its replay", () => {
  const { events, final } = draftScenario();
  const live = buildTimeline(replay(QUEUED_SNAPSHOT, events));
  const replayed = buildTimeline(createInitialRunState(final));

  assert.deepEqual(shape(live), [
    "goal",
    "turn-1:call-date",
    "turn-2:call-query",
    "turn-3:call-policy",
    "answer",
    "outcome:completed",
  ]);
  assert.deepEqual(shape(live), shape(replayed));
});

test("the live approval trace places the decision after the turn that asked for it", () => {
  const { events, final } = approvalScenario();
  const live = buildTimeline(replay(QUEUED_SNAPSHOT, events));
  const replayed = buildTimeline(createInitialRunState(final));

  assert.deepEqual(shape(live), [
    "goal",
    "turn-1:call-query",
    "turn-2:call-policy",
    "turn-3:call-refund",
    "approval:app-1:approved",
    "answer",
    "outcome:completed",
  ]);
  assert.deepEqual(shape(live), shape(replayed));
});

test("calls requested before their message completes show as the next turn, with a stable key", () => {
  const { events } = draftScenario();
  const requested = buildTimeline(replay(QUEUED_SNAPSHOT, events.filter((e) => e.sequence <= 8)));
  const completed = buildTimeline(replay(QUEUED_SNAPSHOT, events.filter((e) => e.sequence <= 10)));

  const pendingTurn = requested.find((item) => item.kind === "turn" && item.turn === 2);
  const completedTurn = completed.find((item) => item.kind === "turn" && item.turn === 2);
  assert.equal(pendingTurn?.kind === "turn" && pendingTurn.message, null);
  assert.equal(pendingTurn?.key, completedTurn?.key);
  assert.deepEqual(shape(requested), ["goal", "turn-1:call-date", "turn-2:call-query"]);
});

test("a pending approval appears right after its turn while the run waits", () => {
  const { events } = approvalScenario();
  const paused = replay(QUEUED_SNAPSHOT, events.filter((e) => e.sequence <= 17));
  assert.deepEqual(shape(buildTimeline(paused)).slice(-2), ["turn-3:call-refund", "approval:app-1:pending"]);
  assert.equal(isTraceStreaming(paused), false);
});

test("text is an answer only when the run completed; otherwise it stays a turn", () => {
  const { events } = draftScenario();
  const streaming = replay(QUEUED_SNAPSHOT, events.filter((e) => e.sequence <= 18));
  const failed = reduceRunEvent(streaming, ev(19, "run.failed", { code: "MODEL_ERROR", message: "Boom" }));

  assert.deepEqual(shape(buildTimeline(streaming)).slice(-1), ["turn-4:"]);
  assert.equal(isTraceStreaming(streaming), true);
  assert.deepEqual(shape(buildTimeline(failed)).slice(-2), ["turn-4:", "outcome:failed"]);
});

test("the goal message and tool observations never become turns", () => {
  const { final } = draftScenario();
  const items = buildTimeline(createInitialRunState(final));
  assert.equal(items.filter((item) => item.kind === "turn" || item.kind === "answer").length, 4);
});
