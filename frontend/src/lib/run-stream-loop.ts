import { getRun, getStreamUrl, type RunEvent, type RunSnapshot, type RunStatus } from "./api.ts";
import { readRunEvents } from "./run-stream.ts";
import { isTerminalStatus } from "./status.ts";

/**
 * The live connection for one run, without React:
 *
 *   1. GET /api/runs/{id}/stream?after=<cursor>  (+ Last-Event-ID), parse SSE frames.
 *   2. Each event must be cursor + 1. Duplicates are skipped; a gap means we missed
 *      something, so we load a fresh snapshot and reconnect from its cursor.
 *   3. On a disconnect, reload the snapshot, back off (1 s, 2 s, 4 s … 15 s), retry.
 *   4. Stop when the run is finished (terminal event, or 204 "finished and caught up"),
 *      or when the caller aborts (component unmount).
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
  /** `force` is set when the server rejected our cursor (422) and the snapshot must replace state. */
  onSnapshot: (snapshot: RunSnapshot, force: boolean) => void;
  onConnection: (connection: StreamConnection) => void;
  // Injected in tests.
  fetchStream?: (url: string, init: RequestInit) => Promise<Response>;
  loadSnapshot?: (runId: string, signal: AbortSignal) => Promise<RunSnapshot>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
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
  const fetchStream = options.fetchStream ?? ((url: string, init: RequestInit) => fetch(url, init));
  const loadSnapshot = options.loadSnapshot ?? ((runId: string, signal: AbortSignal) => getRun(runId, { signal }));
  const sleep = options.sleep ?? abortableSleep;
  const { runId, signal } = options;
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

  while (!signal.aborted && !isTerminalStatus(status)) {
    try {
      options.onConnection(failures === 0 ? "connecting" : "reconnecting");
      const response = await fetchStream(getStreamUrl(runId, cursor), {
        headers: { Accept: "text/event-stream", "Last-Event-ID": String(cursor) },
        cache: "no-store",
        signal,
      });
      if (response.status === 204) {
        await reconcile(); // finished and we are caught up: load the final snapshot
        if (isTerminalStatus(status)) break;
        throw new Error("The stream ended but the run has not finished.");
      }
      if (response.status === 422) {
        // Our cursor is ahead of the run (for example the database was reset):
        // take the server's snapshot, then retry through the back-off path.
        await reconcile(true);
        throw new Error("The stream cursor was ahead of the run.");
      }
      if (!response.ok) throw new Error(`The run stream returned HTTP ${response.status}.`);

      options.onConnection("live");
      for await (const event of readRunEvents(response)) {
        if (event.run_id !== runId) throw new Error("The stream belongs to a different run.");
        if (event.sequence <= cursor) continue; // already applied (replayed after a reconnect)
        if (event.sequence !== cursor + 1) throw new StreamGapError(cursor + 1, event.sequence);
        cursor = event.sequence;
        status = TERMINAL_EVENTS[event.type] ?? status;
        options.onEvent(event);
        failures = 0; // reset only once an event got through, so a bad frame keeps backing off
      }
      // The server closes the stream after the run finishes. Load the final snapshot
      // (model calls, exact active time). Any other close is a disconnect.
      await reconcile();
      if (!isTerminalStatus(status)) throw new Error("The stream closed before the run finished.");
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof StreamGapError) {
        const before = cursor;
        await reconcile().catch(() => undefined);
        if (cursor > before) continue; // the snapshot covered the gap: reconnect right away
      }
      failures += 1;
      options.onConnection("reconnecting");
      try {
        await reconcile();
      } catch {
        if (signal.aborted) return;
        options.onConnection("offline");
      }
      if (isTerminalStatus(status)) break;
      await sleep(backoffDelay(failures - 1), signal);
    }
  }
  if (!signal.aborted) options.onConnection("closed");
}
