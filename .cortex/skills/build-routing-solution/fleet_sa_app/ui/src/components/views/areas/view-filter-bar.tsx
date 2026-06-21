'use client';

import { useViewData } from '@/hooks/use-view-data';
import { useAppStore } from '@/lib/store';

interface FilterDef {
  name: string;
  label?: string;
  data: {
    query: string;
    mapping?: { value: string; label: string };
  };
  emits?: Record<string, string>;
}

interface ViewFilterBarAreaProps {
  areaConfig: {
    filters?: FilterDef[];
    data?: {
      queries?: Record<string, { query: string; mapping?: { value: string; label: string } }>;
    };
    emits?: Record<string, string>;
  };
}

function FilterSelect({
  filter,
}: {
  filter: FilterDef;
}) {
  const { data, loading } = useViewData(filter.data.query);
  const updateViewState = useAppStore((s) => s.updateViewState);
  const viewState = useAppStore((s) => s.panel.viewState);

  const valueField = filter.data.mapping?.value || 'value';
  const labelField = filter.data.mapping?.label || 'label';

  const emitKey = filter.emits ? Object.keys(filter.emits)[0] : null;
  const currentValue = emitKey ? (viewState[emitKey] as string) || '' : '';

  const options = data?.rows || [];

  const handleChange = (value: string) => {
    if (emitKey) {
      updateViewState({ [emitKey]: value || null });
    }
  };

  return (
    <div style={{ minWidth: '160px' }}>
      <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary, #6b7280)', marginBottom: '4px', textTransform: 'uppercase' }}>
        {filter.label || filter.name}
      </label>
      <select
        value={currentValue}
        onChange={(e) => handleChange(e.target.value)}
        disabled={loading}
        style={{
          width: '100%',
          padding: '6px 10px',
          fontSize: '13px',
          borderRadius: '6px',
          border: '1px solid var(--border-default, #e5e7eb)',
          backgroundColor: 'var(--surface-primary, #fff)',
          color: 'var(--text-primary, #111827)',
          cursor: 'pointer',
          outline: 'none',
        }}
      >
        <option value="">All</option>
        {options.map((row, i) => (
          <option key={i} value={String(row[valueField] ?? '')}>
            {String(row[labelField] ?? row[valueField] ?? '')}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ViewFilterBarArea({ areaConfig }: ViewFilterBarAreaProps) {
  const filters = areaConfig.filters || [];

  if (filters.length === 0 && areaConfig.data?.queries) {
    const queries = areaConfig.data.queries;
    const emits = areaConfig.emits || {};
    return (
      <div style={{ display: 'flex', gap: '16px', padding: '12px 16px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {Object.entries(queries).map(([name, config]) => {
          const emitSource = `${name}.selection`;
          const emitKey = Object.entries(emits).find(([, v]) => v === emitSource)?.[0] ?? null;
          const filterDef: FilterDef = {
            name,
            data: config,
            emits: emitKey ? { [emitKey]: 'selection' } : undefined,
          };
          return <FilterSelect key={name} filter={filterDef} />;
        })}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: '16px', padding: '12px 16px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
      {filters.map((filter) => (
        <FilterSelect key={filter.name} filter={filter} />
      ))}
    </div>
  );
}
