import "server-only"; // build error if a client component ever imports this file
import { cache } from "react";
import { cookies } from "next/headers";
import { getMe, type SessionUser } from "@/lib/api";
import { readSessionToken, SESSION_COOKIE } from "@/lib/auth";
import { isUnauthorizedError } from "@/lib/load-errors";

/**
 * The signed-in user, as seen by server code. The token lives in an HttpOnly cookie that
 * only the server reads; it is sent to FastAPI as a bearer token and never rendered.
 * FastAPI decides whether it is still valid (expired and revoked sessions answer 401).
 */

const ME_TIMEOUT_MS = 5000;

export type CurrentUser =
  | { kind: "signed-in"; user: SessionUser }
  | { kind: "signed-out" }
  | { kind: "unavailable" };

/** The session token from the cookie, or null when there is none. */
export async function getSessionToken(): Promise<string | null> {
  return readSessionToken((await cookies()).get(SESSION_COOKIE)?.value);
}

/** Headers for a backend call on the user's behalf. Empty when signed out: the backend then answers 401. */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Who is signed in, checked with GET /auth/me rather than trusted from the cookie, so a
 * stale cookie never counts as signed in. "unavailable" means the backend could not answer.
 * cache(): the layout and the page share one call per request.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser> => {
  const headers = await authHeaders();
  if (!headers.Authorization) return { kind: "signed-out" };
  try {
    return { kind: "signed-in", user: await getMe({ headers, signal: AbortSignal.timeout(ME_TIMEOUT_MS) }) };
  } catch (error) {
    return isUnauthorizedError(error) ? { kind: "signed-out" } : { kind: "unavailable" };
  }
});
