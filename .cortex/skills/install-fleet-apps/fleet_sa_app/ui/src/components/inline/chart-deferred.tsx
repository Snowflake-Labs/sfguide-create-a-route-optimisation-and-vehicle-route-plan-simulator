'use client';

// Deferred loading boundary for the inline Vega charts.
//
// Same rationale as map-deferred.tsx: components/inline/index.ts is imported
// eagerly by the chat tree, so anything it references lands in the initial
// bundle whether or not the user ever asks a question that produces a chart.
// vega + vega-lite together are on the order of deck.gl, and most turns are
// prose or a table.
//
// The Suspense boundary lives here rather than at the call site because
// message-part.tsx renders a component looked up from the inline registry and
// cannot know which entries need one.

import { lazy, Suspense } from 'react';

/** Sized like a chart so the message does not reflow when the chunk lands. */
function ChartLoading({ height }: { height?: number }) {
  return (
    <div
      style={{
        width: '100%',
        height: height ?? 260,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--surface-2, #f4f5f7)',
        color: 'var(--text-secondary, #6b7280)',
        fontSize: 13,
        borderRadius: 6,
      }}
    >
      Loading chart...
    </div>
  );
}

const ChartInlineInner = lazy(() =>
  import('./chart-inline').then((m) => ({ default: m.ChartInline })),
);

export function ChartInlineDeferred(props: Record<string, unknown>) {
  const height = typeof props.height === 'number' ? props.height : undefined;
  return (
    <Suspense fallback={<ChartLoading height={height} />}>
      <ChartInlineInner {...props} />
    </Suspense>
  );
}
