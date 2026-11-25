import { ApiError, SESSION_TOKEN } from "./api.ts";

/**
 * Sign-in helpers shared by proxy.ts, the /api proxy, the Server Actions and the pages.
 * Pure and React-free, so `node --test` covers them directly.
 *
 * The session is an opaque backend token kept in an HttpOnly cookie on the console's own
 * origin (backend-for-frontend). Browser JavaScript never sees it: server code reads the
 * cookie and sends `Authorization: Bearer <token>` to FastAPI, which makes the real check.
 */

/** The HttpOnly cookie that holds the backend session token. */
export const SESSION_COOKIE = "opspilot_session";

const LOGIN_PAGE = "/login";
const HOME = "/";
/**
 * Longer paths fall back to "/": sign-in still works, only the return trip is lost. The longest
 * link the console builds is "Retry with this goal" (/?goal= with up to 2000 characters, about
 * 2.2 KB of plain English once encoded). loginPath() encodes `next` again (up to 3 times longer)
 * and Node refuses request headers over 16 KB, so with 4096 /login?next=… always loads.
 */
const MAX_NEXT_LENGTH = 4096;
/** A path this console builds never contains whitespace, control characters or backslashes. */
const UNSAFE_IN_PATH = /[\s\p{Cc}\\]/u;
const PROBE_ORIGIN = "http://console.invalid";

function decodeOnce(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

function isSafeLocalPath(path: string): boolean {
  if (path.length > MAX_NEXT_LENGTH || !path.startsWith("/") || UNSAFE_IN_PATH.test(path)) return false;
  // "//host" and "/\host" are read as another host, also when a later step decodes "%2F" or "%5C" once.
  const decoded = decodeOnce(path);
  if (decoded === null || /^\/[/\\]/.test(decoded) || /\p{Cc}/u.test(decoded)) return false;
  // Only a path the URL parser leaves as it is: the browser and Next's router resolve "." and
  // ".." segments ("/.//evil.com" becomes "//evil.com", another host) and percent-encode
  // non-ASCII characters (Next writes the redirect into a header, which must be ASCII). The
  // paths this console builds are already in this form. This also keeps the origin.
  if (new URL(path, PROBE_ORIGIN).href !== PROBE_ORIGIN + path) return false;
  const pathname = decoded.split(/[?#]/, 1)[0];
  return pathname !== LOGIN_PAGE && !pathname.startsWith(`${LOGIN_PAGE}/`);
}

/**
 * Where to send the browser after signing in. `next` comes from the URL or a form field, so
 * it is untrusted: only a path on this site is accepted, and never the sign-in page itself
 * (that would loop). Anything else, including `//evil.com`, `/\evil.com`, `https://…`,
 * `javascript:`, dot segments and raw non-ASCII characters, becomes "/".
 */
export function safeNextPath(raw: unknown): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && isSafeLocalPath(value) ? value : HOME;
}

/** The sign-in page, with `next` so the user returns to `next` afterwards. */
export function loginPath(next: string): string {
  const target = safeNextPath(next);
  return target === HOME ? LOGIN_PAGE : `${LOGIN_PAGE}?${new URLSearchParams({ next: target })}`;
}

/**
 * The `next` that brings the user back to the new-run page with `goal` in the composer (the
 * page reads ?goal=). Line breaks become spaces: safeNextPath refuses control characters,
 * even percent-encoded ones. A goal too long for `next` is not restored.
 */
export function composerReturnPath(goal: string): string {
  return goal ? `/?${new URLSearchParams({ goal: goal.replace(/\s+/g, " ") })}` : HOME;
}

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  secure: boolean;
  maxAge: number;
}

/**
 * HttpOnly: page scripts cannot read the token. SameSite=Lax: other sites cannot make the
 * browser send it with their POSTs. Secure on HTTPS. Max-Age ends the cookie together with
 * the backend session.
 */
export function sessionCookieOptions(options: { expiresAt: string; secure: boolean; now: number }): SessionCookieOptions {
  const seconds = Math.floor((Date.parse(options.expiresAt) - options.now) / 1000);
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: options.secure,
    maxAge: Number.isFinite(seconds) ? Math.max(0, seconds) : 0,
  };
}

interface HeaderReader {
  get(name: string): string | null;
}

/** HTTPS as the browser sees it: a TLS proxy in front sets X-Forwarded-Proto, and POSTs carry Origin. */
export function isHttpsRequest(headers: HeaderReader): boolean {
  const forwarded = headers.get("x-forwarded-proto")?.split(",")[0].trim().toLowerCase();
  const origin = headers.get("origin")?.toLowerCase() ?? "";
  return forwarded === "https" || origin.startsWith("https://");
}

/** The token from the session cookie, or null when there is none or it is not token-shaped. */
export function readSessionToken(value: string | null | undefined): string | null {
  return value && SESSION_TOKEN.test(value) ? value : null;
}

export type SignInField = "email" | "password";

/** What the sign-in form shows after the Server Action ran (useActionState). */
export interface SignInState {
  /** Shown in the alert; null until an attempt fails. */
  error: string | null;
  /** The field the error is about, marked aria-invalid. */
  field: SignInField | null;
  /** Echoed back: React resets the form after an action, and the email should survive that. */
  email: string;
  /** Counts failed attempts, so a repeated error is announced and focused again. */
  attempt: number;
}

export const INITIAL_SIGN_IN_STATE: SignInState = { error: null, field: null, email: "", attempt: 0 };

export interface SignInInput {
  email: string;
  password: string;
  error: string | null;
  field: SignInField | null;
}

function signInProblem(email: string, password: string): { error: string; field: SignInField } | null {
  if (!email) return { error: "Enter your email address.", field: "email" };
  if (email.length < 3 || email.length > 254 || !email.includes("@")) {
    return { error: "Enter an email address like alex@opspilot.test.", field: "email" };
  }
  if (!password) return { error: "Enter your password.", field: "password" };
  if (password.length > 128) return { error: "A password has at most 128 characters.", field: "password" };
  return null;
}

/**
 * Reads the sign-in form with the backend's rules (LoginRequest): the email is trimmed and
 * lower-cased, 3 to 254 characters with an "@"; the password has 1 to 128 characters and is
 * never trimmed. Checking here saves a round trip and gives a precise message.
 */
export function parseSignInForm(form: { get(name: string): unknown }): SignInInput {
  const emailValue = form.get("email");
  const passwordValue = form.get("password");
  const email = typeof emailValue === "string" ? emailValue.trim().toLowerCase() : "";
  const password = typeof passwordValue === "string" ? passwordValue : "";
  const problem = signInProblem(email, password);
  return { email, password, error: problem?.error ?? null, field: problem?.field ?? null };
}

/** What to tell the user when POST /auth/login failed or could not be sent. */
export function signInErrorMessage(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "The backend did not respond in time. Try again in a moment.";
  }
  if (!(error instanceof ApiError)) return "Sign-in failed. Try again in a moment.";
  if (error.status === 401) return "The email or password is incorrect.";
  if (error.status === 429) {
    // The backend's message says how long to wait.
    return error.detail?.startsWith("Too many") ? error.detail : "Too many sign-in attempts. Try again in a few minutes.";
  }
  if (error.status === 0) return "Could not reach the backend. Check that it is running, then try again.";
  return `Sign-in failed: the backend answered with HTTP ${error.status}. Try again in a moment.`;
}

/**
 * The form state after a failed attempt. A Server Action's arguments come from the client,
 * so `previous` is not trusted, and the echoed email is capped.
 */
export function failedSignIn(error: string, field: SignInField | null, email: string, previous: SignInState): SignInState {
  const attempt = Number.isSafeInteger(previous?.attempt) ? previous.attempt + 1 : 1;
  return { error, field, email: email.slice(0, 254), attempt };
}
