import { useCallback, useEffect, useReducer, useState } from "react";
import { getRun, type RunSnapshot } from "@/lib/api";
import { createInitialRunState, reduceRunState, type RunState } from "@/lib/run-events";
import { runStreamLoop, type StreamConnection } from "@/lib/run-stream-loop";
import { isTerminalStatus } from "@/lib/status";

/** "history": the run had already finished when the page loaded, so nothing streams. */
export type ConnectionState = StreamConnection | "history";

export interface RunStream {
  state: RunState;
  connection: ConnectionState;
  /** Loads a fresh snapshot, e.g. after an approval returns 409. */
  refresh: () => Promise<void>;
  /** POST /stop succeeded; no event announces `cancelling`, so apply it locally. */
  markStopping: () => void;
}

/**
 * Live state for one run: the reducer (lib/run-events.ts) fed by the stream loop
 * (lib/run-stream-loop.ts). The loop starts from the snapshot the server rendered
 * and is aborted when the component unmounts.
 */
export function useRunStream(initialSnapshot: RunSnapshot): RunStream {
  // Later prop changes are ignored; the page keys the console by run id.
  const [start] = useState(initialSnapshot);
  const [state, dispatch] = useReducer(reduceRunState, start, createInitialRunState);
  const [connection, setConnection] = useState<ConnectionState>(
    isTerminalStatus(start.status) ? "history" : "connecting",
  );

  useEffect(() => {
    if (isTerminalStatus(start.status)) return;
    const controller = new AbortController();
    runStreamLoop({
      runId: start.id,
      cursor: start.snapshot_cursor,
      status: start.status,
      signal: controller.signal,
      onEvent: (event) => dispatch({ type: "event", event }),
      onSnapshot: (snapshot, force) => dispatch({ type: "snapshot", snapshot, force }),
      onConnection: setConnection,
    }).catch(() => {
      if (!controller.signal.aborted) setConnection("offline");
    });
    return () => controller.abort();
  }, [start]);

  const refresh = useCallback(async () => {
    const snapshot = await getRun(start.id);
    dispatch({ type: "snapshot", snapshot });
  }, [start.id]);

  const markStopping = useCallback(() => dispatch({ type: "stop-accepted" }), []);

  return { state, connection, refresh, markStopping };
}
