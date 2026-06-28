'use client';

import { useViewData } from '@/hooks/use-view-data';
import { useAppStore } from '@/lib/store';
import { useDisplayConfig, interpolateTokens, thresholdColor, unitSuffix } from '@/lib/display-config';

interface MetricMapping {
  column: string;
  label: string;
  format?: string;
  // Optional: units-token key (display.units) appended as a suffix, e.g. "speed" -> "km/h".
  unit?: string;
  // Optional: metric_name (display.thresholds) used to color the value good/warn/critical.
  metric?: string;
  // Optional: value written to the emit viewState key when this tile is clicked
  // (KPI-tile-as-filter). Defaults to the column name when omitted.
  emit?: string;
}

interface MetricCardsAreaProps {
  areaConfig: {
    data: {
      query: string;
      params?: Record<string, string>;
      mapping?: { metrics?: MetricMapping[] };
    };
    // When present, clicking a card toggles the first emit key in viewState to the
    // card's emit value, so downstream areas filter on the selected KPI.
    emits?: Record<string, string>;
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
  const updateViewState = useAppStore((s) => s.updateViewState);
  const viewState = useAppStore((s) => s.panel.viewState);
  const emitKey = areaConfig.emits ? Object.keys(areaConfig.emits)[0] : null;
  const metrics = areaConfig.data.mapping?.metrics || [];

  if (loading) {
    return (
      <div style={{ display: 'flex', gap: '10px', padding: '10px' }}>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} style={{ flex: 1, height: '52px', borderRadius: '10px', backgroundColor: 'var(--surface-secondary, #f3f4f6)', animation: 'pulse 2s ease-in-out infinite' }} />
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
    <div style={{ display: 'flex', gap: '10px', padding: '10px', flexWrap: 'wrap' }}>
      {metrics.map((m) => {
        const raw = row[m.column];
        const suffix = unitSuffix(display, m.unit);
        const color = m.metric ? thresholdColor(display, m.metric, Number(raw)) : undefined;
        const emitVal = m.emit ?? m.column;
        const clickable = !!emitKey;
        const isSel = clickable && String(viewState[emitKey!]) === String(emitVal);
        return (
          <div
            key={m.column}
            onClick={clickable ? () => updateViewState({ [emitKey!]: isSel ? null : emitVal }) : undefined}
            style={{
              flex: '1 1 120px',
              padding: '8px 12px',
              borderRadius: '10px',
              border: `1px solid ${isSel ? 'var(--border-accent, #93b4f5)' : 'var(--border-default, #e5e7eb)'}`,
              backgroundColor: isSel ? 'var(--surface-accent, #eff6ff)' : 'var(--surface-primary, #fff)',
              cursor: clickable ? 'pointer' : 'default',
            }}
          >
            <div style={{ fontSize: '11px', color: 'var(--text-secondary, #6b7280)', marginBottom: '2px', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500 }}>
              {interpolateTokens(m.label, display)}
            </div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: color ?? 'var(--text-primary, #111827)' }}>
              {formatValue(raw, m.format)}{suffix ? <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary, #6b7280)', marginLeft: '4px' }}>{suffix}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
