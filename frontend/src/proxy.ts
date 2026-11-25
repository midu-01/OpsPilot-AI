import { NextResponse, type NextRequest } from "next/server";
import { loginPath, readSessionToken, SESSION_COOKIE } from "@/lib/auth";

/**
 * Optimistic check before a page renders: without a session cookie the user goes straight
 * to /login?next=<this page> instead of seeing an empty console first. It only looks at
 * the cookie (no backend call on every request). FastAPI makes the real check on every
 * call, and a stale cookie is caught by the pages (GET /auth/me, or a 401 from a loader).
 *
 * Only page loads (GET, HEAD) are redirected. Server Actions are POSTs to the page they
 * were rendered on and do their own checks; redirecting them would break sign-out.
 */
export function proxy(request: NextRequest) {
  if (request.method !== "GET" && request.method !== "HEAD") return NextResponse.next();
  if (readSessionToken(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  return NextResponse.redirect(new URL(loginPath(pathname + search), request.nextUrl));
}

export const config = {
  // Every page except the sign-in page itself. /api answers 401 on its own; Next's assets
  // and files with an extension (favicon.ico, robots.txt) need no session.
  matcher: ["/((?!login(?:/|$)|api(?:/|$)|_next/|.*\\.[^/]+$).*)"],
};
