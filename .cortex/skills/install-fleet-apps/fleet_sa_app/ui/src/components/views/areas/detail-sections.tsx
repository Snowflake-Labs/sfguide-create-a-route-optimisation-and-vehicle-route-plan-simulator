'use client';

// Shared detail-rendering primitives used by both EntityDetailArea (full-page
// CRUD detail) and DetailPanelArea (selection-driven slide-over drawer). Kept in
// one module so the two consumers never drift. No selection/navigation logic
// lives here - just value formatting, key/value rows, section headings, a
// generic auto-table, and the two query-backed section renderers.

import { useViewData } from '@/hooks/use-view-data';
import { RoutingSuspendedNotice } from '@/components/views/RoutingSuspendedNotice';

// ── Shared config types ─────────────────────────────────────────────────────

export interface ColumnDef {
  field: string;
  header: string;
  format?: string;
}

export interface PropertyDef {
  field: string;
  label: string;
  format?: 'number' | 'currency' | 'datetime' | 'date' | 'text';
  link_view?: string;   // navigate to this view on click
  id_field?: string;    // which row field provides the ID for link_view
  conditional?: boolean; // hide row when field is null/empty
}

export type SectionDef =
  | { type: 'text';              field: string; title?: string; conditional?: boolean }
  | { type: 'code';              field: string; title?: string; conditional?: boolean }
  | { type: 'dynamic_sql_table'; field: string; title?: string; limit?: number }
  | { type: 'related_table';     title?: string; query: string; columns: ColumnDef[]; params?: Record<string, string>; emptyMessage?: string; link?: { label: string; view: string } };

// ── Value formatting ────────────────────────────────────────────────────────

export function fmtValue(val: unknown, format?: string): string {
  if (val === null || val === undefined || val === '') return '-';
  const s = String(val);
  if (!format || format === 'text') return s;
  if (format === 'number') {
    const n = Number(val);
    return isNaN(n) ? s : n.toLocaleString();
  }
  if (format === 'currency') {
    const n = Number(val);
    return isNaN(n) ? s : '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (format === 'datetime' || format === 'date') {
    try {
      const d = new Date(s);
      if (isNaN(d.getTime())) return s;
      return format === 'date'
        ? d.toLocaleDateString(undefined, { dateStyle: 'medium' })
        : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch { return s; }
  }
  return s;
}

// ── Primitives ──────────────────────────────────────────────────────────────

export function KVRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: '12px', padding: '8px 0', borderBottom: '1px solid var(--border-default, #e5e7eb)' }}>
      <div style={{ width: '160px', flexShrink: 0, color: 'var(--text-secondary, #6b7280)', fontSize: '13px', fontWeight: 500 }}>{label}</div>
      <div style={{ color: 'var(--text-primary, #111827)', fontSize: '13px', wordBreak: 'break-word', flex: 1 }}>{value ?? '-'}</div>
    </div>
  );
}

export function SectionHeading({ title, note }: { title?: string; note?: string }) {
  if (!title) return null;
  return (
    <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 600, color: 'var(--text-primary, #111827)' }}>
      {title}
      {note && <span style={{ marginLeft: '8px', fontSize: '12px', fontWeight: 400, color: 'var(--text-secondary, #6b7280)' }}>{note}</span>}
    </h3>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div style={{ padding: '16px' }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ height: '28px', marginBottom: '6px', borderRadius: '4px', backgroundColor: 'var(--surface-secondary, #f3f4f6)' }} />
      ))}
    </div>
  );
}

// Generic table renderer used by the query-backed section renderers below.
// `scrollHeight` (px) makes the scroll area a FIXED height (~6 rows) so several
// tables rendered side by side line up regardless of row count; omit it for the
// default max-height behavior.
export function AutoTable({ columns, rows, totalRows, scrollHeight }: { columns: ColumnDef[]; rows: Record<string, unknown>[]; totalRows?: number; scrollHeight?: number }) {
  const displayed = rows.length;
  const total = totalRows ?? displayed;
  return (
    <div>
      <div style={{ height: scrollHeight, maxHeight: scrollHeight ? undefined : '330px', overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
        <thead>
          <tr>
            {columns.map(col => (
              <th key={col.field} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, backgroundColor: 'var(--surface-secondary, #f3f4f6)', borderBottom: '2px solid var(--border-default, #e5e7eb)', whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1 }}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--border-default, #e5e7eb)' }}>
              {columns.map(col => (
                <td key={col.field} style={{ padding: '6px 12px', whiteSpace: 'nowrap', color: 'var(--text-primary, #111827)' }}>
                  {fmtValue(row[col.field], col.format)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {total > displayed && (
        <div style={{ padding: '8px', fontSize: '12px', color: 'var(--text-secondary, #6b7280)', textAlign: 'center' }}>
          Showing {displayed} of {total.toLocaleString()}
        </div>
      )}
    </div>
  );
}

// Runs row[field] as a SQL query - used for "Live Membership" in audience detail.
export function DynamicSqlSection({ sql, title, limit }: { sql: string | null; title?: string; limit?: number }) {
  const wrappedSql = sql ? `SELECT * FROM (${sql}) AS _t LIMIT ${limit ?? 200}` : undefined;
  const { data, loading, error, suspended, refetch } = useViewData(wrappedSql);

  return (
    <div style={{ marginBottom: '28px' }}>
      <SectionHeading title={title} note="- evaluated from definition SQL" />
      <div style={{ border: '1px solid var(--border-default, #e5e7eb)', borderRadius: '6px', overflow: 'hidden' }}>
        {!sql ? (
          <div style={{ padding: '12px', color: 'var(--text-secondary, #6b7280)', fontSize: '13px' }}>No SQL - membership cannot be computed.</div>
        ) : loading ? (
          <Skeleton />
        ) : suspended ? (
          <RoutingSuspendedNotice info={suspended} onRetry={refetch} compact />
        ) : error ? (
          <div style={{ padding: '12px 16px' }}>
            <div style={{ color: 'var(--text-error, #dc2626)', fontSize: '13px', marginBottom: '8px' }}>Error: {error}</div>
            <button onClick={refetch} style={{ padding: '4px 12px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--border-default, #e5e7eb)', cursor: 'pointer', backgroundColor: 'white' }}>Retry</button>
          </div>
        ) : !data?.rows.length ? (
          <div style={{ padding: '12px', color: 'var(--text-secondary, #6b7280)', fontSize: '13px' }}>No members found.</div>
        ) : (
          <AutoTable
            columns={data.columns.map(c => ({ field: c.key, header: c.label }))}
            rows={data.rows}
            totalRows={data.totalRows}
          />
        )}
      </div>
    </div>
  );
}

// Runs a static parameterized sub-query - used for sub-lists like Activation
// History (EntityDetail) and the per-entity detail-panel sections. `params`
// defaults to the EntityDetail convention ({ id: 'viewState.id' }); the detail
// panel passes its own selection + scope params.
export function RelatedTableSection({
  section,
  params = { id: 'viewState.id' },
  showViewFn,
  scrollHeight,
}: {
  section: Extract<SectionDef, { type: 'related_table' }>;
  params?: Record<string, string>;
  showViewFn: (id: string) => void;
  scrollHeight?: number;
}) {
  const { data, loading, error, suspended, refetch } = useViewData(section.query, params);

  return (
    <div style={{ marginBottom: '28px' }}>
      <SectionHeading title={section.title} />
      <div style={{ border: '1px solid var(--border-default, #e5e7eb)', borderRadius: '6px', overflow: 'hidden', minHeight: scrollHeight }}>
        {loading ? (
          <Skeleton />
        ) : suspended ? (
          <RoutingSuspendedNotice info={suspended} onRetry={refetch} compact />
        ) : error ? (
          <div style={{ padding: '12px', color: 'var(--text-error, #dc2626)', fontSize: '13px' }}>Error: {error}</div>
        ) : !data?.rows.length ? (
          <div style={{ padding: '12px', color: 'var(--text-secondary, #6b7280)', fontSize: '13px' }}>{section.emptyMessage ?? 'No records found.'}</div>
        ) : (
          <AutoTable columns={section.columns} rows={data.rows} scrollHeight={scrollHeight} />
        )}
      </div>
      {section.link && (
        <button
          onClick={() => showViewFn(section.link!.view)}
          style={{ marginTop: '8px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-accent, #2563eb)', fontSize: '13px', padding: 0 }}
        >
          {section.link.label}
        </button>
      )}
    </div>
  );
}
