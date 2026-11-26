import assert from "node:assert/strict";
import test from "node:test";
import { backoffDelay, runStreamLoop, type StreamConnection, type StreamLoopOptions } from "../../src/lib/run-stream-loop.ts";
import { ApiError, type RunEvent, type RunSnapshot } from "../../src/lib/api.ts";
import { ev, QUEUED_SNAPSHOT, RUN_ID } from "./fixtures/scenarios.ts";
import { FakeSocket } from "./fixtures/fake-socket.ts";

/** What the backend does with one connection, once the loop has opened it. */
type Server = (socket: FakeSocket) => void;

/** Accepts, sends "ready", a keepalive and the events, then closes (1000 after a finished run). */
function serve(events: RunEvent[], code = 1000): Server {
  return (socket) => {
    socket.open();
    socket.serverSends({ type: "stream.ready" });
    socket.serverSends({ type: "stream.keepalive" });
    for (const event of events) socket.serverSends(event);
    socket.serverCloses(code, code === 1000 ? "Run finished" : "");
  };
}

/** Accepts, then closes before "ready": how the backend refuses (4401, 4422) or ends a run the client has in full (1000). */
function refuse(code: number, reason = ""): Server {
  return (socket) => {
    socket.open();
    socket.serverCloses(code, reason);
  };
}

/** The connection fails: proxy.ts refused it or the network is down. Browsers report 1006. */
const drop: Server = (socket) => socket.serverCloses(1006);

/** Accepts and sends "ready", then nothing: the socket stays open. */
const quiet: Server = (socket) => {
  socket.open();
  socket.serverSends({ type: "stream.ready" });
};

function snapshotAt(cursor: number, status: RunSnapshot["status"]): RunSnapshot {
  const events = Array.from({ length: cursor }, (_, i) => ev(i + 1, i === 0 ? "run.queued" : "message.delta", {}));
  return { ...QUEUED_SNAPSHOT, status, events, snapshot_cursor: cursor };
}

interface Harness {
  options: StreamLoopOptions;
  urls: string[];
  sockets: FakeSocket[];
  events: number[];
  snapshots: { cursor: number; force: boolean }[];
  connections: StreamConnection[];
  sleeps: number[];
  controller: AbortController;
}

function harness(servers: Server[], snapshots: RunSnapshot[], cursor = 1): Harness {
  const h: Harness = { urls: [], sockets: [], events: [], snapshots: [], connections: [], sleeps: [], controller: new AbortController(), options: undefined as never };
  h.options = {
    runId: RUN_ID,
    cursor,
    status: "running",
    signal: h.controller.signal,
    onEvent: (event) => h.events.push(event.sequence),
    onSnapshot: (snapshot, force) => h.snapshots.push({ cursor: snapshot.snapshot_cursor, force }),
    onConnection: (connection) => h.connections.push(connection),
    openSocket: (url) => {
      const socket = new FakeSocket(url);
      h.urls.push(url);
      h.sockets.push(socket);
      const server = servers.shift();
      // Out of scripted connections: stop the loop instead of retrying forever.
      if (!server) h.controller.abort();
      else setTimeout(() => server(socket), 0); // like a network: after the current task
      return socket.asWebSocket();
    },
    loadSnapshot: async () => {
      const next = snapshots.shift();
      if (!next) throw new Error("backend unreachable");
      return next;
    },
    sleep: async (ms) => {
      h.sleeps.push(ms);
      // A loop that keeps backing off without progress would never end with an instant sleep.
      if (h.sleeps.length > 20) h.controller.abort();
    },
  };
  return h;
}

test("streams from the cursor, applies events in order and stops after the run finishes", async () => {
  const h = harness(
    [serve([ev(2, "run.started", {}), ev(3, "message.delta", { message_id: "m", delta: "Hi" }), ev(4, "run.completed", {})])],
    [snapshotAt(4, "completed")],
  );

  await runStreamLoop(h.options);

  assert.equal(h.urls.length, 1);
  assert.match(h.urls[0], new RegExp(`^ws://.+/runs/${RUN_ID}/stream\\?after=1$`));
  assert.deepEqual(h.events, [2, 3, 4]);
  assert.deepEqual(h.snapshots, [{ cursor: 4, force: false }]); // the final snapshot
  assert.deepEqual(h.connections, ["connecting", "live", "closed"]);
});

test("events already applied are skipped after a reconnect", async () => {
  const h = harness([serve([ev(2, "run.started", {}), ev(3, "run.completed", {})])], [snapshotAt(3, "completed")], 2);
  await runStreamLoop(h.options);
  assert.deepEqual(h.events, [3]);
});

test("a sequence gap reloads the snapshot and reconnects from its cursor", async () => {
  const h = harness(
    [serve([ev(2, "run.started", {}), ev(5, "message.delta", {})]), serve([ev(6, "run.completed", {})])],
    [snapshotAt(5, "running"), snapshotAt(6, "completed")],
  );

  await runStreamLoop(h.options);

  assert.deepEqual(h.events, [2, 6]);
  assert.match(h.urls[1], /after=5$/);
  assert.deepEqual(h.sleeps, []); // a gap is not a failure, so there is no back-off
});

test("a 1000 close before \"ready\" means finished and caught up: load the final snapshot and stop", async () => {
  const h = harness([refuse(1000, "Run finished")], [snapshotAt(9, "completed")]);
  await runStreamLoop(h.options);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.snapshots, [{ cursor: 9, force: false }]);
  assert.deepEqual(h.connections, ["connecting", "closed"]); // never "live"
});

test("4422 means our cursor is ahead of the run: force the snapshot, back off, restart from it", async () => {
  const h = harness(
    [refuse(4422, "Cursor is ahead of the run's latest sequence"), serve([ev(4, "run.completed", {})])],
    [snapshotAt(3, "running"), snapshotAt(4, "completed")],
    7,
  );
  await runStreamLoop(h.options);
  assert.deepEqual(h.snapshots, [{ cursor: 3, force: true }, { cursor: 4, force: false }]);
  assert.match(h.urls[1], /after=3$/);
  assert.deepEqual(h.events, [4]);
  assert.deepEqual(h.sleeps, [1000]);
});

test("repeated 4422s back off instead of hammering the backend", async () => {
  const rejected = () => refuse(4422, "Cursor is ahead of the run's latest sequence");
  const h = harness([rejected(), rejected(), rejected()], Array.from({ length: 3 }, () => snapshotAt(3, "running")), 7);
  await runStreamLoop(h.options);
  assert.deepEqual(h.sleeps, [1000, 2000, 4000]);
});

test("a gap the snapshot cannot repair backs off like a disconnect", async () => {
  const h = harness(
    [serve([ev(2, "run.started", {}), ev(5, "message.delta", {})]), serve([ev(3, "run.completed", {})])],
    [snapshotAt(2, "running"), snapshotAt(2, "running"), snapshotAt(3, "completed")],
  );
  await runStreamLoop(h.options);
  assert.deepEqual(h.events, [2, 3]);
  assert.deepEqual(h.sleeps, [1000]);
});

test("a malformed message closes the socket and keeps backing off until an event gets through", async () => {
  const bad: Server = (socket) => {
    quiet(socket);
    socket.serverSends("{bad");
  };
  const h = harness([bad, bad, serve([ev(2, "run.completed", {})])], [snapshotAt(1, "running"), snapshotAt(1, "running"), snapshotAt(2, "completed")]);
  await runStreamLoop(h.options);
  assert.deepEqual(h.sleeps, [1000, 2000]);
  assert.deepEqual(h.events, [2]);
  assert.deepEqual(h.sockets.map((socket) => socket.closeCalls), [1, 1, 0]); // the server closed the last one
});

test("a 1000 close whose snapshot is not finished is treated as a disconnect", async () => {
  const h = harness([refuse(1000, "Run finished"), serve([ev(2, "run.completed", {})])], [snapshotAt(1, "running"), snapshotAt(1, "running"), snapshotAt(2, "completed")]);
  await runStreamLoop(h.options);
  assert.deepEqual(h.sleeps, [1000]);
  assert.deepEqual(h.events, [2]);
});

test("a dropped connection reconnects with back-off and reports offline while the backend is down", async () => {
  const h = harness([drop, drop, serve([ev(2, "run.completed", {})])], []);
  const snapshots = [snapshotAt(1, "running"), snapshotAt(2, "completed")];
  let calls = 0;
  h.options.loadSnapshot = async () => {
    calls += 1;
    if (calls === 1) throw new Error("backend unreachable");
    return snapshots.shift()!;
  };

  await runStreamLoop(h.options);

  assert.deepEqual(h.sleeps, [1000, 2000]);
  // Attempt 1 drops and the snapshot fails too (offline); attempt 2 drops but the
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
  const h = harness([serve([ev(2, "run.started", {})]), serve([ev(3, "run.completed", {})])], [
    snapshotAt(2, "running"), // after the early close
    snapshotAt(2, "running"), // reconcile in the retry path
    snapshotAt(3, "completed"),
  ]);
  await runStreamLoop(h.options);
  assert.deepEqual(h.events, [2, 3]);
  assert.deepEqual(h.sleeps, [1000]);
});

test("a stream that goes quiet is closed and reopened", async () => {
  const h = harness([quiet, serve([ev(2, "run.completed", {})])], [snapshotAt(1, "running"), snapshotAt(2, "completed")]);
  h.options.idleTimeoutMs = 20; // no keepalive for this long: the connection is presumed dead

  await runStreamLoop(h.options);

  assert.equal(h.sockets[0].closeCalls, 1);
  assert.deepEqual(h.sleeps, [1000]);
  assert.deepEqual(h.events, [2]);
  assert.deepEqual(h.connections, ["connecting", "live", "reconnecting", "reconnecting", "live", "closed"]);
});

test("aborting (the console unmounting) closes the open socket and stops without further callbacks", async () => {
  const h = harness([quiet], []);
  h.options.onConnection = (connection) => {
    h.connections.push(connection);
    if (connection === "live") setTimeout(() => h.controller.abort(), 0);
  };
  await runStreamLoop(h.options);
  assert.equal(h.sockets[0].closeCalls, 1);
  assert.deepEqual(h.connections, ["connecting", "live"]);
  assert.deepEqual(h.snapshots, []);
});

test("aborting during the back-off stops the loop without further connections", async () => {
  const h = harness([drop], [snapshotAt(1, "running")]);
  h.options.sleep = async () => {
    h.controller.abort();
  };
  await runStreamLoop(h.options);
  assert.equal(h.urls.length, 1);
  assert.notEqual(h.connections.at(-1), "closed");
});

test("a finished run is never streamed", async () => {
  const h = harness([], []);
  await runStreamLoop({ ...h.options, status: "completed" });
  assert.equal(h.urls.length, 0);
  assert.deepEqual(h.connections, ["closed"]);
});

test("back-off doubles up to 15 seconds", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 10].map(backoffDelay), [1000, 2000, 4000, 8000, 15000, 15000]);
});

test("a 4401 close stops the loop at once and asks the page to sign in again", async () => {
  const h = harness([refuse(4401, "Not authenticated")], [snapshotAt(1, "running")]);
  let unauthorized = 0;
  h.options.onUnauthorized = () => {
    unauthorized += 1;
  };
  await runStreamLoop(h.options);
  assert.equal(unauthorized, 1);
  assert.equal(h.urls.length, 1);
  assert.deepEqual(h.sleeps, []); // no retries: only signing in again can help
  assert.deepEqual(h.snapshots, []);
});

for (const [name, first] of [
  ["after a dropped connection", drop],
  ["after the stream reports the run finished", refuse(1000, "Run finished")],
] as const) {
  test(`a 401 while loading the snapshot ${name} also stops the loop`, async () => {
    const h = harness([first], []);
    h.options.loadSnapshot = async () => {
      throw new ApiError(401, "Request failed (401): Not authenticated", "Not authenticated");
    };
    let unauthorized = 0;
    h.options.onUnauthorized = () => {
      unauthorized += 1;
    };
    await runStreamLoop(h.options);
    assert.equal(unauthorized, 1);
    assert.equal(h.urls.length, 1);
    assert.deepEqual(h.sleeps, []);
    assert.notEqual(h.connections.at(-1), "closed");
  });
}
