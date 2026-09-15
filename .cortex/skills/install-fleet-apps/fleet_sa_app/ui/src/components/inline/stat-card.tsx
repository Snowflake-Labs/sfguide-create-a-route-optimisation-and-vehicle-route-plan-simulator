'use client';

import { formatCellValue } from '@/lib/format-number';

interface StatCardProps {
  label: string;
  value: string | number;
  trend?: string;
  trendDirection?: 'up' | 'down' | 'neutral';
  breakdown?: Array<{ label: string; value: string | number }>;
}

export function StatCard({ label, value, trend, trendDirection, breakdown }: StatCardProps) {
  // The agent supplies `value` straight from a tool result, so a bare {value}
  // printed 21289.670000000002 verbatim. `label` doubles as the column name for
  // the coordinate exemption - a tile labelled "Latitude" keeps its precision.
  const shown = formatCellValue(value, { column: label, grouping: true });
  return (
    <div
      style={{
        padding: '16px',
        borderRadius: '12px',
        border: '1px solid var(--border-default, #e5e7eb)',
        backgroundColor: 'var(--surface-primary, #fff)',
      }}
    >
      <div style={{ fontSize: '13px', color: 'var(--text-secondary, #6b7280)', marginBottom: '4px' }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
        <span style={{ fontSize: '28px', fontWeight: 700, color: 'var(--text-primary, #111827)' }}>
          {shown}
        </span>
        {trend && (
          <span
            style={{
              fontSize: '13px',
              fontWeight: 500,
              color:
                trendDirection === 'up'
                  ? 'var(--text-success, #059669)'
                  : trendDirection === 'down'
                    ? 'var(--text-error, #dc2626)'
                    : 'var(--text-secondary, #6b7280)',
            }}
          >
            {trendDirection === 'up' ? '↑' : trendDirection === 'down' ? '↓' : '→'} {trend}
          </span>
        )}
      </div>
      {breakdown && breakdown.length > 0 && (
        <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {breakdown.slice(0, 6).map((item, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
              <span style={{ color: 'var(--text-secondary, #6b7280)' }}>{item.label}</span>
              <span style={{ fontWeight: 500, color: 'var(--text-primary, #111827)' }}>
                {formatCellValue(item.value, { column: item.label, grouping: true })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
