import Link from "next/link";
import { Waypoints } from "lucide-react";
import type { ThemePreference } from "@/lib/theme";
import { BackendStatus } from "./backend-status";
import { NavLinks } from "./nav-links";
import { ThemeToggle } from "./theme-toggle";

export function AppHeader({ theme }: { theme: ThemePreference }) {
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
        <NavLinks />
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <BackendStatus />
          <ThemeToggle initial={theme} />
        </div>
      </div>
    </header>
  );
}
