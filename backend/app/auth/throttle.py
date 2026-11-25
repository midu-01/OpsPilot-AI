"""Slow down password guessing by counting failed sign-ins over a sliding window.

Two limits apply: one per email (stops guessing one account's password) and one across all emails (slows
"password spraying": one common password tried against many accounts). The global cap is a trade-off: a flood of
failures pauses everyone's sign-in for up to one window; per-IP limits would need a trusted proxy that sets the
client IP, because the API only sees the console's server. The counters live in memory, which is
enough because the API runs as a single process (uvicorn --workers 1); they reset on restart, and several workers
or replicas would need a shared store such as Redis instead.
"""

import math
import time
from collections.abc import Callable

GLOBAL_MAX_FAILURES = 50


class LoginThrottle:
    """Remember when recent sign-ins failed, per key (the normalised email); the global cap counts all keys."""

    def __init__(
        self,
        max_failures: int = 5,
        window_seconds: int = 900,
        global_max_failures: int = GLOBAL_MAX_FAILURES,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.max_failures = max_failures
        self.window_seconds = window_seconds
        self.global_max_failures = global_max_failures
        self._clock = clock
        self._failures: dict[str, tuple[float, ...]] = {}

    def retry_after(self, key: str) -> int | None:
        """Whole seconds until `key` may try again (at least 1), or None when it may try now."""
        now = self._clock()
        everyone = tuple(sorted(moment for times in self._failures.values() for moment in times))
        waits = [
            wait
            for wait in (
                self._wait(self._failures.get(key, ()), self.max_failures, now),
                self._wait(everyone, self.global_max_failures, now),
            )
            if wait is not None
        ]
        if not waits:
            return None
        return max(1, math.ceil(max(waits)))

    def record_failure(self, key: str) -> None:
        now = self._clock()
        # Forget everything that has left the window, so memory only grows with recent failures.
        self._failures = {
            name: recent for name, times in self._failures.items() if (recent := self._recent(times, now))
        }
        self._failures[key] = (*self._failures.get(key, ()), now)

    def reset(self, key: str) -> None:
        """Forget a key's failures after a successful sign-in; they stop counting towards the global cap too."""
        self._failures.pop(key, None)

    def _recent(self, times: tuple[float, ...], now: float) -> tuple[float, ...]:
        return tuple(moment for moment in times if moment > now - self.window_seconds)

    def _wait(self, times: tuple[float, ...], limit: int, now: float) -> float | None:
        recent = self._recent(times, now)
        if len(recent) < limit:
            return None
        # Allowed again once enough failures have left the window to drop below the limit.
        return recent[-limit] + self.window_seconds - now
