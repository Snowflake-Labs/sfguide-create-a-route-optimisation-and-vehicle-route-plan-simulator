'use client';

import type { SuspendedInfo } from '@/lib/routing-suspend';

// One-line variant of RoutingSuspendedNotice for CONTROLS (filter dropdowns,
// combo boxes) where the full banner would break the layout and push the rest of
// the view around. Same contract: the server has already triggered the resume by
// the time this renders, so this only has to explain the empty control and offer
// a retry. Panels that own their own space should use RoutingSuspendedNotice.
interface RoutingSuspendedInlineHintProps {
  info: SuspendedInfo;
  onRetry?: () => void;
}

export function RoutingSuspendedInlineHint({ info, onRetry }: RoutingSuspendedInlineHintProps) {
  return (
    <div
      role="status"
      title={info.message}
      style={{
        marginTop: '4px',
        fontSize: '11px',
        lineHeight: 1.4,
        color: 'var(--text-info, #1d4ed8)',
      }}
    >
      Routing engine starting
      {onRetry && (
        <>
          {' - '}
          <button
            type="button"
            onClick={onRetry}
            style={{
              padding: 0,
              border: 'none',
              background: 'none',
              color: 'inherit',
              font: 'inherit',
              textDecoration: 'underline',
              cursor: 'pointer',
            }}
          >
            retry
          </button>
        </>
      )}
    </div>
  );
}
