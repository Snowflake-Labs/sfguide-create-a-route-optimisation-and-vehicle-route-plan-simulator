'use client';

import { Suspense, Component, type ReactNode } from 'react';
import { useAppStore } from '@/lib/store';
import { viewRegistry } from '@/lib/view-registry';
import { ViewPicker } from './view-picker';

class ViewErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-error, #dc2626)' }}>
          <p style={{ fontWeight: 600 }}>Something went wrong loading this view.</p>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary, #6b7280)' }}>{this.state.error?.message}</p>
          <button onClick={() => this.setState({ hasError: false, error: null })} style={{ marginTop: '12px', padding: '6px 12px', border: '1px solid var(--border-default, #e5e7eb)', borderRadius: '6px', cursor: 'pointer', background: 'none' }}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function ViewPanel() {
  const activeViewId = useAppStore((s) => s.panel.activeViewId);
  const viewState = useAppStore((s) => s.panel.viewState);
  const updateViewState = useAppStore((s) => s.updateViewState);
  const setDirty = useAppStore((s) => s.setDirty);

  const viewDef = activeViewId ? viewRegistry.get(activeViewId) : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '12px 16px', borderBottom: '1px solid var(--border-default, #e5e7eb)' }}>
        <ViewPicker />
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {viewDef ? (
          <ViewErrorBoundary>
            <Suspense fallback={<ViewSkeleton />}>
              <viewDef.component
                viewState={viewState}
                onStateChange={(patch) => updateViewState(patch)}
                onSave={() => setDirty(false)}
                onDirty={setDirty}
              />
            </Suspense>
          </ViewErrorBoundary>
        ) : (
          <EmptyPanelState />
        )}
      </div>
    </div>
  );
}

function EmptyPanelState() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: '48px 32px',
        textAlign: 'center',
        color: 'var(--text-secondary, #6b7280)',
      }}
    >
      <div style={{ fontSize: '48px', marginBottom: '16px', opacity: 0.3 }}>📊</div>
      <h3 style={{ margin: '0 0 8px', fontSize: '16px', fontWeight: 600, color: 'var(--text-primary, #111827)' }}>
        Select a view
      </h3>
      <p style={{ margin: 0, fontSize: '14px', maxWidth: '320px', lineHeight: '1.5' }}>
        Use the picker above to open a view.
      </p>
    </div>
  );
}

function ViewSkeleton() {
  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            height: i === 1 ? '40px' : '120px',
            borderRadius: '8px',
            backgroundColor: 'var(--surface-secondary, #f3f4f6)',
            animation: 'pulse 2s ease-in-out infinite',
          }}
        />
      ))}
    </div>
  );
}
