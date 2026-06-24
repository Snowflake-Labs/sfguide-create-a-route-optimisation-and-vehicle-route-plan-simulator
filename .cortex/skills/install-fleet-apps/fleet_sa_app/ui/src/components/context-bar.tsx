'use client';

import { useAppStore } from '@/lib/store';
import { useEffect, useState } from 'react';

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
}

// Dynamic dataset picker (R2.2). Lists datasets for the active region from
// DIM_DATASETS and writes the chosen DATASET_ID into store context.dataset_id.
// Dashboards bind it as a :param to the F_*_SCOPED contract functions, so the
// selection is PER-SESSION (multi-tenant safe): it never writes any shared row.
function DatasetPicker({ field }: { field: ContextBarField }) {
  const region = useAppStore((s) => s.context.region) as string | undefined;
  const current = useAppStore((s) => s.context[field.id]) as string | undefined;
  const setContext = useAppStore((s) => s.setContext);
  const [options, setOptions] = useState<DatasetOption[]>([]);

  useEffect(() => {
    if (!region) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sql:
              'SELECT DATASET_ID AS dataset_id, LABEL AS label, IS_ACTIVE AS is_active ' +
              'FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE REGION = :region ' +
              'ORDER BY IS_ACTIVE DESC, CREATED_AT DESC',
            params: { region },
          }),
        });
        if (!res.ok) return;
        const body = (await res.json()) as { rows?: DatasetOption[] };
        const rows = body.rows ?? [];
        if (cancelled) return;
        setOptions(rows);
        // Default to the active dataset (or first) whenever the current
        // selection is absent or not valid for the newly selected region.
        const ids = new Set(rows.map((r) => r.dataset_id));
        if (!current || !ids.has(current)) {
          const active = rows.find((r) => r.is_active) ?? rows[0];
          setContext(field.id, active ? active.dataset_id : null);
        }
      } catch {
        /* non-fatal: dashboards fall back to the active dataset when dataset_id is null */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region]);

  if (options.length === 0) return null;

  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <span style={labelStyle}>{field.label ?? 'Dataset'}</span>
      <select
        value={current ?? ''}
        onChange={(e) => setContext(field.id, e.target.value)}
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
  const inputStyle: React.CSSProperties = { ...selectStyle, padding: '2px 6px' };
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <span style={labelStyle}>{field.label ?? 'Date range'}</span>
      <input
        type="date"
        value={start ?? ''}
        max={end ?? undefined}
        onChange={(e) => setContext(field.id, e.target.value || null)}
        style={inputStyle}
      />
      <span style={{ ...labelStyle, fontWeight: 400 }}>to</span>
      <input
        type="date"
        value={end ?? ''}
        min={start ?? undefined}
        onChange={(e) => setContext('date_range_end', e.target.value || null)}
        style={inputStyle}
      />
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
  if (enumFields.length === 0 && datasetFields.length === 0 && dateRangeFields.length === 0) return null;

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
      {dateRangeFields.map((field) => (
        <DateRangePicker key={field.id} field={field} />
      ))}
    </div>
  );
}
