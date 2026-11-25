import assert from "node:assert/strict";
import test from "node:test";
import { GOAL_PRESETS } from "../../src/lib/presets.ts";
import { TOOL_CATALOG, catalogEntry } from "../../src/lib/tool-catalog.ts";

/** The routing rules of backend/app/agent/scenario_provider.py, used by the offline demo model. */
function scenarioFor(goal: string): "refund" | "zero" | "draft" {
  const text = goal.toLowerCase();
  const namesOrder = /\bord-\d+\b/.test(text);
  const asksToWrite = !text.includes("draft") && ["issue", "propose", "refund"].some((word) => text.includes(word));
  if (namesOrder && asksToWrite) return "refund";
  if (["zero", "over $10000", "over $10,000", "1000000"].some((needle) => text.includes(needle))) return "zero";
  return "draft";
}

test("each preset reaches the scenario its card promises", () => {
  const routes = Object.fromEntries(GOAL_PRESETS.map((preset) => [preset.id, scenarioFor(preset.goal)]));
  assert.deepEqual(routes, { draft: "draft", approve: "refund", reject: "refund", zero: "zero" });
});

test("presets stay within the 2000-character goal limit and name their effect", () => {
  for (const preset of GOAL_PRESETS) {
    assert.ok(preset.goal.length <= 2000, preset.id);
    assert.equal(preset.effect === "needs-approval", scenarioFor(preset.goal) === "refund", preset.id);
  }
});

test("the catalog lists the four backend tools, and only issue_refund writes", () => {
  assert.deepEqual(TOOL_CATALOG.map((entry) => entry.name), ["date_math", "query_orders", "search_policies", "issue_refund"]);
  assert.deepEqual(TOOL_CATALOG.filter((entry) => entry.access === "write").map((entry) => entry.name), ["issue_refund"]);
  assert.equal(catalogEntry("issue_refund")?.requiresApproval, true);
  assert.equal(catalogEntry("missing"), undefined);
});
