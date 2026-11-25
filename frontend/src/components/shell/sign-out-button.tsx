"use client";

import type { MouseEvent } from "react";
import { useFormStatus } from "react-dom";
import { LoaderCircle, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The submit button of the sign-out form; useFormStatus shows that the request is under way. */
export function SignOutButton() {
  const { pending } = useFormStatus();

  function blockWhilePending(event: MouseEvent<HTMLButtonElement>) {
    if (pending) event.preventDefault();
  }

  return (
    <Button type="submit" variant="ghost" className="w-full justify-start" aria-disabled={pending || undefined} onClick={blockWhilePending}>
      {pending ? <LoaderCircle aria-hidden className="motion-safe:animate-spin" /> : <LogOut aria-hidden />}
      {pending ? "Signing out…" : "Sign out"}
    </Button>
  );
}
