'use client';

// Slider area (parity widget #1): a range input bound to a viewState key.
// On change it calls updateViewState({ [emitKey]: value }), so any area whose
// params reference viewState.<key> (e.g. a congestion map filtered by hour)
// refetches. Reproduces the control app's congestion hour-slider interaction.

import { useEffect } from 'react';
import { useAppStore } from '@/lib/store';

interface ViewSliderAreaProps {
  areaConfig: {
    config?: {
      label?: string;
      min?: number;
      max?: number;
      step?: number;
      default?: number;
    };
    emits?: Record<string, string>;
  };
}

export function ViewSliderArea({ areaConfig }: ViewSliderAreaProps) {
  const config = areaConfig.config ?? {};
  const min = config.min ?? 0;
  const max = config.max ?? 100;
  const step = config.step ?? 1;
  const emitKey = areaConfig.emits ? Object.keys(areaConfig.emits)[0] : null;

  const updateViewState = useAppStore((s) => s.updateViewState);
  const viewState = useAppStore((s) => s.panel.viewState);

  const current = emitKey && viewState[emitKey] != null ? Number(viewState[emitKey]) : (config.default ?? min);

  // Seed the default into viewState once so dependent queries have a value.
  useEffect(() => {
    if (emitKey && viewState[emitKey] == null && config.default != null) {
      updateViewState({ [emitKey]: config.default });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary, #6b7280)', textTransform: 'uppercase' }}>
          {config.label ?? 'Value'}
        </label>
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary, #111827)' }}>{current}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        onChange={(e) => emitKey && updateViewState({ [emitKey]: Number(e.target.value) })}
        style={{ width: '100%', cursor: 'pointer' }}
      />
    </div>
  );
}
