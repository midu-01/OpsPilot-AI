import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { safeNextPath } from "@/lib/auth";
import { LoginForm } from "@/features/auth/login-form";
import { getCurrentUser } from "@/server/session";

export const metadata: Metadata = { title: "Sign in" };

interface LoginPageProps {
  /** ?next= is where to go after signing in. It comes from the URL, so it is checked. */
  searchParams: Promise<{ next?: string | string[] }>;
}

/**
 * Server Component. It asks the backend who is signed in (GET /auth/me) instead of trusting
 * the cookie: with an expired or revoked cookie it must show the form, or the pages and
 * /login would keep redirecting to each other.
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const next = safeNextPath((await searchParams).next);
  if ((await getCurrentUser()).kind === "signed-in") redirect(next);

  return (
    <div className="mx-auto w-full max-w-sm py-2 sm:py-10">
      <section aria-labelledby="sign-in-heading" className="rounded-xl border border-border bg-surface p-5 shadow-sm sm:p-6">
        <h1 id="sign-in-heading" className="text-xl font-semibold tracking-tight text-fg">
          Sign in
        </h1>
        <p className="mt-1 text-sm text-muted">Start runs and review your run history. Each account sees only its own runs.</p>
        <div className="mt-5">
          <LoginForm next={next} />
        </div>
      </section>
    </div>
  );
}
