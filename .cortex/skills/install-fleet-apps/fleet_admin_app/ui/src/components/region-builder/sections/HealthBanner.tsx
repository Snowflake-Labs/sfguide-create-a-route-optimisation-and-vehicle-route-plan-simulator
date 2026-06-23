'use client';
// Yellow banner shown when /api/regions/healthcheck reports any failed
// component. Hidden when health is null (still loading) or "ok".

import type { HealthStatus } from '../types';

export default function HealthBanner({ health }: { health: HealthStatus | null }) {
  if (!health || health.overall === 'ok') return null;
  return (
    <div
      role="alert"
      className="warning-banner"
      style={{ marginBottom: '0.75rem' }}
    >
      <strong>Partial deploy detected.</strong>{' '}
      The following back-end pieces are missing or returned an error; the UI may be falling back to hardcoded defaults:
      <ul style={{ margin: '4px 0 0 16px', padding: 0, listStyle: 'disc' }}>
        {Object.entries(health.status)
          .filter(([, v]) => v !== 'ok')
          .map(([k, v]) => (
            <li key={k}>
              <code>{k}</code>: {v}
              {health.errors?.[k] ? ` - ${health.errors[k]}` : ''}
            </li>
          ))}
      </ul>
      <span style={{ fontSize: 11, opacity: 0.85 }}>
        Run <code>scripts/deploy.sh</code> to redeploy the SQL modules and image together.
      </span>
    </div>
  );
}
