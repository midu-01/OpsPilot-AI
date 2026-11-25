"use client";

import { useActionState, useEffect, useId, useRef, type MouseEvent } from "react";
import { LoaderCircle, LogIn } from "lucide-react";
import { signIn } from "@/app/login/actions";
import { INITIAL_SIGN_IN_STATE, type SignInField } from "@/lib/auth";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DemoAccounts } from "./demo-accounts";

const INPUT_CLASSES =
  "block h-10 w-full rounded-md border border-input-border bg-surface px-3 text-sm text-fg " +
  "read-only:opacity-70 aria-[invalid=true]:border-danger";

/**
 * Email and password, sent to the signIn Server Action through useActionState. It works
 * before JavaScript loads (the form posts natively), and with JavaScript the page does not
 * reload. A failed attempt shows a role="alert" message and moves focus to it.
 */
export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(signIn, INITIAL_SIGN_IN_STATE);
  const id = useId();
  const errorRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const errorId = `${id}-error`;

  // Every failed attempt has a new number, so the message is focused (and announced) again.
  useEffect(() => {
    if (state.attempt > 0) errorRef.current?.focus();
  }, [state.attempt]);

  function fieldProps(field: SignInField) {
    const invalid = state.error !== null && state.field === field;
    return { "aria-invalid": invalid || undefined, "aria-describedby": invalid ? errorId : undefined };
  }

  function pickDemoAccount(email: string) {
    if (pending || !emailRef.current) return;
    emailRef.current.value = email;
    passwordRef.current?.focus();
  }

  // aria-disabled keeps the button focusable while busy; this stops a second submission.
  function blockWhilePending(event: MouseEvent<HTMLButtonElement>) {
    if (pending) event.preventDefault();
  }

  return (
    <div className="space-y-6">
      <form action={formAction} noValidate className="space-y-4">
        {state.error ? (
          <div key={state.attempt} ref={errorRef} id={errorId} tabIndex={-1} className="rounded-lg">
            <Alert tone="danger" role="alert" title="Sign-in failed">
              {state.error}
            </Alert>
          </div>
        ) : null}
        <input type="hidden" name="next" value={next} />
        <div className="space-y-1.5">
          <label htmlFor={`${id}-email`} className="block text-sm font-medium text-fg">
            Email
          </label>
          <input
            ref={emailRef}
            id={`${id}-email`}
            name="email"
            type="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={254}
            defaultValue={state.email}
            readOnly={pending}
            className={INPUT_CLASSES}
            {...fieldProps("email")}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-password`} className="block text-sm font-medium text-fg">
            Password
          </label>
          <input
            ref={passwordRef}
            id={`${id}-password`}
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
            readOnly={pending}
            className={INPUT_CLASSES}
            {...fieldProps("password")}
          />
        </div>
        <Button type="submit" variant="primary" className="h-10 w-full" aria-disabled={pending || undefined} onClick={blockWhilePending}>
          {pending ? <LoaderCircle aria-hidden className="motion-safe:animate-spin" /> : <LogIn aria-hidden />}
          {pending ? "Signing in…" : "Sign in"}
        </Button>
        <p role="status" className="sr-only">
          {pending ? "Signing in…" : ""}
        </p>
      </form>
      <DemoAccounts disabled={pending} onPick={pickDemoAccount} />
    </div>
  );
}
