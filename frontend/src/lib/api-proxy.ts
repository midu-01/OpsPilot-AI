/**
 * The browser's only way to the backend: /api/* on the console's own origin. The proxy
 * allowlists paths, refuses cross-origin writes, caps bodies, and turns the HttpOnly session
 * cookie into `Authorization: Bearer <token>` (the route handler reads the cookie and passes
 * the token in). Browser JavaScript never holds the token. Health checks stay public.
 *
 * The live run stream is a WebSocket, which a route handler cannot accept: proxy.ts forwards
 * its handshake instead (lib/stream-proxy.ts). A plain GET of that path gets 426 here.
 */

const API_PATH = /^(?:runs(?:\/[^/]+(?:\/(?:approve|stop))?)?|health\/(?:live|ready))$/;

// Only these request headers reach the backend: never the browser's Cookie or Authorization.
const FORWARDED_HEADERS = ["accept", "content-type"];

// Goals and rejection reasons are at most 2000 characters; anything near this is not ours.
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Writes (create, approve, stop) and the stream's WebSocket handshake must come from this
 * console's own pages. Browsers send Origin with them, and it must name the host the browser
 * connected to (the Host header, or X-Forwarded-Host behind a proxy). request.url is not
 * used: inside a container it is the server's bind address, not the published one. A page
 * cannot forge Origin or Host, and setting X-Forwarded-Host takes a CORS preflight, which
 * this route never approves (a WebSocket handshake cannot carry custom headers at all).
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true; // non-browser clients
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const hosts = [request.headers.get("x-forwarded-host"), request.headers.get("host")];
  return hosts.some((host) => host !== null && host.split(",")[0].trim() === originHost);
}

async function readBody(request: Request): Promise<string> {
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) throw new BodyTooLarge();
  return body;
}

class BodyTooLarge extends Error {}

function backendHeaders(request: Request, token: string | null): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return headers;
}

export async function forwardApiRequest(request: Request, path: string[], sessionToken: string | null): Promise<Response> {
  if (path.length === 3 && path[0] === "runs" && path[2] === "stream") {
    return Response.json(
      { detail: "The run stream is a WebSocket. Open it with an Upgrade request." },
      { status: 426, headers: { Upgrade: "websocket", "Cache-Control": "no-store" } },
    );
  }

  if (path.some((part) => !part || part === "." || part === ".." || /[\\/%?#\x00]/.test(part)) ||
      !API_PATH.test(path.join("/"))) {
    return Response.json({ detail: "API route not found" }, { status: 404 });
  }

  if (request.method !== "GET" && !isSameOrigin(request)) {
    return Response.json({ detail: "Cross-origin requests are not allowed" }, { status: 403 });
  }

  // Without a session the backend could only answer 401, so answer it here. FastAPI still
  // checks every token it receives (expired, revoked, another user's run).
  const isHealth = path[0] === "health";
  const token = isHealth ? null : sessionToken;
  if (!isHealth && token === null) {
    return Response.json({ detail: "Sign in to continue" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return Response.json({ detail: "Request body is too large" }, { status: 413 });
  }
  const headers = backendHeaders(request, token);

  try {
    const base = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:8000";
    const target = new URL(path.map(encodeURIComponent).join("/"), `${base.replace(/\/+$/, "")}/`);
    target.search = new URL(request.url).search;
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
      cache: "no-store",
      redirect: "manual",
    });

    const responseHeaders = new Headers({ "Cache-Control": "no-store" });
    const contentType = upstream.headers.get("content-type");
    if (contentType) responseHeaders.set("Content-Type", contentType);
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    if (error instanceof BodyTooLarge) return Response.json({ detail: "Request body is too large" }, { status: 413 });
    if (request.signal.aborted) throw error;
    return Response.json(
      { detail: "Could not reach the backend. Check that the backend service is running, then try again." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
