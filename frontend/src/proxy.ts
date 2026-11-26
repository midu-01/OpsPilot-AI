import { NextResponse, type NextRequest } from "next/server";
import { loginPath, readSessionToken, SESSION_COOKIE } from "@/lib/auth";
import { isRunStreamPath, routeRunStream } from "@/lib/stream-proxy";

/**
 * Two jobs, both before Next routes the request:
 *
 * 1. The live run stream. Its WebSocket handshake goes to FastAPI with the session cookie
 *    turned into a bearer token (lib/stream-proxy.ts). Next then pipes the socket through.
 *
 * 2. An optimistic check before a page renders: without a session cookie the user goes
 *    straight to /login?next=<this page> instead of seeing an empty console first. It only
 *    looks at the cookie (no backend call on every request). FastAPI makes the real check on
 *    every call, and a stale cookie is caught by the pages (GET /auth/me, or a 401 from a
 *    loader). Only page loads (GET, HEAD) are redirected. Server Actions are POSTs to the page
 *    they were rendered on and do their own checks; redirecting them would break sign-out.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const token = readSessionToken(request.cookies.get(SESSION_COOKIE)?.value);

  if (isRunStreamPath(pathname)) {
    const route = routeRunStream(request, token);
    // Refusing means passing the request on: Next closes an upgrade that reaches the /api
    // route, and that route answers a plain GET with 426.
    if (route.action === "refuse") return NextResponse.next();
    return NextResponse.rewrite(route.target, { request: { headers: route.headers } });
  }

  if (request.method !== "GET" && request.method !== "HEAD") return NextResponse.next();
  if (token) return NextResponse.next();
  return NextResponse.redirect(new URL(loginPath(pathname + search), request.nextUrl));
}

export const config = {
  // Every page except the sign-in page itself, and the run stream. The rest of /api answers
  // 401 on its own; Next's assets and files with an extension (favicon.ico, robots.txt) need
  // no session.
  matcher: ["/((?!login(?:/|$)|api(?:/|$)|_next/|.*\\.[^/]+$).*)", "/api/runs/:id/stream"],
};
