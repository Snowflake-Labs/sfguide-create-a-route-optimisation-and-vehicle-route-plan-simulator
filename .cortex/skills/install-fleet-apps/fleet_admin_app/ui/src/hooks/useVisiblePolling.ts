import { useEffect, useRef } from 'react';

/**
 * Runs `cb` on an interval, but PAUSES while the browser tab is hidden
 * (document.hidden) to avoid pointless background polling of Snowflake when
 * nobody is looking. Fires an immediate `cb` when the tab becomes visible again
 * (or the window regains focus) so the UI is fresh on return. Cost hygiene
 * (Tier E).
 *
 * `cb` should be stable (wrap in useCallback) or the interval resets each render.
 *
 * `enabled` (default true) exists because most polling here is CONDITIONAL -
 * only while a build is running, only while a log panel is expanded, only while
 * a service is not yet ready. Without it, a caller had to write its own
 * `setInterval` to express that condition, and six of them did exactly that,
 * losing the visibility guard in the process. When `enabled` is false no
 * interval is created at all, so a conditional caller stops polling rather than
 * polling and discarding the result.
 *
 * The `focus` listener was duplicated inline in useStudioCatalog before living
 * here. Keep it in this one place: a hook plus a near-identical hand-rolled copy
 * is what made the convention look optional.
 */
export function useVisiblePolling(cb: () => void, intervalMs: number, enabled: boolean = true): void {
  const cbRef = useRef(cb);
  cbRef.current = cb;

  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer != null) return;
      timer = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return;
        cbRef.current();
      }, intervalMs);
    };
    const stop = () => {
      if (timer != null) { clearInterval(timer); timer = null; }
    };
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        stop();
      } else {
        cbRef.current();
        start();
      }
    };
    // Focus can fire while the tab was never `hidden` (e.g. returning from
    // another window on the same desktop), so refresh but do not restart the
    // timer - `start()` is a no-op when one is already running.
    const onFocus = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      cbRef.current();
      start();
    };

    start();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onFocus);
    }
    return () => {
      stop();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onFocus);
      }
    };
  }, [intervalMs, enabled]);
}
