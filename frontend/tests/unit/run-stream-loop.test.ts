import assert from "node:assert/strict";
import test from "node:test";
import { backoffDelay, runStreamLoop, type StreamConnection, type StreamLoopOptions } from "../../src/lib/run-stream-loop.ts";
import type { RunEvent, RunSnapshot } from "../../src/lib/api.ts";
import { ev, QUEUED_SNAPSHOT, RUN_ID } from "./fixtures/scenarios.ts";

function sse(events: RunEvent[], { comment = false } = {}): Response {
  const body = events.map((e) => `${comment ? ": keepalive\n\n" : ""}id: ${e.sequence}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function snapshotAt(cursor: number, status: RunSnapshot["status"]): RunSnapshot {
  const events = Array.from({ length: cursor }, (_, i) => ev(i + 1, i === 0 ? "run.queued" : "message.delta", {}));
  return { ...QUEUED_SNAPSHOT, status, events, snapshot_cursor: cursor };
}

interface Harness {
  options: StreamLoopOptions;
  requests: { url: string; lastEventId: string | null }[];
  events: number[];
  snapshots: { cursor: number; force: boolean }[];
  connections: StreamConnection[];
  sleeps: number[];
  controller: AbortController;
}

function harness(responses: Array<Response | Error>, snapshots: RunSnapshot[], cursor = 1): Harness {
  const h: Harness = { requests: [], events: [], snapshots: [], connections: [], sleeps: [], controller: new AbortController(), options: undefined as never };
  h.options = {
    runId: RUN_ID,
    cursor,
    status: "running",
    signal: h.controller.signal,
    onEvent: (event) => h.events.push(event.sequence),
    onSnapshot: (snapshot, force) => h.snapshots.push({ cursor: snapshot.snapshot_cursor, force }),
    onConnection: (connection) => h.connections.push(connection),
    fetchStream: async (url, init) => {
      h.requests.push({ url, lastEventId: new Headers(init.headers).get("Last-Event-ID") });
      const next = responses.shift();
      if (!next) throw new Error("no more responses");
      if (next instanceof Error) throw next;
      return next;
    },
    loadSnapshot: async () => {
      const next = snapshots.shift();
      if (!next) throw new Error("backend unreachable");
      return next;
    },
    sleep: async (ms) => {
      h.sleeps.push(ms);
    },
  };
  return h;
}

test("streams from the cursor, applies events in order and stops after the run finishes", async () => {
  const h = harness(
    [sse([ev(2, "run.started", {}), ev(3, "message.delta", { message_id: "m", delta: "Hi" }), ev(4, "run.completed", {})], { comment: true })],
    [snapshotAt(4, "completed")],
  );

  await runStreamLoop(h.options);

  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].url, /\/runs\/run-123\/stream\?after=1$/);
  assert.equal(h.requests[0].lastEventId, "1");
  assert.deepEqual(h.events, [2, 3, 4]);
  assert.deepEqual(h.snapshots, [{ cursor: 4, force: false }]); // the final snapshot
  assert.deepEqual(h.connections, ["connecting", "live", "closed"]);
});

test("events already applied are skipped after a reconnect", async () => {
  const h = harness([sse([ev(2, "run.started", {}), ev(3, "run.completed", {})])], [snapshotAt(3, "completed")], 2);
  await runStreamLoop(h.options);
  assert.deepEqual(h.events, [3]);
});

test("a sequence gap reloads the snapshot and reconnects from its cursor", async () => {
  const h = harness(
    [sse([ev(2, "run.started", {}), ev(5, "message.delta", {})]), sse([ev(6, "run.completed", {})])],
    [snapshotAt(5, "running"), snapshotAt(6, "completed")],
  );

  await runStreamLoop(h.options);

  assert.deepEqual(h.events, [2, 6]);
  assert.match(h.requests[1].url, /after=5$/);
  assert.deepEqual(h.sleeps, []); // a gap is not a failure, so there is no back-off
});

test("204 means finished and caught up: load the final snapshot and stop", async () => {
  const h = harness([new Response(null, { status: 204 })], [snapshotAt(9, "completed")]);
  await runStreamLoop(h.options);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.snapshots, [{ cursor: 9, force: false }]);
  assert.equal(h.connections.at(-1), "closed");
});

test("422 means our cursor is ahead of the run: force the snapshot and restart from it", async () => {
  const h = harness([new Response("ahead", { status: 422 }), sse([ev(4, "run.completed", {})])], [snapshotAt(3, "running"), snapshotAt(4, "completed")], 7);
  await runStreamLoop(h.options);
  assert.deepEqual(h.snapshots[0], { cursor: 3, force: true });
  assert.match(h.requests[1].url, /after=3$/);
  assert.deepEqual(h.events, [4]);
});

test("a disconnect reconnects with back-off and reports offline while the backend is down", async () => {
  const h = harness(
    [new TypeError("network down"), new TypeError("network down"), sse([ev(2, "run.completed", {})])],
    // First reconcile fails (backend down), second succeeds, then the final snapshot.
    [],
  );
  const snapshots = [snapshotAt(1, "running"), snapshotAt(2, "completed")];
  let calls = 0;
  h.options.loadSnapshot = async () => {
    calls += 1;
    if (calls === 1) throw new Error("backend unreachable");
    return snapshots.shift()!;
  };

  await runStreamLoop(h.options);

  assert.deepEqual(h.sleeps, [1000, 2000]);
  // Attempt 1 fails and the snapshot fails too (offline); attempt 2 fails but the
  // snapshot loads (reconnecting); attempt 3 streams.
  assert.deepEqual(h.connections, [
    "connecting",
    "reconnecting",
    "offline",
    "reconnecting",
    "reconnecting",
    "reconnecting",
    "live",
    "closed",
  ]);
  assert.deepEqual(h.events, [2]);
});

test("a stream that closes before the run finishes counts as a disconnect", async () => {
  const h = harness([sse([ev(2, "run.started", {})]), sse([ev(3, "run.completed", {})])], [
    snapshotAt(2, "running"), // after the early close
    snapshotAt(2, "running"), // reconcile in the retry path
    snapshotAt(3, "completed"),
  ]);
  await runStreamLoop(h.options);
  assert.deepEqual(h.events, [2, 3]);
  assert.deepEqual(h.sleeps, [1000]);
});

test("aborting stops the loop without further requests or callbacks", async () => {
  const h = harness([new TypeError("network down")], [snapshotAt(1, "running")]);
  h.options.sleep = async () => {
    h.controller.abort();
  };
  await runStreamLoop(h.options);
  assert.equal(h.requests.length, 1);
  assert.notEqual(h.connections.at(-1), "closed");
});

test("a finished run is never streamed", async () => {
  const h = harness([], []);
  await runStreamLoop({ ...h.options, status: "completed" });
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.connections, ["closed"]);
});

test("back-off doubles up to 15 seconds", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 10].map(backoffDelay), [1000, 2000, 4000, 8000, 15000, 15000]);
});
