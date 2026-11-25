"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { List, Plus, type LucideIcon } from "lucide-react";
import { cx } from "@/lib/cx";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  isActive: (pathname: string) => boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "New run", icon: Plus, isActive: (path) => path === "/" },
  { href: "/runs", label: "Runs", icon: List, isActive: (path) => path.startsWith("/runs") },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main">
      <ul className="flex items-center gap-1">
        {NAV_ITEMS.map(({ href, label, icon: Icon, isActive }) => {
          const active = isActive(pathname);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors",
                  active ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
                )}
              >
                <Icon aria-hidden className="size-4" />
                {/* Icon-only below sm, so the signed-in header fits a 320 px screen; the name stays for screen readers. */}
                <span className="sr-only sm:not-sr-only">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
