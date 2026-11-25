import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { AppHeader } from "@/components/shell/app-header";
import { THEME_COOKIE, parseThemePreference } from "@/lib/theme";
import { getCurrentUser } from "@/server/session";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "OpsPilot", template: "%s · OpsPilot" },
  description: "Agent run console: watch an operations agent work and approve risky actions.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0b" },
  ],
};

/**
 * Server Component. Reading the theme cookie here lets the first HTML byte carry the
 * right theme, with no inline script. The header shows who is signed in (one GET /auth/me
 * per request, shared with the page through cache()). Every page renders per request
 * anyway, because each one shows live backend data.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const [cookieStore, session] = await Promise.all([cookies(), getCurrentUser()]);
  const theme = parseThemePreference(cookieStore.get(THEME_COOKIE)?.value);
  return (
    <html
      lang="en"
      data-theme={theme === "system" ? undefined : theme}
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body className="min-h-dvh bg-bg font-sans text-fg antialiased">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <AppHeader theme={theme} session={session} />
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1400px] px-4 py-6 outline-none sm:px-6 sm:py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
