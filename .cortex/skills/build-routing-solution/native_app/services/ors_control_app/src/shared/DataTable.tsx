import { useState, useMemo } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';

interface DataTableProps {
  data: Record<string, any>[];
  columns?: string[];
  maxRows?: number;
}

export default function DataTable({ data, columns: explicitColumns, maxRows = 100 }: DataTableProps) {
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const columns = useMemo(() => {
    if (explicitColumns) return explicitColumns;
    if (data.length === 0) return [];
    return Object.keys(data[0]);
  }, [data, explicitColumns]);

  const sorted = useMemo(() => {
    if (!sortCol) return data.slice(0, maxRows);
    return [...data].sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol];
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    }).slice(0, maxRows);
  }, [data, sortCol, sortDir, maxRows]);

  const handleSort = (col: string) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  if (data.length === 0) return <div className="data-table-empty">No data</div>;

  return (
    <div className="data-table-container">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map(col => (
              <th key={col} onClick={() => handleSort(col)} className="data-table-th">
                {col}
                {sortCol === col && (sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={i}>
              {columns.map(col => (
                <td key={col}>{row[col] != null ? String(row[col]) : ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.length > maxRows && <div className="data-table-overflow">Showing {maxRows} of {data.length} rows</div>}
    </div>
  );
}
