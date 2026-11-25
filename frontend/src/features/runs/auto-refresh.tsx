"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { plural } from "@/lib/format";
import { usePageVisible } from "@/hooks/use-page-visible";

const REFRESH_INTERVAL_MS = 4000;

/**
 * Re-runs the server render of this page (router.refresh) every few seconds while any
 * listed run is unfinished. It pauses in background tabs and stops by itself once the
 * refreshed list has no unfinished runs.
 */
export function AutoRefresh({ unfinished }: { unfinished: number }) {
  const router = useRouter();
  const visible = usePageVisible();

  useEffect(() => {
    if (unfinished === 0 || !visible) return;
    const timer = setInterval(() => router.refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [unfinished, visible, router]);

  if (unfinished === 0) return null;
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted">
      <RefreshCw aria-hidden className={visible ? "size-3.5 motion-safe:animate-spin [animation-duration:2s]" : "size-3.5"} />
      {visible
        ? `Updating every ${REFRESH_INTERVAL_MS / 1000} s while ${plural(unfinished, "run")} ${unfinished === 1 ? "is" : "are"} in progress`
        : "Updates paused while this tab is hidden"}
    </p>
  );
}
