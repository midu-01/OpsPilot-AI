import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

const NEAR_BOTTOM_PX = 120;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isNearBottom(): boolean {
  return document.documentElement.scrollHeight - window.innerHeight - window.scrollY < NEAR_BOTTOM_PX;
}

/**
 * Keeps the page pinned to the newest content while the user is at the bottom.
 * Scrolling up stops following (the UI then offers "Jump to latest"). It never moves
 * the page while focus is inside the content (someone is reading or typing there).
 */
export function useFollowScroll(content: RefObject<HTMLElement | null>, active: boolean) {
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(following);

  useEffect(() => {
    followingRef.current = following;
  }, [following]);

  useEffect(() => {
    if (!active) return;
    const onScroll = () => setFollowing(isNearBottom());
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [active]);

  useEffect(() => {
    const node = content.current;
    if (!active || !node) return;
    // Content grows as events arrive (new steps, streamed text, expanded cards).
    let first = true;
    const observer = new ResizeObserver(() => {
      if (first) {
        // The first callback reports the initial size: just record where the reader is.
        first = false;
        setFollowing(isNearBottom());
        return;
      }
      if (!followingRef.current || node.contains(document.activeElement)) return;
      window.scrollTo({ top: document.documentElement.scrollHeight });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [active, content]);

  const jumpToLatest = useCallback(() => {
    setFollowing(true);
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, []);

  return { following, jumpToLatest };
}

/** Scrolls an element into view and moves keyboard focus to it without a second jump. */
export function revealElement(id: string, focusId = id): void {
  document.getElementById(id)?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  document.getElementById(focusId)?.focus({ preventScroll: true });
}
