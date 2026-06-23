'use client';

import { useState } from 'react';

interface DataTableProps {
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, unknown>>;
  totalRows?: number;
}

export function DataTable({ columns, rows, totalRows }: DataTableProps) {
  const [expanded, setExpanded] = useState(false);
  const displayRows = expanded ? rows : rows.slice(0, 6);
  const hasMore = rows.length > 6;
  const serverHasMore = totalRows ? totalRows > rows.length : false;

  return (
    <div
      style={{
        borderRadius: '8px',
        border: '1px solid var(--border-default, #e5e7eb)',
        overflow: 'hidden',
      }}
    >
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                style={{
                  padding: '8px 12px',
                  textAlign: 'left',
                  fontWeight: 600,
                  backgroundColor: 'var(--surface-secondary, #f3f4f6)',
                  borderBottom: '1px solid var(--border-default, #e5e7eb)',
                  color: 'var(--text-primary, #111827)',
                }}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayRows.map((row, i) => (
            <tr key={i}>
              {columns.map((col) => (
                <td
                  key={col.key}
                  style={{
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--border-default, #e5e7eb)',
                    color: 'var(--text-primary, #111827)',
                  }}
                >
                  {String(row[col.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {hasMore && !expanded && (
        <div
          onClick={() => setExpanded(true)}
          style={{
            padding: '8px 12px',
            fontSize: '12px',
            color: 'var(--text-accent, #2563eb)',
            textAlign: 'center',
            cursor: 'pointer',
          }}
        >
          Show all {rows.length} rows ↓
        </div>
      )}
      {expanded && hasMore && (
        <div
          onClick={() => setExpanded(false)}
          style={{
            padding: '8px 12px',
            fontSize: '12px',
            color: 'var(--text-accent, #2563eb)',
            textAlign: 'center',
            cursor: 'pointer',
          }}
        >
          Collapse ↑
        </div>
      )}
      {serverHasMore && (
        <div style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--text-tertiary, #9ca3af)', textAlign: 'center' }}>
          Showing {rows.length} of {totalRows?.toLocaleString()} rows
        </div>
      )}
    </div>
  );
}
