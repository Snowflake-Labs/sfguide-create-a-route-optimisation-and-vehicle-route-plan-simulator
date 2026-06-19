import MetricCard from '../../shared/MetricCard';
import type { MetricCardsArea as MetricCardsSpec } from '../spec-types';
import { useDataSource } from '../useDataSource';
import { formatValue } from '../format-value';
import type { AreaComponentProps } from './types';

/**
 * Renders KPI tiles from the first row of its data source, one MetricCard per
 * mapping.metric. Matches the `metric-grid` + MetricCard pattern used across
 * the hand-coded dashboards (e.g. DwellOverview, FleetMap).
 */
export default function MetricCardsArea({ area, scope, defaults }: AreaComponentProps) {
  const spec = area as MetricCardsSpec;
  const { rows, loading } = useDataSource(spec.data, scope, defaults);
  const row = rows[0] ?? {};

  return (
    <div className="metric-grid">
      {spec.mapping.metrics.map((m) => (
        <MetricCard
          key={m.column}
          label={m.label}
          value={loading ? '...' : formatValue(row[m.column], m.format, m.suffix)}
        />
      ))}
    </div>
  );
}
