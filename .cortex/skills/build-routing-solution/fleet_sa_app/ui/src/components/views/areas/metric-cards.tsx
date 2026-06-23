'use client';

import { useViewData } from '@/hooks/use-view-data';
import { useDisplayConfig, interpolateTokens, thresholdColor, unitSuffix } from '@/lib/display-config';

interface MetricMapping {
  column: string;
  label: string;
  format?: string;
  // Optional: units-token key (display.units) appended as a suffix, e.g. "speed" -> "km/h".
  unit?: string;
  // Optional: metric_name (display.thresholds) used to color the value good/warn/critical.
  metric?: string;
}

interface MetricCardsAreaProps {
  areaConfig: {
    data: {
      query: string;
      params?: Record<string, string>;
      mapping?: { metrics?: MetricMapping[] };
    };
  };
}

function formatValue(value: unknown, format?: string): string {
  if (value === null || value === undefined) return '—';
  const num = Number(value);
  if (isNaN(num)) return String(value);

  switch (format) {
    case 'currency':
      return num >= 1_000_000
        ? `$${(num / 1_000_000).toFixed(2)}M`
        : num >= 1_000
          ? `$${(num / 1_000).toFixed(1)}K`
          : `$${num.toFixed(2)}`;
    case 'percent':
      return `${(num * 100).toFixed(2)}%`;
    case 'number':
      return num >= 1_000_000
        ? `${(num / 1_000_000).toFixed(2)}M`
        : num >= 1_000
          ? `${(num / 1_000).toFixed(1)}K`
          : num.toLocaleString();
    case 'number_2dp':
      return num.toFixed(2);
    default:
      return typeof value === 'number' ? num.toLocaleString() : String(value);
  }
}

export function MetricCardsArea({ areaConfig }: MetricCardsAreaProps) {
  const { data, loading, error } = useViewData(areaConfig.data.query, areaConfig.data.params);
  const display = useDisplayConfig();
  const metrics = areaConfig.data.mapping?.metrics || [];

  if (loading) {
    return (
      <div style={{ display: 'flex', gap: '16px', padding: '16px' }}>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} style={{ flex: 1, height: '80px', borderRadius: '12px', backgroundColor: 'var(--surface-secondary, #f3f4f6)', animation: 'pulse 2s ease-in-out infinite' }} />
        ))}
      </div>
    );
  }

  if (error) {
    return <div style={{ padding: '16px', color: 'var(--text-error, #dc2626)', fontSize: '13px' }}>Error: {error}</div>;
  }

  const row = data?.rows?.[0];
  if (!row) return null;

  return (
    <div style={{ display: 'flex', gap: '16px', padding: '16px', flexWrap: 'wrap' }}>
      {metrics.map((m) => {
        const raw = row[m.column];
        const suffix = unitSuffix(display, m.unit);
        const color = m.metric ? thresholdColor(display, m.metric, Number(raw)) : undefined;
        return (
          <div
            key={m.column}
            style={{
              flex: '1 1 140px',
              padding: '16px',
              borderRadius: '12px',
              border: '1px solid var(--border-default, #e5e7eb)',
              backgroundColor: 'var(--surface-primary, #fff)',
            }}
          >
            <div style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500 }}>
              {interpolateTokens(m.label, display)}
            </div>
            <div style={{ fontSize: '24px', fontWeight: 700, color: color ?? 'var(--text-primary, #111827)' }}>
              {formatValue(raw, m.format)}{suffix ? <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-secondary, #6b7280)', marginLeft: '4px' }}>{suffix}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
