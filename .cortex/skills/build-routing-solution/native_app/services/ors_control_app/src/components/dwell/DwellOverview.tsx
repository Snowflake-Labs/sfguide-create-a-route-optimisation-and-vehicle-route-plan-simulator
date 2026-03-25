import { useState, useEffect, useMemo } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { sfQuery } from './helpers';

export default function DwellOverview() {
  const [kpis, setKpis] = useState<any[]>([]);
  const [trends, setTrends] = useState<any[]>([]);
  const [topFacilities, setTopFacilities] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      sfQuery(`SELECT COUNT(DISTINCT TRIP_ID) AS TOTAL_TRIPS, ROUND(AVG(DWELL_DURATION_MIN),1) AS AVG_DWELL, ROUND(SUM(CASE WHEN SLA_BREACH=FALSE THEN 1 ELSE 0 END)*100.0/NULLIF(COUNT(*),0),1) AS SLA_PCT, COUNT(DISTINCT DRIVER_ID) AS ACTIVE_DRIVERS FROM DT_DWELL_ENRICHED`),
      sfQuery(`SELECT DAY, TOTAL_DWELLS, TOTAL_TRIPS FROM DT_DAILY_TRENDS ORDER BY DAY DESC LIMIT 30`),
      sfQuery(`SELECT FACILITY_NAME, TOTAL_VISITS FROM DT_FACILITY_UTILIZATION ORDER BY TOTAL_VISITS DESC LIMIT 10`),
    ]).then(([k, t, f]) => {
      setKpis(k);
      setTrends(t.reverse());
      setTopFacilities(f);
    }).finally(() => setLoading(false));
  }, []);

  const k = kpis[0] || {};

  return (
    <div>
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Dwell Analysis Overview</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>Fleet dwell time analytics and SLA monitoring</p>

      {loading && <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: 16 }}>Loading...</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
        <div style={{ padding: 16, borderRadius: 8, background: 'rgba(0,0,0,0.02)', border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Total Trips</div>
          <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{k.TOTAL_TRIPS ?? '—'}</div>
        </div>
        <div style={{ padding: 16, borderRadius: 8, background: 'rgba(0,0,0,0.02)', border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Avg Dwell Time</div>
          <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{k.AVG_DWELL ?? '—'} min</div>
        </div>
        <div style={{ padding: 16, borderRadius: 8, background: 'rgba(0,0,0,0.02)', border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>SLA Compliance</div>
          <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{k.SLA_PCT ?? '—'}%</div>
        </div>
        <div style={{ padding: 16, borderRadius: 8, background: 'rgba(0,0,0,0.02)', border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Active Drivers</div>
          <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{k.ACTIVE_DRIVERS ?? '—'}</div>
        </div>
      </div>

      {trends.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Daily Trends (Last 30 Days)</h3>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={trends}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="DAY" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Line type="monotone" dataKey="TOTAL_DWELLS" stroke="var(--accent)" strokeWidth={2} dot={false} name="Dwells" />
              <Line type="monotone" dataKey="TOTAL_TRIPS" stroke="var(--green)" strokeWidth={2} dot={false} name="Trips" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {topFacilities.length > 0 && (
        <div>
          <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Top 10 Facilities by Visits</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={topFacilities} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="FACILITY_NAME" width={120} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="TOTAL_VISITS" fill="var(--accent)" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
