"use client";

import { useEffect, useState } from "react";
import { CircleCheck, LoaderCircle, TriangleAlert } from "lucide-react";
import { getApiBaseUrl, getReadiness, type Readiness } from "@/lib/api";
import { cx } from "@/lib/cx";
import { usePageVisible } from "@/hooks/use-page-visible";

const POLL_INTERVAL_MS = 30_000;

type Status = Readiness["status"] | "checking";

const LABELS: Record<Status, string> = {
  checking: "Checking backend",
  ready: "Backend ready",
  unavailable: "Backend unavailable",
  unreachable: "Backend unreachable",
};

/** Polls GET /api/health/ready (through the console's own proxy) while the tab is visible. */
export function BackendStatus() {
  const [status, setStatus] = useState<Status>("checking");
  const visible = usePageVisible();

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function check() {
      const readiness = await getReadiness(getApiBaseUrl(), controller.signal);
      if (controller.signal.aborted) return;
      setStatus(readiness.status);
      timer = setTimeout(check, POLL_INTERVAL_MS);
    }

    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [visible]);

  const Icon = status === "ready" ? CircleCheck : status === "checking" ? LoaderCircle : TriangleAlert;
  return (
    <div role="status" className="flex h-8 items-center gap-1.5 rounded-md px-2 text-ui text-muted">
      <Icon
        aria-hidden
        className={cx(
          "size-4",
          status === "ready" && "text-success",
          status === "checking" && "motion-safe:animate-spin",
          (status === "unavailable" || status === "unreachable") && "text-danger",
        )}
      />
      <span className="sr-only md:not-sr-only">{LABELS[status]}</span>
    </div>
  );
}
