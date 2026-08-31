'use client';

import { useState } from 'react';
import type { SuspendedInfo } from '@/lib/routing-suspend';

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
  const heading = notProvisioned ? 'Routing engine not provisioned' : 'Routing engine is starting';
  const showRetry = !!onRetry && !notProvisioned;

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
