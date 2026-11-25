"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCw, ServerOff } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BackendUnavailableProps {
  title: string;
  message: string;
}

/** Shown when the backend cannot answer. Retry re-runs the server render of this page. */
export function BackendUnavailable({ title, message }: BackendUnavailableProps) {
  const router = useRouter();
  const [retrying, startTransition] = useTransition();

  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col items-center px-6 py-16 text-center">
      <span className="grid size-11 place-items-center rounded-full border border-danger-border bg-danger-soft text-danger">
        <ServerOff aria-hidden className="size-5" />
      </span>
      <h1 className="mt-4 text-base font-semibold text-fg">{title}</h1>
      <p className="mt-1 text-sm text-muted">{message} Check that the backend service is running, then retry.</p>
      <Button className="mt-5" onClick={() => startTransition(() => router.refresh())} disabled={retrying}>
        <RotateCw aria-hidden className={retrying ? "motion-safe:animate-spin" : undefined} />
        {retrying ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}
