import assert from "node:assert/strict";
import test from "node:test";
import { countUnfinished, parsePageParam, summarizePage } from "../../src/lib/runs-page.ts";
import type { RunSummary } from "../../src/lib/api.ts";

test("the page parameter only accepts positive integers", () => {
  assert.equal(parsePageParam(undefined), 1);
  assert.equal(parsePageParam("3"), 3);
  assert.equal(parsePageParam(["4", "5"]), 4);
  for (const bad of ["0", "-2", "1.5", "abc", "", "2e3"]) assert.equal(parsePageParam(bad), 1, bad);
  assert.equal(parsePageParam("99999999999999"), 2_147_483_647);
});

test("page summaries give the visible range and the navigation", () => {
  assert.deepEqual(summarizePage(1, 20, 57, 20), { from: 1, to: 20, totalPages: 3, hasPrevious: false, hasNext: true, outOfRange: false });
  assert.deepEqual(summarizePage(3, 20, 57, 17), { from: 41, to: 57, totalPages: 3, hasPrevious: true, hasNext: false, outOfRange: false });
  assert.deepEqual(summarizePage(1, 20, 0, 0), { from: 0, to: 0, totalPages: 1, hasPrevious: false, hasNext: false, outOfRange: false });
  assert.equal(summarizePage(9, 20, 57, 0).outOfRange, true);
});

test("unfinished runs keep the list refreshing", () => {
  const run = (status: RunSummary["status"]) => ({ status }) as RunSummary;
  assert.equal(countUnfinished([run("completed"), run("failed"), run("cancelled")]), 0);
  assert.equal(countUnfinished([run("running"), run("awaiting_approval"), run("cancelling"), run("queued"), run("completed")]), 4);
});
