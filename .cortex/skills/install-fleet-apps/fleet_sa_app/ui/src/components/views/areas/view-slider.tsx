'use client';

// Slider area (parity widget #1): a range input bound to a viewState key.
// On change it calls updateViewState({ [emitKey]: value }), so any area whose
// params reference viewState.<key> (e.g. a congestion map filtered by hour)
// refetches. Reproduces the control app's congestion hour-slider interaction.
//
// Time-scrubber mode: config.format === 'hour' renders the value as HH:00 and
// config.play === true adds a play/pause that auto-advances (wrapping at max),
// turning the hour slider into an animated space-time scrubber.

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/lib/store';

interface ViewSliderAreaProps {
  areaConfig: {
    config?: {
      label?: string;
      min?: number;
      max?: number;
      step?: number;
      default?: number;
      format?: string;        // 'hour' -> render value as HH:00
      play?: boolean;         // show a play/pause auto-advance control
      playIntervalMs?: number; // ms per step when playing (default 1200)
      info?: string;          // explanatory text shown in a popover behind an "i" icon
    };
    emits?: Record<string, string>;
  };
}

function formatTick(value: number, format?: string): string {
  if (format === 'hour') return `${String(value).padStart(2, '0')}:00`;
  return String(value);
}

/** Small "i" icon that toggles a popover explaining what the slider controls. */
function InfoPopover({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex', marginLeft: '5px' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="What is this?"
        title="What is this?"
        style={{
          width: '15px', height: '15px', borderRadius: '50%', padding: 0,
          border: '1px solid var(--border-default, #cbd5e1)',
          backgroundColor: open ? 'var(--text-secondary, #6b7280)' : 'var(--surface-primary, #fff)',
          color: open ? '#fff' : 'var(--text-secondary, #6b7280)',
          fontSize: '10px', fontWeight: 700, fontStyle: 'italic', lineHeight: '13px',
          cursor: 'pointer', flex: '0 0 auto',
        }}
      >
        i
      </button>
      {open && (
        <div
          role="tooltip"
          style={{
            position: 'absolute', top: '20px', left: 0, zIndex: 20, width: '240px',
            background: 'var(--surface-primary, #fff)', color: 'var(--text-primary, #111827)',
            border: '1px solid var(--border-default, #e5e7eb)', borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(15,23,42,0.18)', padding: '10px 12px',
            fontSize: '12px', fontWeight: 400, lineHeight: '1.45', textTransform: 'none',
            letterSpacing: 'normal', whiteSpace: 'normal',
          }}
        >
          {text}
        </div>
      )}
    </span>
  );
}

export function ViewSliderArea({ areaConfig }: ViewSliderAreaProps) {
  const config = areaConfig.config ?? {};
  const min = config.min ?? 0;
  const max = config.max ?? 100;
  const step = config.step ?? 1;
  const emitKey = areaConfig.emits ? Object.keys(areaConfig.emits)[0] : null;

  const updateViewState = useAppStore((s) => s.updateViewState);
  const viewState = useAppStore((s) => s.panel.viewState);
  const [playing, setPlaying] = useState(false);

  const current = emitKey && viewState[emitKey] != null ? Number(viewState[emitKey]) : (config.default ?? min);

  // Seed the default into viewState once so dependent queries have a value.
  useEffect(() => {
    if (emitKey && viewState[emitKey] == null && config.default != null) {
      updateViewState({ [emitKey]: config.default });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-advance loop for play mode. Reads the latest value from the store each
  // tick and wraps from max back to min.
  const currentRef = useRef(current);
  currentRef.current = current;
  useEffect(() => {
    if (!playing || !emitKey) return;
    const interval = config.playIntervalMs ?? 1200;
    const t = setInterval(() => {
      const next = currentRef.current + step > max ? min : currentRef.current + step;
      updateViewState({ [emitKey]: next });
    }, interval);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, emitKey, step, min, max]);

  return (
    <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary, #6b7280)', textTransform: 'uppercase' }}>
          {config.label ?? 'Value'}
          {config.info && <InfoPopover text={config.info} />}
        </label>
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary, #111827)' }}>{formatTick(current, config.format)}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {config.play && emitKey && (
          <button
            onClick={() => setPlaying((p) => !p)}
            title={playing ? 'Pause' : 'Play'}
            aria-label={playing ? 'Pause' : 'Play'}
            style={{
              flexShrink: 0,
              width: '26px',
              height: '26px',
              borderRadius: '6px',
              border: '1px solid var(--border-default, #e5e7eb)',
              backgroundColor: 'var(--surface-primary, #fff)',
              cursor: 'pointer',
              color: 'var(--text-primary, #111827)',
              fontSize: '12px',
            }}
          >
            {playing ? '❚❚' : '▶'}
          </button>
        )}
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
    </div>
  );
}
