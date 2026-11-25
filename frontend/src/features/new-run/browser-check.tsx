"use client";

import { useEffect, useState } from "react";
import { getApiBaseUrl, getReadiness, type Readiness } from "@/lib/api";
import { StatusDot } from "./status-dot";

/** Checks the browser's own path: browser -> /api proxy -> backend. */
export function BrowserCheck() {
  const [status, setStatus] = useState<Readiness["status"] | "checking">("checking");

  useEffect(() => {
    const controller = new AbortController();
    getReadiness(getApiBaseUrl(), controller.signal).then((result) => {
      if (!controller.signal.aborted) setStatus(result.status);
    });
    return () => controller.abort();
  }, []);

  if (status === "checking") return <StatusDot tone="neutral" label="Checking…" />;
  return status === "ready" ? <StatusDot tone="success" label="Connected" /> : <StatusDot tone="danger" label="Not reachable" />;
}
