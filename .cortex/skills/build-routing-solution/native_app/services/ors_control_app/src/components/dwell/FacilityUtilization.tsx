import { useMemo } from 'react';
import { BarChart, Bar, ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import MetricCard from '../../shared/MetricCard';
import DataTable from '../../shared/DataTable';
import { useSfQuery } from '../../hooks/useSnowflake';
import { DWELL_DB, DWELL_SCHEMA } from './helpers';

export default function FacilityUtilization() {
  const { data, loading } = useSfQuery(
    `SELECT LOCATION_NAME AS FACILITY_NAME, FACILITY_TYPE, SUM(TOTAL_SESSIONS) AS TOTAL_VISITS, ROUND(AVG(AVG_DWELL_MIN),1) AS AVG_DWELL_MINUTES, SUM(UNIQUE_VEHICLES) AS UNIQUE_DRIVERS, NULL AS PEAK_HOUR, 0 AS SLA_BREACH_RATE FROM DT_FACILITY_UTILIZATION GROUP BY LOCATION_NAME, FACILITY_TYPE ORDER BY TOTAL_VISITS DESC LIMIT 50`,
    DWELL_DB, DWELL_SCHEMA,
  );

  const top15 = useMemo(() => data.slice(0, 15), [data]);
  const totalVisits = useMemo(() => data.reduce((s, r) => s + Number(r.TOTAL_VISITS || 0), 0), [data]);
  const avgDwell = useMemo(() => {
    if (data.length === 0) return 0;
    return (data.reduce((s, r) => s + Number(r.AVG_DWELL_MINUTES || 0), 0) / data.length).toFixed(1);
  }, [data]);
  const busiest = data[0]?.FACILITY_NAME || '—';
  const types = useMemo(() => new Set(data.map(r => r.FACILITY_TYPE)).size, [data]);

  return (
    <div className="page-dashboard">
      <h2>Facility Utilization</h2>
      <p>Dwell time patterns across facilities</p>
      <div className="metric-grid">
        <MetricCard label="Total Visits" value={loading ? '...' : totalVisits.toLocaleString()} />
        <MetricCard label="Avg Dwell" value={loading ? '...' : `${avgDwell} min`} />
        <MetricCard label="Busiest" value={loading ? '...' : busiest} />
        <MetricCard label="Facility Types" value={loading ? '...' : types} />
      </div>
      <div className="chart-row">
        <div className="chart-card">
          <h3>Top 15 Facilities</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={top15}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="FACILITY_NAME" tick={{ fill: '#6E7681', fontSize: 10 }} angle={-30} textAnchor="end" height={60} />
              <YAxis yAxisId="left" tick={{ fill: '#6E7681', fontSize: 11 }} />
              <YAxis yAxisId="right" orientation="right" tick={{ fill: '#6E7681', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
              <Bar yAxisId="left" dataKey="TOTAL_VISITS" fill="#29B5E8" name="Visits" radius={[4, 4, 0, 0]} />
              <Bar yAxisId="right" dataKey="AVG_DWELL_MINUTES" fill="#E5A100" name="Avg Dwell (min)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="chart-card">
          <h3>Throughput vs Dwell Time</h3>
          <ResponsiveContainer width="100%" height={300}>
            <ScatterChart>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="TOTAL_VISITS" name="Visits" tick={{ fill: '#6E7681', fontSize: 11 }} />
              <YAxis dataKey="AVG_DWELL_MINUTES" name="Avg Dwell (min)" tick={{ fill: '#6E7681', fontSize: 11 }} />
              <ZAxis dataKey="UNIQUE_DRIVERS" range={[40, 400]} name="Drivers" />
              <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
              <Scatter data={data} fill="#29B5E8" opacity={0.7} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>
      <h3>All Facilities</h3>
      <DataTable data={data} columns={['FACILITY_NAME', 'FACILITY_TYPE', 'TOTAL_VISITS', 'AVG_DWELL_MINUTES', 'UNIQUE_DRIVERS']} />
    </div>
  );
}
