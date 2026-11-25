import Link from "next/link";
import { Waypoints } from "lucide-react";
import type { ThemePreference } from "@/lib/theme";
import type { CurrentUser } from "@/server/session";
import { BackendStatus } from "./backend-status";
import { NavLinks } from "./nav-links";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";

interface AppHeaderProps {
  theme: ThemePreference;
  /** From getCurrentUser() in the layout. "unavailable": the backend could not say who is signed in. */
  session: CurrentUser;
}

/** Signed out (the sign-in page): brand and theme only. Otherwise navigation, status, theme and the user menu. */
export function AppHeader({ theme, session }: AppHeaderProps) {
  const signedOut = session.kind === "signed-out";
  return (
    <header className="sticky top-0 z-40 h-14 border-b border-border bg-bg">
      <div className="mx-auto flex h-full max-w-[1400px] items-center gap-2 px-4 sm:gap-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 rounded-md font-semibold tracking-tight text-fg">
          <span className="grid size-7 place-items-center rounded-md bg-fg text-bg">
            <Waypoints aria-hidden className="size-4" />
          </span>
          <span className="hidden sm:inline">OpsPilot</span>
          <span className="sr-only sm:hidden">OpsPilot home</span>
        </Link>
        {signedOut ? null : <NavLinks />}
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          {signedOut ? null : <BackendStatus />}
          <ThemeToggle initial={theme} />
          {session.kind === "signed-in" ? <UserMenu user={session.user} /> : null}
        </div>
      </div>
    </header>
  );
}
