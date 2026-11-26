/**
 * A WebSocket stand-in for unit tests, in which the test plays the server. It dispatches real
 * MessageEvent and CloseEvent objects, as a browser's WebSocket does.
 */
export class FakeSocket extends EventTarget {
  readonly url: string;
  readyState: number = WebSocket.CONNECTING;
  /** How many times the client called close(). */
  closeCalls = 0;

  constructor(url = "ws://console.test/api/runs/stream") {
    super();
    this.url = url;
  }

  /** The handshake completed. */
  open(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  /** The server sent a text frame: a string as it is, anything else as JSON. */
  serverSends(message: unknown): void {
    const data = typeof message === "string" ? message : JSON.stringify(message);
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  /** The server closed the socket, or the network dropped it (1006). */
  serverCloses(code: number, reason = ""): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean: code !== 1006 }));
  }

  /** The client closes; a browser would report "close" later, which no test needs. */
  close(): void {
    this.closeCalls += 1;
    this.readyState = WebSocket.CLOSING;
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}
