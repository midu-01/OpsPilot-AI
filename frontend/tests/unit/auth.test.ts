import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../../src/lib/api.ts";
import {
  INITIAL_SIGN_IN_STATE,
  composerReturnPath,
  isHttpsRequest,
  loginPath,
  parseSignInForm,
  readSessionToken,
  safeNextPath,
  sessionCookieOptions,
  failedSignIn,
  signInErrorMessage,
  type SignInState,
} from "../../src/lib/auth.ts";
import { redirectIfUnauthorized, redirectToLogin } from "../../src/lib/login-redirect.ts";

const TOKEN = "q3J6bF9xV0t1d2pQbm5LZ2J6U0lGZk1fQ3pYc0dRbE0";

test("safeNextPath keeps same-origin paths with their query", () => {
  assert.equal(safeNextPath("/runs"), "/runs");
  assert.equal(safeNextPath("/runs?page=2"), "/runs?page=2");
  assert.equal(safeNextPath("/runs/01234567-89ab-4cde-8fab-0123456789ab"), "/runs/01234567-89ab-4cde-8fab-0123456789ab");
  assert.equal(safeNextPath("/?goal=Find%20late%20orders"), "/?goal=Find%20late%20orders");
  assert.equal(safeNextPath("/runs/%E4%B8%AD"), "/runs/%E4%B8%AD");
  assert.equal(safeNextPath(["/runs", "/elsewhere"]), "/runs");
});

test("safeNextPath keeps the longest link the console builds, and /login?next= stays loadable", () => {
  // "Retry with this goal" links to /?goal= with up to 2000 characters.
  const retry = `/?${new URLSearchParams({ goal: "Refund $129.99, check the policy first. ".repeat(60).slice(0, 2000) })}`;
  assert.ok(retry.length > 2048, "the retry link is longer than the old limit");
  assert.equal(safeNextPath(retry), retry);
  // The longest accepted `next`, encoded again by loginPath, stays far below Node's 16 KB header limit.
  const longest = `/${"~".repeat(4095)}`;
  assert.equal(safeNextPath(longest), longest);
  assert.ok(loginPath(longest).length <= 12_300);
});

test("safeNextPath falls back to / for anything that could leave the site", () => {
  const hostile = [
    "//evil.com",
    "//evil.com/runs",
    "/\\evil.com",
    "\\\\evil.com",
    "https://evil.com",
    "http:evil.com",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,hi",
    "/%2F%2Fevil.com",
    "/%2f%2fevil.com",
    "/%5Cevil.com",
    "/%09/evil.com",
    " /runs",
    "/runs ",
    "\t//evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "/runs\u0000",
    "/runs%00",
    "/runs\\..\\..\\evil",
    "/%E0%A4%A",
    "runs",
    "evil.com",
    "",
    "/" + "a".repeat(5000),
  ];
  for (const raw of hostile) assert.equal(safeNextPath(raw), "/", `expected ${JSON.stringify(raw)} to be refused`);
});

test("safeNextPath refuses dot segments, which the browser resolves into another path", () => {
  // new URL("/.//evil.com", base).pathname is "//evil.com", which Next's router treats as another host.
  const dotted = [
    "/.//evil.com",
    "/%2e//evil.com",
    "/%2E//evil.com/phish",
    "/..//evil.com",
    "/a/..//evil.com",
    "/runs/..//evil.com",
    "/a/%2e%2e//evil.com",
    "/.%2e//evil.com",
    "/%2e%2e/%2fevil.com",
    "/./%2Fevil.com",
    "/./%5Cevil.com",
    "/runs/./abc",
  ];
  for (const raw of dotted) assert.equal(safeNextPath(raw), "/", `expected ${JSON.stringify(raw)} to be refused`);
});

test("safeNextPath accepts only printable ASCII, so the redirect always fits in a Location header", () => {
  // Next writes the redirect target into a header unencoded; Node refuses non-ASCII header values.
  assert.equal(safeNextPath("/中文"), "/");
  assert.equal(safeNextPath("/?goal=中文"), "/");
  assert.equal(safeNextPath("/runs#ü"), "/");
  // The console's own links are percent-encoded (location, URLSearchParams), so they pass.
  const prefilled = `/?${new URLSearchParams({ goal: "Prüfe die Bestellung 中文, then \"draft\" <one> email" })}`;
  assert.equal(safeNextPath(prefilled), prefilled);
  for (const raw of ["/中文", "/.//evil.com", "/runs?page=2", prefilled, "/a b", "/x\u007f"]) {
    assert.match(safeNextPath(raw), /^[\x21-\x7E]+$/, `${JSON.stringify(raw)} gave a value that cannot be a header`);
  }
});

test("safeNextPath never sends the browser back to the sign-in page", () => {
  const login = ["/login", "/login/", "/login?next=/runs", "/login#form", "/%6Cogin", "/login/../login"];
  for (const raw of [...login, "/runs/../login", "/./login", "/%2e/login", "/./%6Cogin"]) {
    assert.equal(safeNextPath(raw), "/", `expected ${raw} to be refused`);
  }
  assert.equal(safeNextPath("/loginhelp"), "/loginhelp");
});

test("safeNextPath ignores values that are not strings", () => {
  for (const raw of [undefined, null, 42, {}, [], [42], new Blob(["/runs"])]) assert.equal(safeNextPath(raw), "/");
});

test("loginPath carries a safe return path, and leaves out the default", () => {
  assert.equal(loginPath("/runs?page=2"), "/login?next=%2Fruns%3Fpage%3D2");
  assert.equal(loginPath("/runs/abc"), "/login?next=%2Fruns%2Fabc");
  assert.equal(loginPath("/"), "/login");
  assert.equal(loginPath("//evil.com"), "/login");
  assert.equal(loginPath("/login?next=/runs"), "/login");
});

test("the session cookie is HttpOnly, Lax, site-wide and lives exactly as long as the backend session", () => {
  const now = Date.parse("2026-11-25T10:00:00Z");
  assert.deepEqual(sessionCookieOptions({ expiresAt: "2026-11-25T22:00:00Z", secure: false, now }), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: false,
    maxAge: 12 * 60 * 60,
  });
  assert.equal(sessionCookieOptions({ expiresAt: "2026-11-25T22:00:00Z", secure: true, now }).secure, true);
  // A session that already ended (or a date that does not parse) gets a cookie that expires at once.
  assert.equal(sessionCookieOptions({ expiresAt: "2026-11-25T09:00:00Z", secure: false, now }).maxAge, 0);
  assert.equal(sessionCookieOptions({ expiresAt: "not a date", secure: false, now }).maxAge, 0);
});

test("isHttpsRequest reads the forwarded protocol or the Origin scheme", () => {
  const headers = (values: Record<string, string>) => new Headers(values);
  assert.equal(isHttpsRequest(headers({})), false);
  assert.equal(isHttpsRequest(headers({ "x-forwarded-proto": "https" })), true);
  assert.equal(isHttpsRequest(headers({ "x-forwarded-proto": "HTTPS, http" })), true);
  assert.equal(isHttpsRequest(headers({ "x-forwarded-proto": "http" })), false);
  assert.equal(isHttpsRequest(headers({ origin: "https://console.example.test" })), true);
  assert.equal(isHttpsRequest(headers({ origin: "http://127.0.0.1:13000" })), false);
  assert.equal(isHttpsRequest(headers({ origin: "null" })), false);
});

test("readSessionToken accepts only token-shaped values", () => {
  assert.equal(readSessionToken(TOKEN), TOKEN);
  for (const value of [undefined, null, "", "short", "has space in it but is long enough", "a\r\nInjected: yes".padEnd(40, "x"), "x".repeat(300)]) {
    assert.equal(readSessionToken(value), null, `expected ${JSON.stringify(value)} to be refused`);
  }
});

test("parseSignInForm normalises the email like the backend and checks both fields", () => {
  const form = (values: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(values)) data.set(key, value);
    return data;
  };
  assert.deepEqual(parseSignInForm(form({ email: "  Alex@OpsPilot.test ", password: " secret " })), {
    email: "alex@opspilot.test",
    password: " secret ",
    error: null,
    field: null,
  });
  assert.deepEqual(parseSignInForm(form({ email: "", password: "x" })), {
    email: "",
    password: "x",
    error: "Enter your email address.",
    field: "email",
  });
  assert.equal(parseSignInForm(form({ email: "alex", password: "x" })).field, "email");
  assert.equal(parseSignInForm(form({ email: `${"a".repeat(250)}@x.io`, password: "x" })).field, "email");
  assert.deepEqual(parseSignInForm(form({ email: "alex@opspilot.test", password: "" })).error, "Enter your password.");
  assert.equal(parseSignInForm(form({ email: "alex@opspilot.test", password: "p".repeat(129) })).field, "password");
  const withFile = new FormData();
  withFile.set("email", new Blob(["alex@opspilot.test"]));
  assert.equal(parseSignInForm(withFile).field, "email");
});

test("signInErrorMessage explains what went wrong without leaking backend details", () => {
  assert.equal(signInErrorMessage(new ApiError(401, "Request failed (401)", "Invalid email or password")), "The email or password is incorrect.");
  assert.equal(
    signInErrorMessage(new ApiError(429, "x", "Too many sign-in attempts. Try again in 15 minutes.")),
    "Too many sign-in attempts. Try again in 15 minutes.",
  );
  assert.equal(signInErrorMessage(new ApiError(429, "x", "<html>rate limited</html>")), "Too many sign-in attempts. Try again in a few minutes.");
  assert.equal(signInErrorMessage(new ApiError(429, "x")), "Too many sign-in attempts. Try again in a few minutes.");
  assert.match(signInErrorMessage(new ApiError(0, "x")), /could not reach the backend/i);
  assert.match(signInErrorMessage(new DOMException("slow", "TimeoutError")), /did not respond/i);
  assert.match(signInErrorMessage(new ApiError(503, "x", "internal detail")), /HTTP 503/);
  assert.doesNotMatch(signInErrorMessage(new ApiError(503, "x", "internal detail")), /internal detail/);
  assert.match(signInErrorMessage(new Error("boom")), /try again/i);
});

test("failedSignIn counts attempts, keeps the email and does not trust the client's previous state", () => {
  assert.deepEqual(failedSignIn("The email or password is incorrect.", null, "alex@opspilot.test", { ...INITIAL_SIGN_IN_STATE, attempt: 2 }), {
    error: "The email or password is incorrect.",
    field: null,
    email: "alex@opspilot.test",
    attempt: 3,
  });
  assert.equal(failedSignIn("x", "email", "a@b.c", INITIAL_SIGN_IN_STATE).attempt, 1);
  for (const forged of [null, {}, { attempt: "9" }, { attempt: Number.NaN }, { attempt: 1.5 }]) {
    assert.equal(failedSignIn("x", null, "a@b.c", forged as unknown as SignInState).attempt, 1);
  }
  assert.equal(failedSignIn("x", "email", "a".repeat(1000), INITIAL_SIGN_IN_STATE).email.length, 254);
});

test("a 401 sends the browser to sign in, then back to the same page", () => {
  const visited: string[] = [];
  const location = { pathname: "/runs/abc", search: "?tab=events", assign: (url: string) => visited.push(url) };
  assert.equal(redirectIfUnauthorized(new ApiError(401, "Sign in to continue"), { location }), true);
  assert.equal(redirectIfUnauthorized(new ApiError(409, "Already decided"), { location }), false);
  assert.equal(redirectIfUnauthorized(new TypeError("offline"), { location }), false);
  assert.deepEqual(visited, ["/login?next=%2Fruns%2Fabc%3Ftab%3Devents"]);
  redirectToLogin({ location: { pathname: "/", search: "", assign: (url: string) => visited.push(url) } });
  assert.equal(visited.at(-1), "/login");
});

test("a 401 in the composer comes back to the new-run page with the goal filled in", () => {
  const visited: string[] = [];
  const location = { pathname: "/", search: "", assign: (url: string) => visited.push(url) };
  const goal = "Find orders over $500 that shipped late,\nthen draft 50% refund emails";
  redirectIfUnauthorized(new ApiError(401, "Sign in to continue"), { next: composerReturnPath(goal), location });
  const next = new URL(visited[0], "http://console.test").searchParams.get("next") ?? "";
  // The new-run page reads ?goal= back into the composer; the line break became a space.
  assert.equal(new URL(next, "http://console.test").searchParams.get("goal"), goal.replace("\n", " "));
  assert.equal(composerReturnPath(""), "/");
  assert.equal(loginPath(composerReturnPath("Line one\r\n\tLine two")), `/login?${new URLSearchParams({ next: "/?goal=Line+one+Line+two" })}`);
});
