'use client';

import type { ViewUnavailable } from '@/lib/types';
import { useAppStore } from '@/lib/store';

// Shown in place of a view whose data layer was never built. Its panels would
// each fail with "does not exist", and the view used to be hidden instead, so
// nobody could tell a missing layer from a missing feature. Same info-banner
// tokens as RoutingSuspendedNotice; the steps come from repair-map.json.
export function UnavailableViewNotice({ label, info }: { label: string; info: ViewUnavailable }) {
  const layer = info.label || info.schemas.join(', ');
  const region = useAppStore((s) => s.context.region);
  const steps = (info.fix ?? []).map((f) => f.replace('{region}', typeof region === 'string' && region ? region : '<region>'));
  return (
    <div
      role="status"
      style={{
        margin: '16px',
        padding: '14px 16px',
        borderRadius: '8px',
        backgroundColor: 'var(--surface-info, #eff6ff)',
        border: '1px solid var(--border-info, #bfdbfe)',
        color: 'var(--text-info, #1d4ed8)',
        fontSize: '13px',
        lineHeight: 1.5,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}
    >
      <div style={{ fontWeight: 600 }}>{label} is unavailable: its data layer is not built</div>
      <div>
        This view reads the {layer} layer, which does not exist in this account or returned no rows
        ({info.object}).{info.note ? ` ${info.note}` : ''}
      </div>
      {steps.length > 0 && (
        <div>
          <div style={{ marginBottom: '4px' }}>An operator can build it by running:</div>
          <pre
            style={{
              margin: 0,
              padding: '8px 10px',
              borderRadius: '6px',
              backgroundColor: 'var(--surface-primary, #ffffff)',
              color: 'var(--text-primary, #111827)',
              fontSize: '12px',
              whiteSpace: 'pre-wrap',
            }}
          >
            {steps.join('\n')}
          </pre>
          <div style={{ marginTop: '4px' }}>
            Or run scripts/validate_app_views.py -c &lt;connection&gt; --repair, then reload the app.
          </div>
        </div>
      )}
    </div>
  );
}
