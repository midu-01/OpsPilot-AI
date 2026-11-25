import { cache } from "react";
import { connection } from "next/server";
import { getReadiness, getRun, listRuns, type PaginatedRuns, type Readiness, type RunSnapshot } from "@/lib/api";
import { describeLoadError, isMissingRunError } from "@/lib/load-errors";

/**
 * Server-only data loading for pages. Requests go straight to API_INTERNAL_URL (no
 * browser, no proxy). connection() marks each page as per-request: it shows live
 * data and must never be prerendered at build time. Expected failures are returned
 * as values, because production hides thrown server error messages.
 */

const BACKEND_TIMEOUT_MS = 8000;

export type RunLoadResult =
  | { kind: "ok"; snapshot: RunSnapshot }
  | { kind: "not-found" }
  | { kind: "unavailable"; message: string };

/** `loadedAt` is the server clock when the data was read; relative times are computed from it. */
export type RunsLoadResult =
  | { kind: "ok"; page: PaginatedRuns; loadedAt: number }
  | { kind: "unavailable"; message: string };

/** cache() lets generateMetadata and the page share one backend call per request. */
export const loadRun = cache(async (id: string): Promise<RunLoadResult> => {
  await connection();
  try {
    return { kind: "ok", snapshot: await getRun(id, { signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS) }) };
  } catch (error) {
    return isMissingRunError(error) ? { kind: "not-found" } : { kind: "unavailable", message: describeLoadError(error) };
  }
});

export async function loadRuns(page: number, pageSize: number): Promise<RunsLoadResult> {
  await connection();
  try {
    const runs = await listRuns(page, pageSize, { signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS) });
    return { kind: "ok", page: runs, loadedAt: Date.now() };
  } catch (error) {
    return { kind: "unavailable", message: describeLoadError(error) };
  }
}

export async function loadReadiness(): Promise<Readiness> {
  await connection();
  return getReadiness(process.env.API_INTERNAL_URL ?? "http://127.0.0.1:8000");
}
