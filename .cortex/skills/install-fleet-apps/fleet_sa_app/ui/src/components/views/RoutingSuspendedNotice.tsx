'use client';

import { useEffect, useRef, useState } from 'react';
import { autoRetryDelayMs, type SuspendedInfo } from '@/lib/routing-suspend';

// First time a notice was shown for each region in this tab. Module scope on
// purpose: every retry refetches, the view shows its loading state, and this
// component unmounts - component state would restart the window on each
// attempt and retry forever. A notice after a long quiet gap starts a new
// episode.
const firstSeen = new Map<string, { first: number; last: number }>();
const NEW_EPISODE_GAP_MS = 15 * 60_000;

function episodeStart(region: string, now: number): number {
  const prev = firstSeen.get(region);
  const first = prev && now - prev.last < NEW_EPISODE_GAP_MS ? prev.first : now;
  firstSeen.set(region, { first, last: now });
  return first;
}

// Shared notice shown wherever a suspended routing engine is detected. The
// server has already triggered a resume by the time this renders, so the copy
// says so and offers a Retry once the region is ready (wait scales with region
// size). Uses the same info-banner tokens as the Emergency Response wizard.
interface RoutingSuspendedNoticeProps {
  info: SuspendedInfo;
  onRetry?: () => void;
  // Optional compact mode for small panels (metric cards / charts).
  compact?: boolean;
}

export function RoutingSuspendedNotice({ info, onRetry, compact }: RoutingSuspendedNoticeProps) {
  const [retrying, setRetrying] = useState(false);
  // A region with no ORS service at all is not "starting" - retrying will never
  // help, so drop the Retry affordance and say what is actually wrong.
  const notProvisioned = info.state === 'not_provisioned';
  // 'not_ready' means the service is RUNNING but did not answer in time (graph
  // still loading, or busy), so "starting" would be a false claim there.
  const heading = notProvisioned
    ? 'Routing engine not provisioned'
    : info.state === 'not_ready'
      ? 'Routing engine did not answer in time'
      : 'Routing engine is starting';
  const showRetry = !!onRetry && !notProvisioned;

  // Auto-retry: re-check on a timer while the engine is coming up, so the view
  // fills in on its own instead of waiting for a click.
  const [nextIn, setNextIn] = useState<number | null>(null);
  // Held in a ref, not the effect deps: callers pass inline lambdas, and the
  // countdown re-renders every second, so a dep would restart the timer on
  // every tick and it would never fire.
  const retryRef = useRef(onRetry);
  retryRef.current = onRetry;
  const canRetry = !!onRetry;
  useEffect(() => {
    if (!canRetry) return;
    const now = Date.now();
    const delay = autoRetryDelayMs(info.state, episodeStart(info.region, now), now);
    if (delay === null) { setNextIn(null); return; }
    const due = now + delay;
    setNextIn(Math.ceil(delay / 1000));
    // polling-gate: ui-only -- one-second countdown label; it issues no request.
    const tick = setInterval(() => setNextIn(Math.max(0, Math.ceil((due - Date.now()) / 1000))), 1000);
    // The re-check itself queries Snowflake and can resume an engine, so a
    // hidden tab defers it until the user comes back rather than keeping a
    // warehouse and a region awake for nobody.
    const onVisible = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', onVisible);
      retryRef.current?.();
    };
    const fire = setTimeout(() => {
      if (typeof document !== 'undefined' && document.hidden) {
        document.addEventListener('visibilitychange', onVisible);
        return;
      }
      retryRef.current?.();
    }, delay);
    return () => {
      clearInterval(tick);
      clearTimeout(fire);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [info.region, info.state, canRetry]);

  const handleRetry = async () => {
    if (!onRetry) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      // Leave a short guard so a double-click does not immediately re-fire while
      // the region is still starting.
      setTimeout(() => setRetrying(false), 1500);
    }
  };

  return (
    <div
      role="status"
      style={{
        margin: compact ? '8px' : '16px',
        padding: compact ? '10px 12px' : '14px 16px',
        borderRadius: '8px',
        backgroundColor: 'var(--surface-info, #eff6ff)',
        border: '1px solid var(--border-info, #bfdbfe)',
        color: 'var(--text-info, #1d4ed8)',
        fontSize: '13px',
        lineHeight: 1.5,
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
        <span aria-hidden style={{ fontSize: '15px', lineHeight: '20px' }}>{notProvisioned ? '\u26A0' : '\u23F3'}</span>
        <div>
          <div style={{ fontWeight: 600, marginBottom: '2px' }}>{heading}</div>
          <div>{info.message}</div>
          {nextIn !== null && (
            <div style={{ marginTop: '4px', opacity: 0.85 }}>
              This view checks again automatically{nextIn > 0 ? ` in ${nextIn}s` : '...'}.
            </div>
          )}
        </div>
      </div>
      {showRetry && (
        <div>
          <button
            type="button"
            onClick={handleRetry}
            disabled={retrying}
            style={{
              padding: '6px 14px',
              borderRadius: '6px',
              border: '1px solid var(--border-info, #bfdbfe)',
              backgroundColor: retrying ? 'var(--surface-secondary, #f3f4f6)' : 'var(--surface-primary, #ffffff)',
              color: 'var(--text-info, #1d4ed8)',
              fontSize: '13px',
              fontWeight: 600,
              cursor: retrying ? 'default' : 'pointer',
            }}
          >
            {retrying ? 'Retrying...' : 'Retry now'}
          </button>
        </div>
      )}
    </div>
  );
}
