'use client';

import { useState, useMemo, useCallback } from 'react';
import { useViewData } from '@/hooks/use-view-data';
import { useAppStore } from '@/lib/store';
import { buildTableMemo, useAgentMemo } from '@/lib/agent-memo';
import { RoutingSuspendedNotice } from '@/components/views/RoutingSuspendedNotice';

// Row metrics for the `fitRows` height cap: sticky header + N data rows, then scroll.
const HEADER_PX = 38;
const ROW_PX = 35;

interface ViewTableAreaProps {
  areaConfig: {
    data: {
      query: string;
      params?: Record<string, string>;
    };
    rowClick?: {
      viewId: string;
      idField: string;
    };
    config?: {
      // Cap the visible height to N data rows (header + N rows) and scroll beyond it.
      fitRows?: number;
    };
  };
  // The area's own key in the view layout, supplied by the renderer. Namespaces
  // this table's agent memo so sibling tables in one view do not clobber it.
  areaName?: string;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'number') {
    if (Math.abs(value) < 1 && value !== 0) return value.toFixed(4);
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  return String(value);
}

function isNumericColumn(rows: Record<string, unknown>[], key: string): boolean {
  return rows.slice(0, 10).every((r) => r[key] === null || r[key] === undefined || typeof r[key] === 'number');
}

export function ViewTableArea({ areaConfig, areaName }: ViewTableAreaProps) {
  const { data, loading, error, suspended, refetch } = useViewData(areaConfig.data.query, areaConfig.data.params);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const showView = useAppStore((s) => s.showView);

  const rowClick = areaConfig.rowClick;

  const numericCols = useMemo(() => {
    if (!data?.columns || !data?.rows) return new Set<string>();
    return new Set(data.columns.filter((c) => isNumericColumn(data.rows, c.key)).map((c) => c.key));
  }, [data]);

  const sortedRows = useMemo(() => {
    if (!data?.rows || !sortKey) return data?.rows || [];
    return [...data.rows].sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [data, sortKey, sortDir]);

  // Agent grounding: republish the rendered slice so the chat agent can answer
  // about this table instead of re-querying and drifting from what is on screen
  // (these tables are commonly scoped to a replay instant). Built from sortedRows
  // so the sample follows the user's current ordering.
  useAgentMemo(
    areaName,
    useMemo(
      () =>
        buildTableMemo({
          columns: data?.columns ?? [],
          rows: sortedRows,
          totalRows: data?.totalRows,
          sortKey,
          sortDir,
          formatCell,
        }),
      [data?.columns, data?.totalRows, sortedRows, sortKey, sortDir],
    ),
    'table',
  );

  const handleHover = useCallback((index: number | null) => setHoveredIndex(index), []);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(numericCols.has(key) ? 'desc' : 'asc');
    }
  };

  const handleRowClick = (row: Record<string, unknown>) => {
    if (!rowClick) return;
    showView(rowClick.viewId, { id: row[rowClick.idField], row });
  };

  if (loading) {
    return (
      <div style={{ padding: '16px' }}>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} style={{ height: '32px', marginBottom: '4px', borderRadius: '4px', backgroundColor: 'var(--surface-secondary, #f3f4f6)', animation: 'pulse 2s ease-in-out infinite' }} />
        ))}
      </div>
    );
  }

  if (suspended) {
    return <RoutingSuspendedNotice info={suspended} onRetry={refetch} />;
  }

  if (error) {
    return <div style={{ padding: '16px', color: 'var(--text-error, #dc2626)', fontSize: '13px' }}>Error: {error}</div>;
  }

  if (!data?.columns?.length) {
    return <div style={{ padding: '16px', color: 'var(--text-secondary, #6b7280)', fontSize: '13px' }}>No data</div>;
  }

  const fitRows = areaConfig.config?.fitRows;
  const maxHeight = fitRows ? `${HEADER_PX + fitRows * ROW_PX}px` : undefined;

  return (
    <div style={{ overflow: 'auto', height: fitRows ? undefined : '100%', maxHeight }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
        <thead>
          <tr>
            {data.columns.map((col) => (
              <th
                key={col.key}
                onClick={() => handleSort(col.key)}
                style={{
                  padding: '10px 12px',
                  textAlign: numericCols.has(col.key) ? 'right' : 'left',
                  fontWeight: 600,
                  backgroundColor: 'var(--surface-secondary, #f3f4f6)',
                  borderBottom: '2px solid var(--border-default, #e5e7eb)',
                  color: 'var(--text-primary, #111827)',
                  cursor: 'pointer',
                  userSelect: 'none',
                  whiteSpace: 'nowrap',
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
                }}
              >
                {col.label}
                {sortKey === col.key && (
                  <span style={{ marginLeft: '4px', fontSize: '10px' }}>
                    {sortDir === 'asc' ? '▲' : '▼'}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, i) => (
            <tr
              key={i}
              onClick={rowClick ? () => handleRowClick(row) : undefined}
              onMouseEnter={rowClick ? () => handleHover(i) : undefined}
              onMouseLeave={rowClick ? () => handleHover(null) : undefined}
              style={{
                borderBottom: '1px solid var(--border-default, #e5e7eb)',
                cursor: rowClick ? 'pointer' : undefined,
                backgroundColor: rowClick && hoveredIndex === i ? 'var(--surface-hover, #f9fafb)' : undefined,
              }}
            >
              {data.columns.map((col) => (
                <td
                  key={col.key}
                  style={{
                    padding: '8px 12px',
                    textAlign: numericCols.has(col.key) ? 'right' : 'left',
                    color: 'var(--text-primary, #111827)',
                    fontVariantNumeric: numericCols.has(col.key) ? 'tabular-nums' : undefined,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {formatCell(row[col.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.totalRows > sortedRows.length && (
        <div style={{ padding: '8px 12px', fontSize: '12px', color: 'var(--text-secondary, #6b7280)', textAlign: 'center' }}>
          Showing {sortedRows.length} of {data.totalRows.toLocaleString()} rows
        </div>
      )}
    </div>
  );
}
