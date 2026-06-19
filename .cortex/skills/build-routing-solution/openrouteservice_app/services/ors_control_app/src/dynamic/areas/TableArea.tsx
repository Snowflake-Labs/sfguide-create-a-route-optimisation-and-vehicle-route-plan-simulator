import DataTable from '../../shared/DataTable';
import type { TableArea as TableSpec } from '../spec-types';
import { useDataSource } from '../useDataSource';
import type { AreaComponentProps } from './types';

/**
 * Renders a sortable table from its data source via the existing shared
 * DataTable. Optional explicit columns/maxRows come from config; otherwise
 * DataTable auto-detects columns from the row keys.
 */
export default function TableArea({ area, scope, defaults }: AreaComponentProps) {
  const spec = area as TableSpec;
  const { rows, loading, error } = useDataSource(spec.data, scope, defaults);

  const columns = spec.config?.columns?.map((c) => c.field);

  if (loading) return <div className="data-table-empty">Loading...</div>;
  if (error) return <div className="data-table-empty">Error: {error}</div>;

  return (
    <div className="dynamic-table-area">
      {spec.title && <h3>{spec.title}</h3>}
      <DataTable data={rows} columns={columns} maxRows={spec.config?.maxRows ?? 100} />
    </div>
  );
}
