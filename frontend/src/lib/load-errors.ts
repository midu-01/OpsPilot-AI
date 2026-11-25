import { ApiError } from "./api.ts";

/** GET /runs/{id} answers 404 for an unknown run and 422 for an id that is not a UUID. */
export function isMissingRunError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 422);
}

/** A short, user-facing reason why server-side data could not be loaded. */
export function describeLoadError(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "The backend did not respond in time.";
  }
  if (error instanceof ApiError) {
    return error.status === 0 ? "The backend could not be reached." : `The backend answered with HTTP ${error.status}.`;
  }
  return "The backend could not be reached.";
}
