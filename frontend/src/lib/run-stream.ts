import { RUN_EVENT_TYPES, type RunEvent } from "./api.ts";

/**
 * Reading the live run stream, a WebSocket (backend/app/runs/websocket.py). Every message is
 * one JSON text frame, told apart by its "type":
 *
 *   {"type": "stream.ready"}      the server accepted the subscription: events after the cursor follow
 *   a RunEvent                    one committed event, in sequence order
 *   {"type": "stream.keepalive"}  15 s without events: the connection is alive
 *
 * The server closes with 1000 once a finished run's last event is out. Other close codes say
 * why the stream ended; the ones the console acts on are below.
 */

export type StreamMessage = { type: "stream.ready" } | { type: "stream.keepalive" } | RunEvent;

/** The run has finished and the client has every event. */
export const CLOSE_FINISHED = 1000;
/** No valid sign-in, or it ended while streaming: reconnecting cannot help. */
export const CLOSE_NOT_AUTHENTICATED = 4401;
/** The cursor is malformed or ahead of the run: the snapshot must replace the page's state. */
export const CLOSE_INVALID_CURSOR = 4422;

/**
 * Three missed keepalives. A network that drops without a close frame (sleep, Wi-Fi switch)
 * can otherwise look like a quiet run for minutes.
 */
export const STREAM_IDLE_TIMEOUT_MS = 45_000;

/** The socket closed with a code other than 1000 (1006 when the connection dropped). */
export class StreamClosedError extends Error {
  readonly code: number;

  constructor(code: number, reason: string) {
    super(`The run stream closed with code ${code}${reason ? `: ${reason}` : ""}.`);
    this.name = "StreamClosedError";
    this.code = code;
  }
}

/** Checks one text frame. Anything unexpected throws, and the stream loop recovers. */
export function parseStreamMessage(data: unknown): StreamMessage {
  if (typeof data !== "string") throw new Error("The run stream sent a binary message.");
  let message: StreamMessage | null;
  try {
    message = JSON.parse(data);
  } catch {
    throw new Error("The run stream sent a malformed message.");
  }
  if (message?.type === "stream.ready" || message?.type === "stream.keepalive") return { type: message.type };
  const event = message as RunEvent | null;
  if (!event || event.schema_version !== 1 || !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
      typeof event.run_id !== "string" || !RUN_EVENT_TYPES.includes(event.type) ||
      !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload) ||
      typeof event.occurred_at !== "string" || Number.isNaN(Date.parse(event.occurred_at))) {
    throw new Error("The run stream sent an invalid event.");
  }
  return event;
}

type SocketEvent =
  | { kind: "message"; data: unknown }
  | { kind: "close"; code: number; reason: string }
  | { kind: "abort" };

export interface ReadSocketOptions {
  signal: AbortSignal;
  /** Give up when nothing has arrived for this long. */
  idleTimeoutMs?: number;
}

/**
 * The socket's messages in order, as an async iterator. It ends when the server closes with
 * 1000, and throws otherwise: StreamClosedError for another close code, an Error after
 * idleTimeoutMs without a message, the signal's reason when it aborts, and parse errors.
 * However the iteration stops, the socket is closed.
 */
export async function* readRunSocket(socket: WebSocket, options: ReadSocketOptions): AsyncGenerator<StreamMessage> {
  const { signal, idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS } = options;
  // Socket events arrive whenever the network delivers them; the loop pulls them one at a time.
  const queue: SocketEvent[] = [];
  let waiting: ((event: SocketEvent) => void) | null = null;
  const push = (event: SocketEvent) => {
    if (waiting) waiting(event);
    else queue.push(event);
  };
  const next = () => new Promise<SocketEvent | "idle">((resolve) => {
    const queued = queue.shift();
    if (queued) return resolve(queued);
    const timer = setTimeout(() => {
      waiting = null;
      resolve("idle");
    }, idleTimeoutMs);
    waiting = (event) => {
      clearTimeout(timer);
      waiting = null;
      resolve(event);
    };
  });

  const onMessage = (event: MessageEvent) => push({ kind: "message", data: event.data });
  const onClose = (event: CloseEvent) => push({ kind: "close", code: event.code, reason: event.reason });
  const onAbort = () => push({ kind: "abort" });
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  signal.addEventListener("abort", onAbort);
  try {
    while (true) {
      if (signal.aborted) throw signal.reason; // also drops messages still queued
      const event = await next();
      if (event === "idle") throw new Error("The run stream went quiet.");
      if (event.kind === "abort") throw signal.reason;
      if (event.kind === "close") {
        if (event.code === CLOSE_FINISHED) return;
        throw new StreamClosedError(event.code, event.reason);
      }
      yield parseStreamMessage(event.data);
    }
  } finally {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("close", onClose);
    signal.removeEventListener("abort", onAbort);
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close();
  }
}
