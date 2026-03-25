import { useState, useEffect, useMemo } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import MetricCard from '../../shared/MetricCard';
import { sfQuery } from './helpers';

export default function DwellOverview() {
  const [kpis, setKpis] = useState<any[]>([]);
  const [trends, setTrends] = useState<any[]>([]);
  const [topFacilities, setTopFacilities] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      sfQuery(`SELECT COUNT(DISTINCT SESSION_ID) AS TOTAL_TRIPS, ROUND(AVG(DWELL_MINUTES),1) AS AVG_DWELL, ROUND(SUM(CASE WHEN DWELL_MINUTES <= 30 THEN 1 ELSE 0 END)*100.0/NULLIF(COUNT(*),0),1) AS SLA_PCT, COUNT(DISTINCT TRUCK_ID) AS ACTIVE_DRIVERS FROM DT_DWELL_ENRICHED`),
      sfQuery(`SELECT TREND_DATE AS DAY, TOTAL_SESSIONS AS TOTAL_DWELLS, ACTIVE_VEHICLES AS TOTAL_TRIPS FROM DT_DAILY_TRENDS ORDER BY TREND_DATE DESC LIMIT 30`),
      sfQuery(`SELECT LOCATION_NAME AS FACILITY_NAME, SUM(TOTAL_SESSIONS) AS TOTAL_VISITS FROM DT_FACILITY_UTILIZATION GROUP BY LOCATION_NAME ORDER BY TOTAL_VISITS DESC LIMIT 10`),
    ]).then(([k, t, f]) => {
      setKpis(k);
      setTrends(t);
      setTopFacilities(f);
      setLoading(false);
    });
  }, []);

  const k = kpis[0] || {};

  const trendData = useMemo(() =>
    [...trends].reverse().map((r: any) => ({
      day: String(r.DAY).slice(5),
      dwells: Number(r.TOTAL_DWELLS),
      trips: Number(r.TOTAL_TRIPS),
    })), [trends]);

  const facilityData = useMemo(() =>
    topFacilities.map((r: any) => ({
      name: String(r.FACILITY_NAME).slice(0, 20),
      visits: Number(r.TOTAL_VISITS),
    })), [topFacilities]);

  return (
    <div>
      <h3>Dwell Analysis Overview</h3>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>Fleet dwell time analytics and SLA monitoring</p>
      <div className="metric-grid">
        <MetricCard label="Total Trips" value={loading ? '...' : (k.TOTAL_TRIPS ?? '—')} />
        <MetricCard label="Avg Dwell Time" value={loading ? '...' : `${k.AVG_DWELL ?? '—'} min`} />
        <MetricCard label="SLA Compliance" value={loading ? '...' : `${k.SLA_PCT ?? '—'}%`} />
        <MetricCard label="Active Drivers" value={loading ? '...' : (k.ACTIVE_DRIVERS ?? '—')} />
      </div>
      <div className="chart-row">
        <div className="chart-card">
          <h3>Daily Trends (Last 30 Days)</h3>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={trendData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
              <XAxis dataKey="day" tick={{ fill: '#6E7681', fontSize: 11 }} />
              <YAxis tick={{ fill: '#6E7681', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
              <Line type="monotone" dataKey="dwells" stroke="#29B5E8" strokeWidth={2} dot={false} name="Dwells" />
              <Line type="monotone" dataKey="trips" stroke="#FF6B35" strokeWidth={2} dot={false} name="Trips" />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="chart-card">
          <h3>Top 10 Facilities by Visits</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={facilityData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
              <XAxis type="number" tick={{ fill: '#6E7681', fontSize: 11 }} />
              <YAxis type="category" dataKey="name" width={120} tick={{ fill: '#6E7681', fontSize: 10 }} />
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="visits" radius={[0, 4, 4, 0]} name="Visits">
                {facilityData.map((_: any, i: number) => (
                  <Cell key={i} fill={i < 3 ? '#29B5E8' : '#3d4454'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
