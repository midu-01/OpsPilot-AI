"use client";

import { useEffect, useState } from "react";
import { checkReadiness, getApiBaseUrl } from "../lib/api";

export default function BrowserConnection() {
  const [ready, setReady] = useState<boolean | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    checkReadiness(getApiBaseUrl(), controller.signal).then((connected) => {
      if (!controller.signal.aborted) setReady(connected);
    });
    return () => controller.abort();
  }, []);

  return (
    <dd aria-live="polite" className={ready === false ? "offline" : undefined}>
      {ready === null ? "Checking…" : ready ? "Connected" : "Unavailable"}
    </dd>
  );
}
