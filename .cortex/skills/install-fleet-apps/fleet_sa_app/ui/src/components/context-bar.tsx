'use client';

import { useAppStore } from '@/lib/store';
import { useEffect, useState, useRef, useCallback } from 'react';

const DATE_PRESETS = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 6 months', days: 180 },
  { label: 'Last 12 months', days: 365 },
  { label: 'All time', days: 0 },
];

function getDateLabel(value: unknown, endValue?: unknown): string {
  if (!value) return 'All time';
  const dateStr = String(value);
  if (endValue) {
    return `${dateStr} \u2192 ${String(endValue)}`;
  }
  const today = new Date();
  const target = new Date(dateStr);
  const diffDays = Math.round((today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));
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
// the source of truth for REGION and VEHICLE_TYPE — selecting a dataset auto-
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
              'SELECT DATASET_ID AS dataset_id, LABEL AS label, IS_ACTIVE AS is_active, ' +
              'VEHICLE_TYPE AS vehicle_type, REGION AS region ' +
              'FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS ' +
              'ORDER BY IS_ACTIVE DESC, CREATED_AT DESC',
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
// id holds the START date; the END is stored under context.date_range_end (both
// seeded in app-shell). Renders two native date inputs writing per-session context,
// so any view whose query references :date_range_start / :date_range_end refetches.
function DateRangePicker({ field }: { field: ContextBarField }) {
  const start = useAppStore((s) => s.context[field.id]) as string | undefined;
  const end = useAppStore((s) => s.context['date_range_end']) as string | undefined;
  const setContext = useAppStore((s) => s.setContext);
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const ref = useRef<HTMLDivElement>(null);

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

  const applyCustom = useCallback(() => {
    if (customStart) {
      setContext(field.id, customStart);
      setContext('date_range_end', customEnd || null);
    }
    setOpen(false);
    setShowCustom(false);
  }, [customStart, customEnd, setContext, field.id]);

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
          {getDateLabel(start, end)}
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
              minWidth: '160px',
              overflow: 'hidden',
            }}
          >
            {DATE_PRESETS.map((preset) => (
              <button
                key={preset.label}
                onClick={() => {
                  if (preset.days === 0) {
                    setContext(field.id, null);
                    setContext('date_range_end', null);
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
                    onChange={(e) => setCustomStart(e.target.value)}
                    style={{ flex: 1, padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '12px' }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)', minWidth: '32px' }}>To</span>
                  <input
                    type="date"
                    value={customEnd}
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
// NO LONGER writes the shared per-schema CONFIG table — that global "promote
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
