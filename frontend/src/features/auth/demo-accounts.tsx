"use client";

import { UserRound } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";

/** The two seeded users. Their shared password is in the README; it is never rendered here. */
const DEMO_ACCOUNTS = [
  { email: "alex@opspilot.test", name: "Alex Rivera" },
  { email: "sam@opspilot.test", name: "Sam Chen" },
];

interface DemoAccountsProps {
  disabled: boolean;
  /** Fills the email field; the user still types the password. */
  onPick: (email: string) => void;
}

export function DemoAccounts({ disabled, onPick }: DemoAccountsProps) {
  return (
    <section aria-labelledby="demo-accounts-heading" className="rounded-lg border border-border bg-surface-2 p-4">
      <h2 id="demo-accounts-heading" className="text-sm font-semibold text-fg">
        Demo accounts
      </h2>
      <p className="mt-1 text-ui text-muted">
        Each account sees only its own runs. Pick one to fill in its email; the password is in the README.
      </p>
      <ul className="mt-3 space-y-2">
        {DEMO_ACCOUNTS.map((account) => (
          <li key={account.email}>
            <button
              type="button"
              onClick={() => onPick(account.email)}
              aria-disabled={disabled || undefined}
              className={buttonClasses("secondary", "md", "w-full justify-start")}
            >
              <UserRound aria-hidden className="text-muted" />
              <span>{account.name}</span>
              <span className="ml-auto truncate text-ui font-normal text-muted">{account.email}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
