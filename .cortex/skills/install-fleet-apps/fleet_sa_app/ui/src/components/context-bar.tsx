'use client';

import { useAppStore } from '@/lib/store';
import { useEffect, useState, useRef, useCallback } from 'react';

const DATE_PRESETS = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 6 months', days: 180 },
  { label: 'Last 12 months', days: 365 },
];

// Bounds of the data actually present for the selected region, resolved at
// runtime from the field's `boundsSource`, so the control offers the real
// interval instead of a wall-clock window that may sit outside the data.
interface DateBounds {
  min: string;
  max: string;
}

// Fallback bounds query for a stage-mounted app-config.json that predates the
// `boundsSource` field (config-driven first, literal as fallback only). Spans
// both facts the views filter on, so the offered range is never narrower than
// what a view can render. Formatted as text on purpose: a bare DATE crosses the
// SQL REST API as days-since-epoch, so TO_VARCHAR keeps it correct even against
// an image whose /api/query lacks the `date` branch.
const DEFAULT_BOUNDS_SOURCE =
  "SELECT TO_VARCHAR(MIN(d)::DATE, 'YYYY-MM-DD') AS min_date, TO_VARCHAR(MAX(d)::DATE, 'YYYY-MM-DD') AS max_date FROM (" +
  'SELECT TRIP_START::DATE AS d FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_TRIPS_CURRENT WHERE REGION = :region ' +
  'UNION ALL ' +
  'SELECT SERVICE_DATE AS d FROM FLEET_APP.DELIVERY_SYNC.VW_SITE_VISITS WHERE REGION = :region)';

// Coerce a bounds value to YYYY-MM-DD. Accepts an ISO/date-only string and also
// a bare days-since-epoch number, which is how the SQL REST API serializes a
// DATE column - so a stale stage config returning a raw DATE still renders as a
// date rather than "20666".
function normalizeDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d+$/.test(s)) {
    const d = new Date(Number(s) * 86400000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  return null;
}

function addDays(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().split('T')[0];
}

function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function clampDate(value: string, bounds: DateBounds | null): string {
  if (!bounds) return value;
  if (value < bounds.min) return bounds.min;
  if (value > bounds.max) return bounds.max;
  return value;
}

function getDateLabel(value: unknown, endValue?: unknown, bounds?: DateBounds | null): string {
  if (!value) return 'All time';
  const dateStr = String(value);
  if (endValue) {
    const endStr = String(endValue);
    if (bounds && dateStr === bounds.min && endStr === bounds.max) {
      return `Full range: ${dateStr} \u2192 ${endStr}`;
    }
    return `${dateStr} \u2192 ${endStr}`;
  }
  // Anchor a relative label on the newest data date when known, not on today.
  const anchor = bounds ? new Date(`${bounds.max}T00:00:00Z`) : new Date();
  const target = new Date(dateStr);
  const diffDays = Math.round((anchor.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));
  const match = DATE_PRESETS.find((p) => Math.abs(p.days - diffDays) < 3);
  if (match) return match.label;
  return `Since ${dateStr}`;
}

export interface ContextBarField {
  id: string;
  type: string;
  label?: string;
  default?: string;
  configColumn?: string;
  options?: Array<{ value: string; label: string }>;
  // Optional read-only SELECT returning (value, label) rows to populate an enum
  // dynamically. When present, the enum lists ONLY what the query returns (e.g.
  // installed regions from DIM_DATASETS) and `options` is the static fallback
  // used while loading or if the query yields nothing.
  source?: string;
  // Optional read-only SELECT for a `date_range` field returning ONE row
  // (min_date, max_date) bound on :region - the interval for which data exists.
  boundsSource?: string;
}

const selectStyle: React.CSSProperties = {
  fontSize: '13px',
  padding: '3px 8px',
  borderRadius: '6px',
  border: '1px solid var(--border-default, #e5e7eb)',
  backgroundColor: 'var(--surface-primary, #fff)',
  color: 'var(--text-primary, #111827)',
  cursor: 'pointer',
};

const labelStyle: React.CSSProperties = {
  fontSize: '12px',
  fontWeight: 500,
  color: 'var(--text-secondary, #6b7280)',
};

interface DatasetOption {
  dataset_id: string;
  label: string;
  is_active: boolean;
  vehicle_type: string;
  region: string;
}

// Dynamic dataset picker (R2.2). Lists ALL datasets from DIM_DATASETS and
// writes the chosen DATASET_ID into store context.dataset_id. The dataset is
// the source of truth for REGION and VEHICLE_TYPE - selecting a dataset auto-
// syncs both values into context so all 30+ dashboard queries binding :region
// and :vehicle_type stay consistent.
function DatasetPicker({ field }: { field: ContextBarField }) {
  const current = useAppStore((s) => s.context[field.id]) as string | undefined;
  const setContext = useAppStore((s) => s.setContext);
  const [options, setOptions] = useState<DatasetOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sql:
              'SELECT d.DATASET_ID AS dataset_id, d.LABEL AS label, d.IS_ACTIVE AS is_active, ' +
              'd.VEHICLE_TYPE AS vehicle_type, d.REGION AS region ' +
              'FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS d ' +
              'LEFT JOIN FLEET_INTELLIGENCE.CORE.GENERATION_JOBS j ON j.JOB_ID = d.DATASET_ID ' +
              'WHERE COALESCE(j.STATUS, \'COMPLETED\') NOT IN (\'DELETED\', \'CANCELLED\') ' +
              'ORDER BY d.IS_ACTIVE DESC, d.CREATED_AT DESC',
          }),
        });
        if (!res.ok) return;
        const body = (await res.json()) as { rows?: DatasetOption[] };
        const rows = body.rows ?? [];
        if (cancelled) return;
        setOptions(rows);
        const ids = new Set(rows.map((r) => r.dataset_id));
        if (!current || !ids.has(current)) {
          const active = rows.find((r) => r.is_active) ?? rows[0];
          setContext(field.id, active ? active.dataset_id : null);
          if (active?.vehicle_type) setContext('vehicle_type', active.vehicle_type);
          if (active?.region) setContext('region', active.region);
        } else {
          const sel = rows.find((r) => r.dataset_id === current);
          if (sel?.vehicle_type) setContext('vehicle_type', sel.vehicle_type);
          if (sel?.region) setContext('region', sel.region);
        }
      } catch {
        /* non-fatal: dashboards fall back to the active dataset when dataset_id is null */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (options.length === 0) return null;

  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <span style={labelStyle}>{field.label ?? 'Dataset'}</span>
      <select
        value={current ?? ''}
        onChange={(e) => {
          setContext(field.id, e.target.value);
          const sel = options.find((o) => o.dataset_id === e.target.value);
          if (sel?.vehicle_type) setContext('vehicle_type', sel.vehicle_type);
          if (sel?.region) setContext('region', sel.region);
        }}
        style={selectStyle}
      >
        {options.map((opt) => (
          <option key={opt.dataset_id} value={opt.dataset_id}>
            {opt.label}{opt.is_active ? ' (active)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

// Date-range picker. The contextBar declares a single `date_range` field whose
// id holds the START date; the END is stored under context.date_range_end.
// Rather than a wall-clock window, the range defaults to the interval for which
// the SELECTED REGION actually has data: `field.boundsSource` is queried on every
// region change and the min/max seed the two context values (so any view whose
// query references :date_range_start / :date_range_end refetches). Presets are
// anchored on the newest data date and custom picks are clamped to the bounds.
function DateRangePicker({ field }: { field: ContextBarField }) {
  const start = useAppStore((s) => s.context[field.id]) as string | undefined;
  const end = useAppStore((s) => s.context['date_range_end']) as string | undefined;
  const region = useAppStore((s) => s.context['region']) as string | undefined;
  const setContext = useAppStore((s) => s.setContext);
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [bounds, setBounds] = useState<DateBounds | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // Region whose bounds have already been seeded into context, so an explicit
  // user pick is never clobbered by a re-render - only a real region change
  // re-seeds.
  const seededRegion = useRef<string | null>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowCustom(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Resolve the available data interval for the active region and seed the range.
  useEffect(() => {
    if (!region) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sql: field.boundsSource ?? DEFAULT_BOUNDS_SOURCE,
            params: { region },
          }),
        });
        if (!res.ok) return;
        const body = (await res.json()) as {
          rows?: Array<{ min_date?: unknown; max_date?: unknown }>;
        };
        const row = body.rows?.[0];
        const min = normalizeDate(row?.min_date);
        const max = normalizeDate(row?.max_date);
        if (cancelled) return;
        if (!min || !max) {
          // No data for this region: degrade to All time rather than an empty
          // dashboard, and hide the bounds hint.
          setBounds(null);
          seededRegion.current = region;
          setContext(field.id, null);
          setContext('date_range_end', null);
          return;
        }
        const next = { min, max };
        setBounds(next);
        const outOfBounds = !start || !end || String(start) < min || String(end) > max;
        if (seededRegion.current !== region || outOfBounds) {
          seededRegion.current = region;
          setContext(field.id, min);
          setContext('date_range_end', max);
        }
      } catch {
        /* non-fatal: leave the range as-is (unfiltered) */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region]);

  const applyCustom = useCallback(() => {
    if (customStart) {
      const s = clampDate(customStart, bounds);
      const e = customEnd ? clampDate(customEnd, bounds) : null;
      setContext(field.id, s);
      setContext('date_range_end', e && e >= s ? e : bounds ? bounds.max : null);
    }
    setOpen(false);
    setShowCustom(false);
  }, [customStart, customEnd, bounds, setContext, field.id]);

  // Only offer relative windows that fit inside the available span.
  const spanDays = bounds ? daysBetween(bounds.min, bounds.max) : null;
  const presets = spanDays == null ? DATE_PRESETS : DATE_PRESETS.filter((p) => p.days < spanDays);

  const menuBtn: React.CSSProperties = {
    display: 'block',
    width: '100%',
    padding: '8px 14px',
    border: 'none',
    backgroundColor: 'transparent',
    textAlign: 'left',
    cursor: 'pointer',
    fontSize: '13px',
    color: 'var(--text-primary, #111827)',
  };

  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <span style={labelStyle}>{field.label ?? 'Date range'}</span>
      <div ref={ref} style={{ position: 'relative' }}>
        <button
          onClick={() => setOpen(!open)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 10px',
            border: '1px solid var(--border-default, #d1d5db)',
            borderRadius: '6px',
            backgroundColor: 'var(--surface-primary, #fff)',
            cursor: 'pointer',
            fontSize: '13px',
            color: 'var(--text-primary, #111827)',
          }}
        >
          <span style={{ color: 'var(--text-secondary, #6b7280)' }}>{'\uD83D\uDCC5'}</span>
          {getDateLabel(start, end, bounds)}
          <span style={{ color: 'var(--text-secondary, #6b7280)', fontSize: '10px' }}>{'\u25BC'}</span>
        </button>
        {open && (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: '4px',
              backgroundColor: 'var(--surface-primary, #fff)',
              border: '1px solid var(--border-default, #e5e7eb)',
              borderRadius: '8px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
              zIndex: 100,
              minWidth: '200px',
              overflow: 'hidden',
            }}
          >
            {bounds && (
              <div
                style={{
                  padding: '8px 14px 4px',
                  fontSize: '11px',
                  color: 'var(--text-secondary, #6b7280)',
                }}
              >
                {`Data available ${bounds.min} - ${bounds.max}`}
              </div>
            )}
            {bounds && (
              <button
                onClick={() => {
                  setContext(field.id, bounds.min);
                  setContext('date_range_end', bounds.max);
                  setOpen(false);
                  setShowCustom(false);
                }}
                style={menuBtn}
                onMouseOver={(e) => (e.currentTarget.style.backgroundColor = 'var(--surface-secondary, #f3f4f6)')}
                onMouseOut={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                Full range
              </button>
            )}
            {presets.map((preset) => (
              <button
                key={preset.label}
                onClick={() => {
                  // Relative windows are anchored on the newest DATA date, not
                  // today, so they always land inside the available interval.
                  if (bounds) {
                    setContext(field.id, clampDate(addDays(bounds.max, -preset.days), bounds));
                    setContext('date_range_end', bounds.max);
                  } else {
                    const d = new Date();
                    d.setDate(d.getDate() - preset.days);
                    setContext(field.id, d.toISOString().split('T')[0]);
                    setContext('date_range_end', null);
                  }
                  setOpen(false);
                  setShowCustom(false);
                }}
                style={menuBtn}
                onMouseOver={(e) => (e.currentTarget.style.backgroundColor = 'var(--surface-secondary, #f3f4f6)')}
                onMouseOut={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                {preset.label}
              </button>
            ))}
            <button
              onClick={() => {
                setContext(field.id, null);
                setContext('date_range_end', null);
                setOpen(false);
                setShowCustom(false);
              }}
              style={menuBtn}
              onMouseOver={(e) => (e.currentTarget.style.backgroundColor = 'var(--surface-secondary, #f3f4f6)')}
              onMouseOut={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
            >
              All time
            </button>
            <div style={{ borderTop: '1px solid var(--border-default, #e5e7eb)', margin: '4px 0' }} />
            {!showCustom ? (
              <button
                onClick={() => setShowCustom(true)}
                style={menuBtn}
                onMouseOver={(e) => (e.currentTarget.style.backgroundColor = 'var(--surface-secondary, #f3f4f6)')}
                onMouseOut={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                {'Custom range\u2026'}
              </button>
            ) : (
              <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)', minWidth: '32px' }}>From</span>
                  <input
                    type="date"
                    value={customStart}
                    min={bounds?.min}
                    max={bounds?.max}
                    onChange={(e) => setCustomStart(e.target.value)}
                    style={{ flex: 1, padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '12px' }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)', minWidth: '32px' }}>To</span>
                  <input
                    type="date"
                    value={customEnd}
                    min={customStart || bounds?.min}
                    max={bounds?.max}
                    onChange={(e) => setCustomEnd(e.target.value)}
                    style={{ flex: 1, padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '12px' }}
                  />
                </div>
                <button
                  onClick={applyCustom}
                  disabled={!customStart}
                  style={{
                    padding: '6px 12px',
                    backgroundColor: customStart ? 'var(--interactive-primary, #2563eb)' : '#d1d5db',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: customStart ? 'pointer' : 'default',
                    fontSize: '12px',
                    fontWeight: 500,
                  }}
                >
                  Apply
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </label>
  );
}

// Dynamic enum picker: when a contextBar enum declares `source` (a read-only
// SELECT returning value,label rows), the options are fetched at runtime so the
// control lists ONLY what is actually installed (e.g. regions present in
// DIM_DATASETS) rather than a hardcoded list. Falls back to the static `options`
// (and never shows an uninstalled choice). Auto-selects `default` when present in
// the fetched set, else the first row.
function DynamicEnumPicker({ field }: { field: ContextBarField }) {
  const current = useAppStore((s) => s.context[field.id]) as string | undefined;
  const setContext = useAppStore((s) => s.setContext);
  const [options, setOptions] = useState<Array<{ value: string; label: string }>>(field.options ?? []);

  useEffect(() => {
    if (!field.source) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql: field.source }),
        });
        if (!res.ok) return;
        const body = (await res.json()) as { rows?: Array<{ value?: string; label?: string }> };
        const rows = (body.rows ?? [])
          .filter((r) => r.value != null && r.value !== '')
          .map((r) => ({ value: String(r.value), label: String(r.label ?? r.value) }));
        if (cancelled || rows.length === 0) return;
        setOptions(rows);
        const vals = new Set(rows.map((r) => r.value));
        if (!current || !vals.has(current)) {
          const fallback = field.default && vals.has(field.default) ? field.default : rows[0].value;
          setContext(field.id, fallback);
        }
      } catch {
        /* non-fatal: keep the static fallback options */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (options.length === 0) return null;

  const currentVal = current ?? field.default ?? options[0]?.value ?? '';
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <span style={labelStyle}>{field.label ?? field.id}</span>
      <select
        value={currentVal}
        onChange={(e) => setContext(field.id, e.target.value)}
        style={selectStyle}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// Renders the per-session context pickers (region / vehicle / dataset).
//
// R2.2: selection is PURELY client-side context. Changing a picker sets
// store.context.<id>, so every dashboard whose params reference context.<id>
// auto-refetches (via useViewData) against the per-session scope. The contextBar
// NO LONGER writes the shared per-schema CONFIG table - that global "promote
// active scope" action moves to the OPS surface (R4), keeping the consumer
// multi-tenant safe (one user's switch never changes another user's view).
export function ContextBar({ fields }: { fields: ContextBarField[] }) {
  const context = useAppStore((s) => s.context);
  const setContext = useAppStore((s) => s.setContext);

  const enumFields = fields.filter((f) => f.type === 'enum' && (f.options?.length ?? 0) > 0);
  const datasetFields = fields.filter((f) => f.type === 'dataset');
  const dateRangeFields = fields.filter((f) => f.type === 'date_range');
  // Read-only fields (e.g. vehicle_type) display the current context value as a
  // label rather than a control. The value is driven elsewhere (the dataset
  // picker syncs vehicle_type), so the user never edits it directly.
  const readonlyFields = fields.filter((f) => f.type === 'readonly');
  if (
    enumFields.length === 0 &&
    datasetFields.length === 0 &&
    dateRangeFields.length === 0 &&
    readonlyFields.length === 0
  )
    return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        padding: '6px 16px',
        borderBottom: '1px solid var(--border-default, #e5e7eb)',
        backgroundColor: 'var(--surface-secondary, #f9fafb)',
        flexShrink: 0,
      }}
    >
      {enumFields.map((field) => {
        if (field.source) return <DynamicEnumPicker key={field.id} field={field} />;
        const currentVal = (context[field.id] as string | undefined) ?? field.default ?? '';
        return (
          <label key={field.id} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={labelStyle}>{field.label ?? field.id}</span>
            <select
              value={currentVal}
              onChange={(e) => setContext(field.id, e.target.value)}
              style={selectStyle}
            >
              {field.options!.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        );
      })}
      {datasetFields.map((field) => (
        <DatasetPicker key={field.id} field={field} />
      ))}
      {readonlyFields.map((field) => {
        const raw = context[field.id] as string | undefined;
        if (!raw) return null;
        const pretty = field.options?.find((o) => o.value === raw)?.label ?? raw;
        return (
          <label key={field.id} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={labelStyle}>{field.label ?? field.id}</span>
            <span style={{ fontSize: '13px', color: 'var(--text-primary, #111827)' }}>{pretty}</span>
          </label>
        );
      })}
      {dateRangeFields.map((field) => (
        <DateRangePicker key={field.id} field={field} />
      ))}
    </div>
  );
}
