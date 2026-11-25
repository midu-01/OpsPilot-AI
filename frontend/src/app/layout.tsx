import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { THEME_COOKIE, parseThemePreference } from "@/lib/theme";
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
 * Server Component: only what every page shares. Reading the theme cookie here lets the first
 * HTML byte carry the right theme, with no inline script. The header depends on the session,
 * so it is rendered by app/(console)/layout.tsx and app/login/layout.tsx instead: Next keeps
 * this layout across client-side navigations, so a header here would go stale.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = parseThemePreference((await cookies()).get(THEME_COOKIE)?.value);
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
        {children}
      </body>
    </html>
  );
}
