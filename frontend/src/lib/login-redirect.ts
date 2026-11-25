import { loginPath } from "./auth.ts";
import { isUnauthorizedError } from "./load-errors.ts";

/** The parts of window.location used here (a plain object in tests). */
export interface BrowserLocation {
  pathname: string;
  search: string;
  assign(url: string): void;
}

/**
 * Sends the browser to the sign-in page, which brings it back here afterwards. A full page
 * load, not router.push(): the root layout renders again on the server, so the header shows
 * the signed-out state and nothing from the old session stays in memory.
 */
export function redirectToLogin(location: BrowserLocation = window.location): void {
  location.assign(loginPath(location.pathname + location.search));
}

/**
 * For the browser's own calls (create run, approve or reject, stop, snapshot refresh): a 401
 * means the session ended, so retrying cannot help. Returns true when it redirected.
 */
export function redirectIfUnauthorized(error: unknown, location?: BrowserLocation): boolean {
  if (!isUnauthorizedError(error)) return false;
  redirectToLogin(location);
  return true;
}
