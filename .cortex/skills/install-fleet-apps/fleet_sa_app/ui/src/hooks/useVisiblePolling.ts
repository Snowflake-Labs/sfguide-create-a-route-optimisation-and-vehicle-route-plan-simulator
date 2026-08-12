import { useEffect, useRef } from 'react';

/**
 * Runs `cb` on an interval, but PAUSES while the browser tab is hidden
 * (document.hidden) to avoid pointless background polling of Snowflake when
 * nobody is looking. Fires an immediate `cb` when the tab becomes visible again
 * so the UI is fresh on return. Cost hygiene (Tier E).
 *
 * `cb` should be stable (wrap in useCallback) or the interval resets each render.
 */
export function useVisiblePolling(cb: () => void, intervalMs: number): void {
  const cbRef = useRef(cb);
  cbRef.current = cb;

  useEffect(() => {
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

    start();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      stop();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [intervalMs]);
}
