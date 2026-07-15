'use client';

// Checkbox area (parity widget): a boolean toggle bound to a viewState key.
// On change it calls updateViewState({ [emitKey]: true|false }); any area whose
// params reference viewState.<key> refetches. Reproduces the control app's
// route-inspector toggles (show teleports / show detours) and the retail
// competitor / address-density toggles.

import { useEffect } from 'react';
import { useAppStore } from '@/lib/store';

interface ViewCheckboxAreaProps {
  areaConfig: {
    config?: {
      label?: string;
      default?: boolean;
    };
    emits?: Record<string, string>;
  };
}

export function ViewCheckboxArea({ areaConfig }: ViewCheckboxAreaProps) {
  const config = areaConfig.config ?? {};
  const emitKey = areaConfig.emits ? Object.keys(areaConfig.emits)[0] : null;

  const updateViewState = useAppStore((s) => s.updateViewState);
  const viewState = useAppStore((s) => s.panel.viewState);

  const current = emitKey && viewState[emitKey] != null ? Boolean(viewState[emitKey]) : Boolean(config.default);

  // Seed the default into viewState once so dependent queries have a value.
  useEffect(() => {
    if (emitKey && viewState[emitKey] == null && config.default != null) {
      updateViewState({ [emitKey]: config.default });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
      <input
        type="checkbox"
        id={emitKey ?? 'checkbox'}
        checked={current}
        onChange={(e) => emitKey && updateViewState({ [emitKey]: e.target.checked })}
        style={{ cursor: 'pointer', width: '16px', height: '16px' }}
      />
      <label
        htmlFor={emitKey ?? 'checkbox'}
        style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary, #6b7280)', cursor: 'pointer' }}
      >
        {config.label ?? 'Toggle'}
      </label>
    </div>
  );
}
