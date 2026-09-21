'use client';

import { useViewData } from '@/hooks/use-view-data';
import { useAppStore } from '@/lib/store';
import { RoutingSuspendedInlineHint } from '@/components/views/RoutingSuspendedInlineHint';
import { formatCellValue } from '@/lib/format-number';

interface ViewComboBoxAreaProps {
  areaConfig: {
    data?: {
      query: string;
      params?: Record<string, string>;
      mapping?: { value: string; label: string };
    };
    config?: { label?: string; placeholder?: string; allowClear?: boolean; options?: Array<{ value: string; label?: string }> };
    emits?: Record<string, string>;
  };
}

export function ViewComboBoxArea({ areaConfig }: ViewComboBoxAreaProps) {
  const staticOptions = areaConfig.config?.options;
  const { data, loading, suspended, refetch } = useViewData(staticOptions ? undefined : areaConfig.data?.query, areaConfig.data?.params);
  const updateViewState = useAppStore((s) => s.updateViewState);
  const viewState = useAppStore((s) => s.panel.viewState);

  const valueField = areaConfig.data?.mapping?.value || 'value';
  const labelField = areaConfig.data?.mapping?.label || 'label';

  const emitKey = areaConfig.emits ? Object.keys(areaConfig.emits)[0] : null;
  const currentValue = emitKey ? (viewState[emitKey] as string) || '' : '';
  const label = areaConfig.config?.label;
  const placeholder = areaConfig.config?.placeholder || 'All';

  const handleChange = (value: string) => {
    if (emitKey) {
      updateViewState({ [emitKey]: value || null });
    }
  };

  const options: Array<Record<string, unknown>> = staticOptions
    ? staticOptions.map((o) => ({ value: o.value, label: o.label ?? o.value }))
    : (data?.rows || []);

  return (
    <div style={{ padding: '12px 16px' }}>
      {label && (
        <label style={{
          display: 'block',
          marginBottom: '6px',
          fontSize: '12px',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: 'var(--text-secondary, #6b7280)',
        }}>
          {label}
        </label>
      )}
      <select
        value={currentValue}
        onChange={(e) => handleChange(e.target.value)}
        disabled={loading}
        style={{
          width: '100%',
          padding: '8px 12px',
          fontSize: '14px',
          borderRadius: '8px',
          border: '1px solid var(--border-default, #e5e7eb)',
          backgroundColor: 'var(--surface-primary, #fff)',
          color: 'var(--text-primary, #111827)',
          cursor: 'pointer',
          outline: 'none',
        }}
      >
        <option value="">{placeholder}</option>
        {options.map((row, i) => (
          // The `value` attribute stays a RAW string on purpose: it is written into
          // viewState and bound into dependent queries, so formatting it would change
          // the selection, not its presentation. Only the option TEXT is formatted.
          <option key={i} value={String(row[valueField] ?? '')}>
            {formatCellValue(row[labelField] ?? row[valueField], { column: labelField, grouping: true, empty: '' })}
          </option>
        ))}
      </select>
      {suspended && <RoutingSuspendedInlineHint info={suspended} onRetry={refetch} />}
    </div>
  );
}
