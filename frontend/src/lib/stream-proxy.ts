import { isSameOrigin } from "./api-proxy.ts";

/**
 * The live run stream's WebSocket handshake, as it passes the console. A route handler cannot
 * accept a WebSocket, but Next runs proxy.ts for upgrade requests too, and when proxy.ts
 * rewrites one to another server, Next pipes the socket there byte for byte. This module
 * decides what proxy.ts does with GET /api/runs/{id}/stream, doing for the stream what
 * api-proxy.ts does for every other call:
 *
 *   - Refuse a handshake from another origin (cross-site WebSocket hijacking). A WebSocket is
 *     not subject to CORS, but browsers always send Origin with the handshake.
 *   - Refuse one without a session. The console then reloads the snapshot over HTTP, gets
 *     401 and sends the user to sign in, so unauthenticated sockets never reach FastAPI.
 *   - Forward the rest to API_INTERNAL_URL with `Authorization: Bearer <token>` from the
 *     HttpOnly cookie and only the headers a handshake needs: never the browser's cookies.
 *
 * To refuse, proxy.ts answers NextResponse.next(): the upgrade then reaches the /api route,
 * and Next closes the socket (the browser sees code 1006). Returning a Response with a status
 * instead would leave the socket open with no answer.
 */

const RUN_STREAM_PATH = /^\/api\/runs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/stream$/i;

// What a WebSocket handshake needs (RFC 6455). permessage-deflate is negotiated end to end.
const HANDSHAKE_HEADERS = ["connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions"];

export type StreamRoute =
  | { action: "refuse" }
  | { action: "forward"; target: URL; headers: Headers };

const REFUSE: StreamRoute = { action: "refuse" };

export function isRunStreamPath(pathname: string): boolean {
  return RUN_STREAM_PATH.test(pathname);
}

function isWebSocketHandshake(request: Request): boolean {
  return request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/** Where proxy.ts sends a request for /api/runs/{id}/stream, if anywhere. */
export function routeRunStream(request: Request, sessionToken: string | null): StreamRoute {
  const url = new URL(request.url);
  const runId = RUN_STREAM_PATH.exec(url.pathname)?.[1];
  // A plain GET is refused here too: the /api route then answers 426 Upgrade Required.
  if (!runId || !isWebSocketHandshake(request) || !isSameOrigin(request) || sessionToken === null) return REFUSE;

  const base = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:8000";
  const target = new URL(`runs/${runId}/stream`, `${base.replace(/\/+$/, "")}/`);
  const after = url.searchParams.get("after");
  if (after !== null) target.searchParams.set("after", after); // FastAPI validates it (4422)

  const headers = new Headers();
  for (const name of HANDSHAKE_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${sessionToken}`);
  return { action: "forward", target, headers };
}
