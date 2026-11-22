import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpsPilot AI | Agent Run Console",
  description: "Autonomous operations copilot with human-in-the-loop approval",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="app-header" role="banner">
          <Link href="/" className="brand" aria-label="OpsPilot AI Home">
            <span className="brand-mark" aria-hidden="true">O</span>
            <span>OpsPilot AI</span>
          </Link>
          <nav className="nav-links" aria-label="Main Navigation">
            <Link href="/" className="nav-link">
              New Run
            </Link>
            <Link href="/runs" className="nav-link">
              Runs History
            </Link>
          </nav>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}

