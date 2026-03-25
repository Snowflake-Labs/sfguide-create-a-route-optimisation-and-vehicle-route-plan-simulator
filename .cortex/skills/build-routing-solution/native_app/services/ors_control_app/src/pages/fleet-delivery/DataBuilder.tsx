import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import MetricCard from '../../shared/MetricCard';
import DataTable from '../../shared/DataTable';
import { useSfQuery } from '../../hooks/useSnowflake';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

export default function DataBuilder({ sourceDb, sourceSchema }: Props) {
  const { data: tables, loading } = useSfQuery(
    `SELECT TABLE_NAME, ROW_COUNT, BYTES, LAST_ALTERED
     FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '${sourceSchema}'
     ORDER BY ROW_COUNT DESC`,
    sourceDb, 'INFORMATION_SCHEMA');

  const { data: cityStats } = useSfQuery(
    `SELECT CITY_NAME, TOTAL_RESTAURANTS, TOTAL_CUSTOMERS, TOTAL_COURIERS, TOTAL_DELIVERIES
     FROM CITY_STATS ORDER BY TOTAL_DELIVERIES DESC LIMIT 10`, sourceDb, sourceSchema);

  const chartData = useMemo(() =>
    tables.filter((t: any) => Number(t.ROW_COUNT) > 0).slice(0, 12).map((t: any) => ({
      name: String(t.TABLE_NAME).slice(0, 18),
      rows: Number(t.ROW_COUNT),
      mb: Math.round(Number(t.BYTES) / (1024 * 1024)),
    })), [tables]);

  const totalRows = tables.reduce((s: number, t: any) => s + Number(t.ROW_COUNT || 0), 0);
  const totalMb = tables.reduce((s: number, t: any) => s + Number(t.BYTES || 0), 0) / (1024 * 1024);

  return (
    <div className="page-dashboard">
      <h2>Data Builder</h2>
      <p>Data pipeline status for <code>{sourceDb}.{sourceSchema}</code></p>
      <div className="metric-grid">
        <MetricCard label="Tables" value={loading ? '...' : tables.length} />
        <MetricCard label="Total Rows" value={loading ? '...' : totalRows.toLocaleString()} />
        <MetricCard label="Storage" value={loading ? '...' : `${totalMb.toFixed(1)} MB`} />
        <MetricCard label="Cities" value={cityStats.length || '...'} />
      </div>
      <div className="chart-row">
        <div className="chart-card">
          <h3>Table Sizes (rows)</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="name" tick={{ fill: '#6E7681', fontSize: 10 }} angle={-30} textAnchor="end" height={60} />
              <YAxis tick={{ fill: '#6E7681', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="rows" fill="#29B5E8" radius={[4, 4, 0, 0]} name="Rows" />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="chart-card">
          <h3>City Statistics</h3>
          {cityStats.length > 0 ? (
            <DataTable data={cityStats} columns={['CITY_NAME', 'TOTAL_RESTAURANTS', 'TOTAL_CUSTOMERS', 'TOTAL_COURIERS', 'TOTAL_DELIVERIES']} />
          ) : <p style={{ color: '#9CA3AF', fontSize: 13 }}>No cities provisioned yet. Run the data generation pipeline.</p>}
        </div>
      </div>
      <div className="chart-card" style={{ marginTop: 16 }}>
        <h3>All Tables</h3>
        <DataTable data={tables} columns={['TABLE_NAME', 'ROW_COUNT', 'BYTES', 'LAST_ALTERED']} />
      </div>
    </div>
  );
}
