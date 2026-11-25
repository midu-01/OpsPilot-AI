"use client";

import { useTransition } from "react";
import Link from "next/link";
import { RotateCw, TriangleAlert } from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/button";

interface RouteErrorProps {
  title: string;
  error: unknown;
  retry: () => void;
}

/**
 * Body of the error.tsx boundaries. In production Next.js replaces server error
 * messages with a generic one, so the text stays generic and shows the digest that
 * matches the server log.
 */
export function RouteError({ title, error, retry }: RouteErrorProps) {
  const [retrying, startTransition] = useTransition();
  const digest = error instanceof Error && "digest" in error && typeof error.digest === "string" ? error.digest : null;

  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col items-center px-6 py-16 text-center">
      <span className="grid size-11 place-items-center rounded-full border border-danger-border bg-danger-soft text-danger">
        <TriangleAlert aria-hidden className="size-5" />
      </span>
      <h1 className="mt-4 text-base font-semibold text-fg">{title}</h1>
      <p className="mt-1 text-sm text-muted">
        Something unexpected went wrong while showing this page. Retrying usually helps; if it keeps happening, check the
        frontend logs.
      </p>
      {digest ? <p className="mt-2 font-mono text-xs text-subtle">Error reference: {digest}</p> : null}
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button variant="primary" onClick={() => startTransition(retry)} disabled={retrying}>
          <RotateCw aria-hidden className={retrying ? "motion-safe:animate-spin" : undefined} />
          {retrying ? "Retrying…" : "Try again"}
        </Button>
        <Link href="/runs" className={buttonClasses("secondary")}>
          All runs
        </Link>
      </div>
    </div>
  );
}
