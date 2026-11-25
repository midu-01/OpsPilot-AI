import "server-only"; // build error if a client component ever imports this file
import { cache } from "react";
import { connection } from "next/server";
import { getReadiness, getRun, listRuns, type PaginatedRuns, type Readiness, type RunSnapshot } from "@/lib/api";
import { describeLoadError, isMissingRunError, isUnauthorizedError } from "@/lib/load-errors";
import { authHeaders } from "./session";

/**
 * Server-only data loading for pages. Requests go straight to API_INTERNAL_URL (no
 * browser, no proxy) with the user's session as a bearer token. connection() marks each
 * page as per-request: it shows live data and must never be prerendered at build time.
 * Expected failures are returned as values, because production hides thrown server
 * error messages. "signed-out" (401) tells the page to send the user to sign in.
 */

const BACKEND_TIMEOUT_MS = 8000;

export type RunLoadResult =
  | { kind: "ok"; snapshot: RunSnapshot }
  | { kind: "not-found" }
  | { kind: "signed-out" }
  | { kind: "unavailable"; message: string };

/** `loadedAt` is the server clock when the data was read; relative times are computed from it. */
export type RunsLoadResult =
  | { kind: "ok"; page: PaginatedRuns; loadedAt: number }
  | { kind: "signed-out" }
  | { kind: "unavailable"; message: string };

/**
 * cache() lets generateMetadata and the page share one backend call per request. Another
 * user's run answers 404, exactly like a run that does not exist.
 */
export const loadRun = cache(async (id: string): Promise<RunLoadResult> => {
  await connection();
  try {
    const options = { headers: await authHeaders(), signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS) };
    return { kind: "ok", snapshot: await getRun(id, options) };
  } catch (error) {
    if (isUnauthorizedError(error)) return { kind: "signed-out" };
    return isMissingRunError(error) ? { kind: "not-found" } : { kind: "unavailable", message: describeLoadError(error) };
  }
});

/** The signed-in user's runs only: the backend filters GET /runs by owner. */
export async function loadRuns(page: number, pageSize: number): Promise<RunsLoadResult> {
  await connection();
  try {
    const options = { headers: await authHeaders(), signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS) };
    return { kind: "ok", page: await listRuns(page, pageSize, options), loadedAt: Date.now() };
  } catch (error) {
    return isUnauthorizedError(error) ? { kind: "signed-out" } : { kind: "unavailable", message: describeLoadError(error) };
  }
}

/** Public: GET /health/ready needs no session. */
export async function loadReadiness(): Promise<Readiness> {
  await connection();
  return getReadiness(process.env.API_INTERNAL_URL ?? "http://127.0.0.1:8000");
}
