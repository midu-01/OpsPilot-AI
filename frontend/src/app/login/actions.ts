"use server";

import { cookies, headers } from "next/headers";
import { redirect, RedirectType } from "next/navigation";
import { login, logout, type LoginResponse } from "@/lib/api";
import {
  failedSignIn,
  isHttpsRequest,
  parseSignInForm,
  safeNextPath,
  SESSION_COOKIE,
  sessionCookieOptions,
  signInErrorMessage,
  type SignInState,
} from "@/lib/auth";
import { authHeaders } from "@/server/session";

/**
 * Sign-in and sign-out run on the Next.js server (Server Actions), so the backend token goes
 * from FastAPI straight into an HttpOnly cookie and never reaches browser JavaScript.
 * A "use server" file may only export async functions; the helpers live in lib/auth.ts.
 */

const AUTH_TIMEOUT_MS = 8000;

/**
 * The sign-in form's action (useActionState). Checks the form, asks FastAPI, stores the token
 * in the cookie and goes to `next`. Failures come back as state for the form to show. Without
 * JavaScript the form posts natively and the page renders the same state.
 */
export async function signIn(previous: SignInState, formData: FormData): Promise<SignInState> {
  const form = parseSignInForm(formData);
  if (form.error) return failedSignIn(form.error, form.field, form.email, previous);

  let session: LoginResponse;
  try {
    session = await login(form.email, form.password, { signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) });
  } catch (error) {
    return failedSignIn(signInErrorMessage(error), null, form.email, previous);
  }

  const secure = isHttpsRequest(await headers());
  const options = sessionCookieOptions({ expiresAt: session.expires_at, secure, now: Date.now() });
  (await cookies()).set(SESSION_COOKIE, session.access_token, options);
  // redirect() throws to end the action, so it stays outside the try block. `next` is
  // untrusted form input: safeNextPath keeps it on this site.
  redirect(safeNextPath(formData.get("next")), RedirectType.replace);
}

/** Revokes the session on the backend, deletes the cookie and goes to the sign-in page. */
export async function signOut(): Promise<void> {
  const auth = await authHeaders();
  if (auth.Authorization) {
    // The cookie is deleted either way, and a session the backend could not revoke still
    // expires on its own, so a failure here must not keep the user signed in.
    await logout({ headers: auth, signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) }).catch(() => undefined);
  }
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login", RedirectType.replace);
}
