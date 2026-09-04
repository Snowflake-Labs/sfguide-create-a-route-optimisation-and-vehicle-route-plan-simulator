'use client';

// Slider area (parity widget #1): a range input bound to a viewState key.
// On change it calls updateViewState({ [emitKey]: value }), so any area whose
// params reference viewState.<key> (e.g. a congestion map filtered by hour)
// refetches. Reproduces the control app's congestion hour-slider interaction.
//
// Time-scrubber mode: config.format === 'hour' renders the value as HH:00 and
// config.format === 'time_of_day' treats the value as MINUTES SINCE MIDNIGHT and
// renders HH:MM, which is what a sub-hourly replay clock needs (a 10-minute step
// slider emitting 550 must read 09:10, not 550). config.play === true adds a
// play/pause that auto-advances (wrapping at max), turning either into an
// animated space-time scrubber. Auto-advance is SETTLE-GATED: it waits for every
// area's query to finish (store.inflight === 0) before stepping, so the panels
// stay in lockstep with the clock instead of lagging behind it.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/lib/store';

interface ViewSliderAreaProps {
  areaConfig: {
    config?: {
      label?: string;
      min?: number;
      max?: number;
      step?: number;
      default?: number;
      // SQL returning ONE row / ONE column: the initial value, resolved from the
      // DATA instead of assumed. A literal `default` encodes a wall-clock
      // assumption that silently does not hold: the delivery replay defaulted to
      // 540 (09:00), but the seeded SanFrancisco telemetry runs 14:00-05:00 UTC,
      // so 09:00 sits in an eight-hour hole with no pings at all. Every panel fed
      // by the live fleet-status call returned zero rows and the map opened blank,
      // on a dataset that is entirely healthy two hours either side. `default`
      // stays as the fallback when this is absent, empty or errors.
      defaultSource?: string;
      format?: string;        // 'hour' -> HH:00; 'time_of_day' -> HH:MM from minutes since midnight
      play?: boolean;         // show a play/pause auto-advance control
      playIntervalMs?: number; // MINIMUM ms per step when playing (default 1200);
                               // the loop also waits for all view queries to settle
      playMaxWaitMs?: number;  // ceiling on that wait before advancing anyway (default 8000)
      info?: string;          // explanatory text shown in a popover behind an "i" icon
    };
    emits?: Record<string, string>;
  };
}

function formatTick(value: number, format?: string): string {
  if (format === 'hour') return `${String(value).padStart(2, '0')}:00`;
  // Minutes since midnight -> HH:MM. Used by sub-hourly replay clocks.
  if (format === 'time_of_day') {
    const hours = Math.floor(value / 60);
    const minutes = Math.abs(value % 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
  return String(value);
}

/** Small "i" icon that toggles a popover explaining what the slider controls.
 *  The popover renders in a portal on document.body with fixed positioning so it
 *  is not clipped by the grid cell's overflow:hidden. */
function InfoPopover({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const WIDTH = 240;

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const left = Math.min(r.left, window.innerWidth - WIDTH - 8);
      setPos({ top: r.bottom + 6, left: Math.max(8, left) });
    }
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (panelRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onReposition = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('resize', onReposition);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-label="What is this?"
        title="What is this?"
        style={{
          width: '15px', height: '15px', borderRadius: '50%', padding: 0, marginLeft: '5px',
          border: '1px solid var(--border-default, #cbd5e1)',
          backgroundColor: open ? 'var(--text-secondary, #6b7280)' : 'var(--surface-primary, #fff)',
          color: open ? '#fff' : 'var(--text-secondary, #6b7280)',
          fontSize: '10px', fontWeight: 700, fontStyle: 'italic', lineHeight: '13px',
          cursor: 'pointer', flex: '0 0 auto',
        }}
      >
        i
      </button>
      {open && pos && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          role="tooltip"
          style={{
            position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999, width: `${WIDTH}px`,
            background: 'var(--surface-primary, #fff)', color: 'var(--text-primary, #111827)',
            border: '1px solid var(--border-default, #e5e7eb)', borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(15,23,42,0.18)', padding: '10px 12px',
            fontSize: '12px', fontWeight: 400, lineHeight: '1.45', textTransform: 'none',
            letterSpacing: 'normal', whiteSpace: 'normal',
          }}
        >
          {text}
        </div>,
        document.body,
      )}
    </>
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
  const context = useAppStore((s) => s.context);
  const [playing, setPlaying] = useState(false);

  const current = emitKey && viewState[emitKey] != null ? Number(viewState[emitKey]) : (config.default ?? min);

  // Seed the default into viewState once so dependent queries have a value.
  // With `defaultSource` the seed is resolved from the data first, falling back to
  // the literal `default` if the query is absent, errors, or returns nothing. The
  // resolved value is clamped to [min,max] and snapped to `step` so it is a
  // position the slider can actually represent.
  useEffect(() => {
    if (!emitKey || viewState[emitKey] != null) return;
    let cancelled = false;

    const seed = (value: number | null | undefined) => {
      if (cancelled) return;
      const fallback = config.default;
      const raw = value ?? fallback;
      if (raw == null) return;
      const clamped = Math.min(max, Math.max(min, Number(raw)));
      const snapped = min + Math.round((clamped - min) / step) * step;
      updateViewState({ [emitKey]: snapped });
    };

    if (!config.defaultSource) {
      seed(null);
      return;
    }

    (async () => {
      try {
        const res = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sql: config.defaultSource,
            params: { region: context.region ?? null },
            region: (context.region as string) ?? undefined,
          }),
        });
        if (!res.ok) return seed(null);
        const body = (await res.json()) as { rows?: Array<Record<string, unknown>> };
        const row = body.rows?.[0];
        const first = row ? Object.values(row)[0] : null;
        const num = first == null ? null : Number(first);
        seed(num == null || Number.isNaN(num) ? null : num);
      } catch {
        seed(null);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-advance loop for play mode. SETTLE-GATED rather than a blind timer:
  // it only steps once every dependent area has finished fetching for the
  // current value (store.inflight back to 0) AND a minimum frame time has
  // elapsed. A fixed timer outruns the data - one step of the delivery replay
  // fires 5 queries and the live ORS ETA alone averages about 1s - and because
  // useViewData aborts the previous request whenever params change, a fast timer
  // cancels each fetch before it lands and the KPIs never catch up.
  //
  // Two deliberate guards:
  //  - minFrame (config.playIntervalMs) is a FLOOR, not a period. It also stops
  //    a runaway: right after advancing, the dependent fetches have not
  //    registered yet, so inflight is momentarily 0 and an ungated check would
  //    advance again immediately.
  //  - maxWait caps how long the gate can hold. If a query is slow or wedged the
  //    loop advances anyway, degrading to timed advance instead of freezing
  //    playback with no escape but Pause.
  //
  // inflight is read via getState() inside the tick rather than subscribed, so
  // the loop's liveness does not depend on this component re-rendering.
  const currentRef = useRef(current);
  currentRef.current = current;
  useEffect(() => {
    if (!playing || !emitKey) return;
    const minFrameMs = config.playIntervalMs ?? 1200;
    const maxWaitMs = config.playMaxWaitMs ?? 8000;
    const TICK_MS = 120;
    let lastAdvanceAt = Date.now();

    const t = setInterval(() => {
      const since = Date.now() - lastAdvanceAt;
      if (since < minFrameMs) return;
      const settled = useAppStore.getState().inflight === 0;
      if (!settled && since < maxWaitMs) return;
      lastAdvanceAt = Date.now();
      const next = currentRef.current + step > max ? min : currentRef.current + step;
      updateViewState({ [emitKey]: next });
    }, TICK_MS);
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
