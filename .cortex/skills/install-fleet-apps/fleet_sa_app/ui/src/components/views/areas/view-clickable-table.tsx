'use client';

// Clickable-table area (parity widget #2): a data table whose row click writes a
// configured column value into a viewState key via updateViewState. Drives map
// highlight (LayerSpec conditional color whenViewStateEquals) and any
// viewState.<key>-parametrized query. Reproduces the control app's FleetMap
// click-a-courier drilldown.

import { useViewData } from '@/hooks/use-view-data';
import { useAppStore } from '@/lib/store';
import { useStyleConfig, resolveDefaultMaxRows } from '@/lib/style-config';
import { FreshnessBadge } from './freshness-badge';

interface TableColumn {
  field: string;
  header?: string;
}

interface ViewClickableTableAreaProps {
  areaConfig: {
    data: {
      query: string;
      params?: Record<string, string>;
    };
    config?: {
      rowKey: string;
      columns?: TableColumn[];
      maxRows?: number;
      // Initial sort applied before rendering (exception-first triage default).
      defaultSort?: { column: string; direction?: 'asc' | 'desc' };
      // Pin rows whose `column` value is in `values` to the top (severity/at-risk first).
      exceptionFirst?: { column: string; values: string[] };
      // Show an "updated Ns ago" badge above the table (live operational views).
      showFreshness?: boolean;
    };
    emits?: Record<string, string>;
  };
}

function compareValues(a: unknown, b: unknown, dir: 'asc' | 'desc'): number {
  const na = Number(a);
  const nb = Number(b);
  let cmp: number;
  if (!isNaN(na) && !isNaN(nb)) cmp = na - nb;
  else cmp = String(a ?? '').localeCompare(String(b ?? ''));
  return dir === 'desc' ? -cmp : cmp;
}

export function ViewClickableTableArea({ areaConfig }: ViewClickableTableAreaProps) {
  const { data, loading, error, fetchedAt } = useViewData(areaConfig.data.query, areaConfig.data.params);
  const config = areaConfig.config;
  const styleConfig = useStyleConfig();
  const updateViewState = useAppStore((s) => s.updateViewState);
  const viewState = useAppStore((s) => s.panel.viewState);

  const emitKey = areaConfig.emits ? Object.keys(areaConfig.emits)[0] : null;
  const rowKey = config?.rowKey;
  const selected = emitKey ? viewState[emitKey] : null;

  if (loading) {
    return <div style={{ padding: '16px', color: 'var(--text-secondary, #6b7280)', fontSize: '13px' }}>Loading…</div>;
  }
  if (error) {
    return <div style={{ padding: '16px', color: 'var(--text-error, #dc2626)', fontSize: '13px' }}>Error: {error}</div>;
  }
  let rows = data?.rows ?? [];
  // Exception-first triage sort: pin flagged rows to the top, then optional default sort.
  if (rows.length) {
    const exc = config?.exceptionFirst;
    const ds = config?.defaultSort;
    if (exc || ds) {
      const excSet = exc ? new Set(exc.values.map(String)) : null;
      rows = [...rows].sort((a, b) => {
        if (excSet && exc) {
          const af = excSet.has(String(a[exc.column])) ? 0 : 1;
          const bf = excSet.has(String(b[exc.column])) ? 0 : 1;
          if (af !== bf) return af - bf;
        }
        if (ds) return compareValues(a[ds.column], b[ds.column], ds.direction ?? 'desc');
        return 0;
      });
    }
  }
  rows = rows.slice(0, config?.maxRows ?? resolveDefaultMaxRows(styleConfig));
  if (!rows.length) {
    return <div style={{ padding: '16px', color: 'var(--text-secondary, #6b7280)', fontSize: '13px' }}>No data</div>;
  }

  const columns: TableColumn[] = config?.columns ?? (data?.columns ?? []).map((c) => ({ field: c.key, header: c.label }));

  const onRowClick = (row: Record<string, unknown>) => {
    if (!emitKey || !rowKey) return;
    const val = row[rowKey];
    // Toggle selection off when re-clicking the active row.
    const next = String(val) === String(selected) ? null : (val ?? null);
    updateViewState({ [emitKey]: next });
  };

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      {config?.showFreshness && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 12px 0' }}>
          <FreshnessBadge fetchedAt={fetchedAt} />
        </div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.field} style={{ textAlign: 'left', padding: '8px 12px', position: 'sticky', top: 0, backgroundColor: 'var(--surface-secondary, #f9fafb)', borderBottom: '1px solid var(--border-default, #e5e7eb)', fontWeight: 600, color: 'var(--text-secondary, #6b7280)' }}>
                {c.header ?? c.field}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const isSel = rowKey != null && String(row[rowKey]) === String(selected);
            return (
              <tr
                key={i}
                onClick={() => onRowClick(row)}
                style={{
                  cursor: emitKey && rowKey ? 'pointer' : 'default',
                  backgroundColor: isSel ? 'var(--surface-accent, #eff6ff)' : 'transparent',
                  borderBottom: '1px solid var(--border-subtle, #f3f4f6)',
                }}
              >
                {columns.map((c) => (
                  <td key={c.field} style={{ padding: '8px 12px', color: 'var(--text-primary, #111827)' }}>
                    {String(row[c.field] ?? '')}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
