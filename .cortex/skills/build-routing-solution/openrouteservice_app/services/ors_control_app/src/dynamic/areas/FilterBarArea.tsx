import { useEffect } from 'react';
import type { FilterBarArea as FilterBarSpec, FilterDef } from '../spec-types';
import type { BindingScope } from '../spec-runtime';
import { useDataSource } from '../useDataSource';
import type { AreaComponentProps } from './types';

interface FilterControlProps {
  filter: FilterDef;
  scope: BindingScope;
  defaults: { database?: string; schema?: string };
  onViewState?: (key: string, value: unknown) => void;
}

/**
 * A single dropdown whose options come from a DISTINCT-value query. On change
 * it writes the selected value into viewState under the filter's `emits` key,
 * which other areas reference via `:param` placeholders.
 */
export function FilterControl({ filter, scope, defaults, onViewState }: FilterControlProps) {
  const { rows } = useDataSource(filter.data, scope, defaults);
  const current = scope.viewState[filter.emits];

  // Seed viewState with the first option so dependent queries have a value.
  useEffect(() => {
    if (current == null && rows.length > 0) {
      onViewState?.(filter.emits, rows[0][filter.data.mapping.value]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  return (
    <label className="filter-control">
      <span className="filter-label">{filter.label}</span>
      <select
        value={current == null ? '' : String(current)}
        onChange={(e) => onViewState?.(filter.emits, e.target.value)}
      >
        {rows.map((r, i) => (
          <option key={i} value={String(r[filter.data.mapping.value])}>
            {String(r[filter.data.mapping.label])}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function FilterBarArea({ area, scope, defaults, onViewState }: AreaComponentProps) {
  const spec = area as FilterBarSpec;
  return (
    <div className="filter-bar">
      {spec.filters.map((f) => (
        <FilterControl key={f.name} filter={f} scope={scope} defaults={defaults} onViewState={onViewState} />
      ))}
    </div>
  );
}
