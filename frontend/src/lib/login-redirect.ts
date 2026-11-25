import { loginPath } from "./auth.ts";
import { isUnauthorizedError } from "./load-errors.ts";

/** The parts of window.location used here (a plain object in tests). */
export interface BrowserLocation {
  pathname: string;
  search: string;
  assign(url: string): void;
}

export interface LoginRedirect {
  /** Where to come back to after signing in. Default: this page. */
  next?: string;
  /** Default: window.location. */
  location?: BrowserLocation;
}

/**
 * Sends the browser to the sign-in page, which brings it back to `next` afterwards. A full
 * page load, not router.push(), so nothing from the old session stays in memory (client
 * state, the router's cache). The sign-in page has its own layout with the signed-out header.
 */
export function redirectToLogin({ next, location = window.location }: LoginRedirect = {}): void {
  location.assign(loginPath(next ?? location.pathname + location.search));
}

/**
 * For the browser's own calls (create run, approve or reject, stop, snapshot refresh): a 401
 * means the session ended, so retrying cannot help. Returns true when it redirected.
 */
export function redirectIfUnauthorized(error: unknown, options?: LoginRedirect): boolean {
  if (!isUnauthorizedError(error)) return false;
  redirectToLogin(options);
  return true;
}
