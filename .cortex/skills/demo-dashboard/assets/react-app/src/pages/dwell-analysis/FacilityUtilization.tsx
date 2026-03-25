import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ScatterChart, Scatter, ZAxis } from 'recharts';
import MetricCard from '../../shared/MetricCard';
import DataTable from '../../shared/DataTable';
import { useSfQuery } from '../../hooks/useSnowflake';
import { useRegion } from '../../hooks/useRegion';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

export default function FacilityUtilization({ sourceDb, sourceSchema }: Props) {
  const { regionName } = useRegion();

  const { data, loading } = useSfQuery(
    `SELECT FACILITY_NAME, FACILITY_TYPE, TOTAL_VISITS, ROUND(AVG_DWELL_MIN, 1) AS AVG_DWELL_MIN,
            ROUND(P95_DWELL_MIN, 1) AS P95_DWELL_MIN, UNIQUE_DRIVERS, PEAK_HOUR
     FROM DT_FACILITY_UTILIZATION WHERE REGION = '${regionName}' ORDER BY TOTAL_VISITS DESC LIMIT 50`,
    sourceDb, sourceSchema, [regionName],
  );

  const kpis = useMemo(() => {
    if (!data.length) return { total: 0, avgDwell: 0, busiest: '--', types: 0 };
    const totalVisits = data.reduce((s: number, r: any) => s + Number(r.TOTAL_VISITS), 0);
    const avgDwell = (data.reduce((s: number, r: any) => s + Number(r.AVG_DWELL_MIN), 0) / data.length).toFixed(1);
    const busiest = data[0]?.FACILITY_NAME || '--';
    const types = new Set(data.map((r: any) => r.FACILITY_TYPE)).size;
    return { total: totalVisits, avgDwell, busiest, types };
  }, [data]);

  const chartData = useMemo(() =>
    data.slice(0, 15).map((r: any) => ({
      name: String(r.FACILITY_NAME).slice(0, 18),
      visits: Number(r.TOTAL_VISITS),
      avgMin: Number(r.AVG_DWELL_MIN),
    })), [data]);

  const scatterData = useMemo(() =>
    data.map((r: any) => ({
      x: Number(r.TOTAL_VISITS),
      y: Number(r.AVG_DWELL_MIN),
      z: Number(r.UNIQUE_DRIVERS),
      name: r.FACILITY_NAME,
    })), [data]);

  return (
    <div className="page-dashboard">
      <h2>Facility Utilization</h2>
      <div className="metric-grid">
        <MetricCard label="Total Visits" value={loading ? '...' : kpis.total.toLocaleString()} />
        <MetricCard label="Avg Dwell" value={loading ? '...' : `${kpis.avgDwell} min`} />
        <MetricCard label="Busiest" value={loading ? '...' : String(kpis.busiest).slice(0, 20)} />
        <MetricCard label="Facility Types" value={loading ? '...' : kpis.types} />
      </div>
      <div className="chart-row">
        <div className="chart-card">
          <h3>Top Facilities - Visits vs Dwell</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="name" tick={{ fill: '#6E7681', fontSize: 10 }} angle={-30} textAnchor="end" height={60} />
              <YAxis yAxisId="l" tick={{ fill: '#6E7681', fontSize: 11 }} />
              <YAxis yAxisId="r" orientation="right" tick={{ fill: '#6E7681', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
              <Bar yAxisId="l" dataKey="visits" fill="#29B5E8" radius={[4, 4, 0, 0]} name="Visits" />
              <Bar yAxisId="r" dataKey="avgMin" fill="#FF6B35" radius={[4, 4, 0, 0]} name="Avg Dwell (min)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="chart-card">
          <h3>Throughput vs Dwell Time</h3>
          <ResponsiveContainer width="100%" height={280}>
            <ScatterChart>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="x" name="Visits" tick={{ fill: '#6E7681', fontSize: 11 }} />
              <YAxis dataKey="y" name="Avg Dwell (min)" tick={{ fill: '#6E7681', fontSize: 11 }} />
              <ZAxis dataKey="z" range={[20, 200]} />
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
              <Scatter data={scatterData} fill="#29B5E8" fillOpacity={0.7} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="chart-card" style={{ marginTop: 16 }}>
        <h3>All Facilities</h3>
        <DataTable data={data} columns={['FACILITY_NAME', 'FACILITY_TYPE', 'TOTAL_VISITS', 'AVG_DWELL_MIN', 'P95_DWELL_MIN', 'UNIQUE_DRIVERS', 'PEAK_HOUR']} />
      </div>
    </div>
  );
}
