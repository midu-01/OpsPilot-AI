import { getRun, getStreamUrl, type RunEvent, type RunSnapshot, type RunStatus } from "./api.ts";
import { isUnauthorizedError } from "./load-errors.ts";
import { CLOSE_INVALID_CURSOR, CLOSE_NOT_AUTHENTICATED, readRunSocket, StreamClosedError } from "./run-stream.ts";
import { isTerminalStatus } from "./status.ts";

/**
 * The live connection for one run, without React:
 *
 *   1. Open a WebSocket to /api/runs/{id}/stream?after=<cursor>. The server answers
 *      "stream.ready", replays the events after the cursor, then sends new ones as they commit.
 *   2. Each event must be cursor + 1. Duplicates are skipped; a gap means we missed
 *      something, so we load a fresh snapshot and reconnect from its cursor.
 *   3. On a disconnect, or 45 s without a message, reload the snapshot, back off
 *      (1 s, 2 s, 4 s … 15 s) and reconnect. After a 4422 close (our cursor is ahead of the
 *      run) that snapshot replaces the page's state.
 *   4. Stop when the run is finished (the server closes with 1000 after its last event), when
 *      the caller aborts (component unmount), or when the session ended (a 4401 close, or 401
 *      from a snapshot): retrying cannot help, and the caller sends the user to sign in.
 *
 * The caller owns state: it receives events and snapshots through callbacks.
 */

export type StreamConnection = "connecting" | "live" | "reconnecting" | "offline" | "closed";

export interface StreamLoopOptions {
  runId: string;
  /** Cursor and status of the snapshot the page rendered with. */
  cursor: number;
  status: RunStatus;
  signal: AbortSignal;
  onEvent: (event: RunEvent) => void;
  /** `force` is set when the server rejected our cursor (4422) and the snapshot must replace state. */
  onSnapshot: (snapshot: RunSnapshot, force: boolean) => void;
  onConnection: (connection: StreamConnection) => void;
  /** The session ended: the loop has stopped, and the caller sends the user to sign in. */
  onUnauthorized?: () => void;
  // Injected in tests.
  openSocket?: (url: string) => WebSocket;
  loadSnapshot?: (runId: string, signal: AbortSignal) => Promise<RunSnapshot>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  idleTimeoutMs?: number;
}

const MAX_BACKOFF_MS = 15_000;

const TERMINAL_EVENTS: Partial<Record<RunEvent["type"], RunStatus>> = {
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
};

/** 1 s, 2 s, 4 s, 8 s, then 15 s between retries. */
export function backoffDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
}

class StreamGapError extends Error {
  constructor(expected: number, received: number) {
    super(`Expected event ${expected} but received ${received}.`);
    this.name = "StreamGapError";
  }
}

function isClose(error: unknown, code: number): boolean {
  return error instanceof StreamClosedError && error.code === code;
}

/** Resolves after `ms`, or as soon as the signal aborts. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

export async function runStreamLoop(options: StreamLoopOptions): Promise<void> {
  const openSocket = options.openSocket ?? ((url: string) => new WebSocket(url));
  const loadSnapshot = options.loadSnapshot ?? ((runId: string, signal: AbortSignal) => getRun(runId, { signal }));
  const sleep = options.sleep ?? abortableSleep;
  const { runId, signal, idleTimeoutMs } = options;
  let cursor = options.cursor;
  let status = options.status;
  let failures = 0;

  async function reconcile(force = false): Promise<void> {
    const snapshot = await loadSnapshot(runId, signal);
    if (signal.aborted) return;
    // A snapshot may be older than events we already applied; keep the newer cursor.
    if (force || snapshot.snapshot_cursor >= cursor) {
      cursor = snapshot.snapshot_cursor;
      status = snapshot.status;
    }
    options.onSnapshot(snapshot, force);
  }

  function sessionEnded(error: unknown): boolean {
    if (!isUnauthorizedError(error) && !isClose(error, CLOSE_NOT_AUTHENTICATED)) return false;
    options.onUnauthorized?.();
    return true;
  }

  while (!signal.aborted && !isTerminalStatus(status)) {
    try {
      options.onConnection(failures === 0 ? "connecting" : "reconnecting");
      const socket = openSocket(getStreamUrl(runId, cursor));
      for await (const message of readRunSocket(socket, { signal, idleTimeoutMs })) {
        if (message.type === "stream.ready") {
          options.onConnection("live");
          continue;
        }
        if (message.type === "stream.keepalive") continue;
        if (message.run_id !== runId) throw new Error("The stream belongs to a different run.");
        if (message.sequence <= cursor) continue; // already applied (replayed after a reconnect)
        if (message.sequence !== cursor + 1) throw new StreamGapError(cursor + 1, message.sequence);
        cursor = message.sequence;
        status = TERMINAL_EVENTS[message.type] ?? status;
        options.onEvent(message);
        failures = 0; // reset only once an event got through, so a bad message keeps backing off
      }
      // The server closed with 1000: the run has finished and we have its last event. Load
      // the final snapshot (model calls, exact active time).
      await reconcile();
      if (!isTerminalStatus(status)) throw new Error("The stream closed before the run finished.");
    } catch (error) {
      if (signal.aborted || sessionEnded(error)) return;
      if (error instanceof StreamGapError) {
        const before = cursor;
        await reconcile().catch(() => undefined);
        if (cursor > before) continue; // the snapshot covered the gap: reconnect right away
      }
      failures += 1;
      options.onConnection("reconnecting");
      try {
        // 4422: our cursor is ahead of the run (for example the database was reset), so the
        // server's snapshot replaces the page's state before we reconnect from its cursor.
        await reconcile(isClose(error, CLOSE_INVALID_CURSOR));
      } catch (reconcileError) {
        if (signal.aborted || sessionEnded(reconcileError)) return;
        options.onConnection("offline");
      }
      if (isTerminalStatus(status)) break;
      await sleep(backoffDelay(failures - 1), signal);
    }
  }
  if (!signal.aborted) options.onConnection("closed");
}
