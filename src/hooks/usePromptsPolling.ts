import { useEffect, useRef } from "react";

const POLL_INTERVAL_MS = 30_000;
const VISIBILITY_DEBOUNCE_MS = 5_000;

/**
 * Polls a callback every 30 seconds while the page is visible.
 *
 * Behavior:
 * - Skips fetches while the tab is hidden (no background load).
 * - On visibility change to visible: triggers an immediate fetch unless one
 *   already happened in the last 5s, then resets the interval so the next
 *   tick is 30s after this fetch (instead of finishing whatever the old
 *   interval had left).
 *
 * Replaces the previous Realtime websocket subscription. See
 * docs/specs/2026-05-06-security-refactor-design.md for context.
 */
export function usePromptsPolling(onTick: () => void) {
  const callbackRef = useRef(onTick);
  callbackRef.current = onTick;

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let lastFetchAt = 0;

    const tick = () => {
      if (document.visibilityState !== "visible") return;
      lastFetchAt = Date.now();
      callbackRef.current();
    };

    const startInterval = () => {
      if (intervalId) clearInterval(intervalId);
      intervalId = setInterval(tick, POLL_INTERVAL_MS);
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastFetchAt > VISIBILITY_DEBOUNCE_MS) tick();
      startInterval();
    };

    startInterval();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      if (intervalId) clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}
