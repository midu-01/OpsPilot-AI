import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../../src/lib/api.ts";
import { describeLoadError, isMissingRunError, isUnauthorizedError } from "../../src/lib/load-errors.ts";
import { describeAnnouncement } from "../../src/lib/activity.ts";
import { createInitialRunState, reduceRunEvent } from "../../src/lib/run-events.ts";
import { approvalScenario, QUEUED_SNAPSHOT } from "./fixtures/scenarios.ts";

test("404 and 422 from GET /runs/{id} both mean the run does not exist", () => {
  assert.equal(isMissingRunError(new ApiError(404, "Run not found")), true);
  assert.equal(isMissingRunError(new ApiError(422, "Invalid UUID")), true);
  assert.equal(isMissingRunError(new ApiError(502, "Bad gateway")), false);
  assert.equal(isMissingRunError(new TypeError("fetch failed")), false);
});

test("only a 401 means the session is missing, expired or revoked", () => {
  assert.equal(isUnauthorizedError(new ApiError(401, "Not authenticated")), true);
  assert.equal(isUnauthorizedError(new ApiError(403, "Forbidden")), false);
  assert.equal(isUnauthorizedError(new ApiError(404, "Run not found")), false);
  assert.equal(isUnauthorizedError(new Error("401")), false);
  assert.equal(isMissingRunError(new ApiError(401, "Not authenticated")), false);
});

test("an outage is described without leaking internals", () => {
  assert.equal(describeLoadError(new ApiError(0, "Could not reach the API")), "The backend could not be reached.");
  assert.equal(describeLoadError(new ApiError(503, "x")), "The backend answered with HTTP 503.");
  assert.equal(describeLoadError(new DOMException("timed out", "TimeoutError")), "The backend did not respond in time.");
  assert.equal(describeLoadError(new Error("ECONNREFUSED 10.0.0.3:8000")), "The backend could not be reached.");
});

test("screen readers hear about approvals and finished runs only", () => {
  const { events } = approvalScenario();
  const paused = events.filter((e) => e.sequence <= 17).reduce(reduceRunEvent, createInitialRunState(QUEUED_SNAPSHOT));
  const finished = events.reduce(reduceRunEvent, createInitialRunState(QUEUED_SNAPSHOT));
  assert.equal(describeAnnouncement(createInitialRunState(QUEUED_SNAPSHOT)), "");
  assert.equal(describeAnnouncement(paused), "Approval needed: $84.51 USD refund for ORD-1006.");
  assert.equal(describeAnnouncement(finished), "Completed in 4 turns and 3 tool calls.");
  const decided = events.filter((e) => e.sequence <= 19).reduce(reduceRunEvent, createInitialRunState(QUEUED_SNAPSHOT));
  assert.equal(describeAnnouncement(decided), "Your decision is recorded. Resuming the run…");
});
