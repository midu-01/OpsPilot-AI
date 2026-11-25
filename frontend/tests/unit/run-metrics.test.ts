import assert from "node:assert/strict";
import test from "node:test";
import { activeElapsedMs, budgetItems, toolCallDurationMs } from "../../src/lib/run-metrics.ts";
import { createInitialRunState } from "../../src/lib/run-events.ts";
import { QUEUED_SNAPSHOT } from "./fixtures/scenarios.ts";

test("active time ticks locally only while the stopwatch runs", () => {
  const since = "2026-02-15T12:00:00Z";
  assert.equal(activeElapsedMs({ active_elapsed_ms: 1000, active_since: null }, Date.parse(since) + 5000), 1000);
  assert.equal(activeElapsedMs({ active_elapsed_ms: 1000, active_since: since }, Date.parse(since) + 5000), 6000);
  assert.equal(activeElapsedMs({ active_elapsed_ms: 1000, active_since: since }, null), 1000);
  // A client clock behind the server never makes time go negative.
  assert.equal(activeElapsedMs({ active_elapsed_ms: 1000, active_since: since }, Date.parse(since) - 3000), 1000);
});

test("budget items show usage against limits and flag partial numbers", () => {
  const state = {
    ...createInitialRunState({ ...QUEUED_SNAPSHOT, step_count: 3, tool_call_count: 36, total_tokens: 1530 }),
    token_usage_complete: false,
    estimated_cost_usd: "0.0042",
    cost_is_upper_bound: true,
  };
  const items = Object.fromEntries(budgetItems(state, null).map((item) => [item.key, item]));

  assert.equal(items.turns.value, "3 / 20");
  assert.deepEqual(items["tool-calls"].meter, { value: 36, max: 40, text: "36 of 40 tool calls used" });
  assert.equal(items.tokens.value, "1,530");
  assert.equal(items.tokens.flag, "partial");
  assert.equal(items.cost.value, "$0.0042");
  assert.equal(items.cost.flag, "upper bound");
  assert.equal(items["active-time"].value, "—"); // queued: the agent has not started yet
});

test("active time shows the server value plus the local stopwatch", () => {
  const state = createInitialRunState({ ...QUEUED_SNAPSHOT, status: "running", active_elapsed_ms: 4000, updated_at: "2026-02-15T12:00:00Z" });
  const active = budgetItems(state, Date.parse("2026-02-15T12:00:02.500Z")).find((item) => item.key === "active-time");
  assert.equal(active?.value, "6.5s");
});

test("an unknown cost shows a dash and explains why", () => {
  const items = budgetItems(createInitialRunState(QUEUED_SNAPSHOT), null);
  const cost = items.find((item) => item.key === "cost");
  assert.equal(cost?.value, "—");
  assert.match(cost?.hint ?? "", /no configured price/);
  assert.equal(items.find((item) => item.key === "tokens")?.flag, null);
});

test("a tool call's duration comes from its server timestamps", () => {
  assert.equal(toolCallDurationMs({ started_at: "2026-02-15T12:00:00Z", completed_at: "2026-02-15T12:00:01.250Z" }), 1250);
  assert.equal(toolCallDurationMs({ started_at: "2026-02-15T12:00:00Z", completed_at: null }), null);
  assert.equal(toolCallDurationMs({ started_at: "bad", completed_at: "2026-02-15T12:00:00Z" }), null);
});
