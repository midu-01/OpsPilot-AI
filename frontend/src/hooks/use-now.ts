import { useEffect, useState } from "react";

/**
 * The current time, updated every `intervalMs` while enabled; null while disabled
 * and during the server render, so server and client markup always match.
 */
export function useNow(intervalMs: number | null): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (intervalMs === null) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0); // start right away rather than after one interval
    const timer = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [intervalMs]);

  return intervalMs === null ? null : now;
}
