import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import MetricCard from '../../shared/MetricCard';
import DataTable from '../../shared/DataTable';
import { useSfQuery } from '../../hooks/useSnowflake';
import { FD_SCHEMA, formatNumber, formatBytes } from './helpers';

export default function DataBuilder() {
  const { data: tables, loading: tablesLoading } = useSfQuery(
    `SELECT TABLE_NAME, ROW_COUNT, BYTES, LAST_ALTERED FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '${FD_SCHEMA}' ORDER BY ROW_COUNT DESC`,
    'FLEET_INTELLIGENCE', 'INFORMATION_SCHEMA',
  );

  const { data: cityStats, loading: citiesLoading } = useSfQuery(
    `SELECT CITY_NAME, TOTAL_RESTAURANTS, TOTAL_CUSTOMERS, TOTAL_COURIERS, TOTAL_DELIVERIES FROM CITY_STATS ORDER BY TOTAL_DELIVERIES DESC LIMIT 10`,
    'FLEET_INTELLIGENCE', FD_SCHEMA,
  );

  const loading = tablesLoading || citiesLoading;
  const totalRows = useMemo(() => tables.reduce((s, t) => s + Number(t.ROW_COUNT || 0), 0), [tables]);
  const totalBytes = useMemo(() => tables.reduce((s, t) => s + Number(t.BYTES || 0), 0), [tables]);

  return (
    <div className="page-dashboard">
      <h2>Data Builder</h2>
      <p>Fleet delivery data inventory</p>
      <div className="metric-grid">
        <MetricCard label="Tables" value={loading ? '...' : tables.length} />
        <MetricCard label="Total Rows" value={loading ? '...' : formatNumber(totalRows)} />
        <MetricCard label="Storage" value={loading ? '...' : formatBytes(totalBytes)} />
        <MetricCard label="Cities" value={loading ? '...' : cityStats.length} />
      </div>
      <div className="chart-row">
        <div className="chart-card">
          <h3>Table Sizes</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={tables.slice(0, 15)} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
              <XAxis type="number" tick={{ fill: '#6E7681', fontSize: 11 }} />
              <YAxis type="category" dataKey="TABLE_NAME" width={140} tick={{ fill: '#6E7681', fontSize: 10 }} />
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="ROW_COUNT" fill="#29B5E8" name="Rows" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <h3>City Stats</h3>
      <DataTable data={cityStats} columns={['CITY_NAME', 'TOTAL_RESTAURANTS', 'TOTAL_CUSTOMERS', 'TOTAL_COURIERS', 'TOTAL_DELIVERIES']} />
      <h3>All Tables</h3>
      <DataTable data={tables} columns={['TABLE_NAME', 'ROW_COUNT', 'BYTES', 'LAST_ALTERED']} />
    </div>
  );
}
