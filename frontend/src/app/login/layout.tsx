import type { ReactNode } from "react";
import { PageShell } from "@/components/shell/page-shell";

/**
 * The sign-in page always shows the signed-out header (brand and theme). It needs no
 * GET /auth/me here: the page itself sends a signed-in user on to `next`.
 */
export default function LoginLayout({ children }: { children: ReactNode }) {
  return <PageShell session={{ kind: "signed-out" }}>{children}</PageShell>;
}
