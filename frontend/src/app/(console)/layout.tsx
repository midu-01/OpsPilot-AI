import type { ReactNode } from "react";
import { PageShell } from "@/components/shell/page-shell";
import { getCurrentUser } from "@/server/session";

/**
 * Layout of the console pages (/, /runs, /runs/[id]); /login has its own. The header shows
 * who is signed in, so it lives here and not in the root layout. Next keeps a layout across
 * client-side navigations, and a redirect to /login during one is a client-side navigation
 * too. Going between this group and /login always swaps the layout, so the header is
 * rendered again on the way into and out of sign-in. One GET /auth/me per request, shared
 * with the page through cache().
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  return <PageShell session={await getCurrentUser()}>{children}</PageShell>;
}
