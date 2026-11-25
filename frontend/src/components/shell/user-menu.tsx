import { ChevronDown, CircleUserRound } from "lucide-react";
import { signOut } from "@/app/login/actions";
import type { SessionUser } from "@/lib/api";
import { buttonClasses } from "@/components/ui/button";
import { SignOutButton } from "./sign-out-button";

const MENU_ID = "account-menu";

/**
 * Who is signed in, and Sign out. The panel is a native popover (the HTML `popover`
 * attribute): the browser opens and closes it, closes it on Escape or an outside click and
 * keeps the focus order, so it needs no client JavaScript. Sign out is a form that posts to
 * a Server Action, so it also works before JavaScript has loaded.
 */
export function UserMenu({ user }: { user: SessionUser }) {
  return (
    <>
      <button type="button" popoverTarget={MENU_ID} className={buttonClasses("ghost", "sm")}>
        <CircleUserRound aria-hidden />
        <span className="sr-only">Account: </span>
        <span className="sr-only max-w-40 truncate md:not-sr-only">{user.display_name}</span>
        <ChevronDown aria-hidden className="hidden md:block" />
      </button>
      {/* Fixed under the sticky header, aligned with the content's right edge (max width 1400px). */}
      <div
        id={MENU_ID}
        popover="auto"
        className="fixed inset-auto top-15 right-4 m-0 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface p-1 text-fg shadow-lg sm:right-[max(1.5rem,calc((100vw_-_1400px)/2_+_1.5rem))]"
      >
        <div className="px-2.5 py-2">
          <p className="text-xs text-muted">Signed in as</p>
          <p className="truncate text-sm font-medium">{user.display_name}</p>
          <p className="truncate text-ui text-muted">{user.email}</p>
        </div>
        <form action={signOut} className="border-t border-border pt-1">
          <SignOutButton />
        </form>
      </div>
    </>
  );
}
