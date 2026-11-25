"use client";

import "./globals.css";

/** Last-resort boundary for errors in the root layout itself; it replaces the whole document. */
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <body className="grid min-h-dvh place-items-center bg-bg font-sans text-fg">
        <div role="alert" className="max-w-md px-6 text-center">
          <h1 className="text-base font-semibold">OpsPilot could not start this page</h1>
          <p className="mt-1 text-sm text-muted">Reload the page. If it keeps failing, check the frontend logs.</p>
          <button
            type="button"
            onClick={() => retry()}
            className="mt-5 inline-flex h-9 items-center rounded-md bg-accent px-3.5 text-sm font-medium text-accent-fg"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
