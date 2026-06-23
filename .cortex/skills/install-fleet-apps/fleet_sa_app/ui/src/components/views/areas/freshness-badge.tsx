'use client';

// Small "updated Ns ago" indicator for live views. Pass a fetchedAt epoch-ms
// (from useViewData). Re-renders on a 10s tick so the relative time stays current.

import { useEffect, useState } from 'react';

function relative(fetchedAt: number, now: number): string {
  const secs = Math.max(0, Math.round((now - fetchedAt) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h ago`;
}

export function FreshnessBadge({ fetchedAt }: { fetchedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  if (!fetchedAt) return null;
  const stale = now - fetchedAt > 5 * 60_000;
  return (
    <span
      title={`Data refreshed ${new Date(fetchedAt).toLocaleTimeString()}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        fontSize: '11px',
        fontWeight: 500,
        color: stale ? 'var(--text-warning, #b45309)' : 'var(--text-secondary, #6b7280)',
      }}
    >
      <span
        style={{
          width: '7px',
          height: '7px',
          borderRadius: '50%',
          backgroundColor: stale ? '#d97706' : '#16a34a',
          display: 'inline-block',
        }}
      />
      Updated {relative(fetchedAt, now)}
    </span>
  );
}
