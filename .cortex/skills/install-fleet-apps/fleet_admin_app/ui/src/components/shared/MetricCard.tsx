'use client';
import { formatCellValue } from '@/lib/format-number';

interface MetricCardProps {
  label: string;
  value: string | number;
  subtitle?: string;
}

export default function MetricCard({ label, value, subtitle }: MetricCardProps) {
  // A raw {value} printed the full binary expansion of any FLOAT the page handed
  // it. The label doubles as the column name so a coordinate tile keeps its 5dp.
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{formatCellValue(value, { column: label, grouping: true })}</div>
      {subtitle && <div className="metric-subtitle">{subtitle}</div>}
    </div>
  );
}
