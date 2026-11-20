"use client";

import { useEffect, useState } from "react";
import { checkReadiness } from "../lib/api";

export default function BrowserConnection({ apiOrigin }: { apiOrigin: string }) {
  const [ready, setReady] = useState<boolean | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    checkReadiness(apiOrigin, controller.signal).then((connected) => {
      if (!controller.signal.aborted) setReady(connected);
    });
    return () => controller.abort();
  }, [apiOrigin]);

  return (
    <dd aria-live="polite" className={ready === false ? "offline" : undefined}>
      {ready === null ? "Checking…" : ready ? "Connected" : "Unavailable"}
    </dd>
  );
}
