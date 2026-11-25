import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { THEME_COOKIE, parseThemePreference } from "@/lib/theme";
import type { CurrentUser } from "@/server/session";
import { AppHeader } from "./app-header";

/**
 * The header and the page's <main> (the skip link's target). Rendered by the console and
 * sign-in layouts and by the 404 page, never by the root layout: see app/(console)/layout.tsx.
 */
export async function PageShell({ session, children }: { session: CurrentUser; children: ReactNode }) {
  const theme = parseThemePreference((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <>
      <AppHeader theme={theme} session={session} />
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1400px] px-4 py-6 outline-none sm:px-6 sm:py-8">
        {children}
      </main>
    </>
  );
}
