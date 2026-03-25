import { useState, useEffect, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { sfQuery, FD_SCHEMA, formatNumber, formatBytes } from './helpers';

export default function DataBuilder() {
  const [tables, setTables] = useState<any[]>([]);
  const [cityStats, setCityStats] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      sfQuery(`SELECT TABLE_NAME, ROW_COUNT, BYTES, LAST_ALTERED FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '${FD_SCHEMA}' ORDER BY ROW_COUNT DESC`, 'FLEET_INTELLIGENCE', 'INFORMATION_SCHEMA'),
      sfQuery(`SELECT CITY_NAME, TOTAL_RESTAURANTS, TOTAL_CUSTOMERS, TOTAL_COURIERS, TOTAL_DELIVERIES FROM CITY_STATS ORDER BY TOTAL_DELIVERIES DESC LIMIT 10`),
    ]).then(([t, c]) => {
      setTables(t);
      setCityStats(c);
    }).finally(() => setLoading(false));
  }, []);

  const totalRows = useMemo(() => tables.reduce((s, t) => s + Number(t.ROW_COUNT || 0), 0), [tables]);
  const totalBytes = useMemo(() => tables.reduce((s, t) => s + Number(t.BYTES || 0), 0), [tables]);

  return (
    <div>
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Data Builder</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>Fleet delivery data inventory</p>

      {loading && <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: 16 }}>Loading...</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Tables', value: tables.length },
          { label: 'Total Rows', value: formatNumber(totalRows) },
          { label: 'Storage', value: formatBytes(totalBytes) },
          { label: 'Cities', value: cityStats.length },
        ].map(m => (
          <div key={m.label} style={{ padding: 16, borderRadius: 8, background: 'rgba(0,0,0,0.02)', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{m.label}</div>
            <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{m.value}</div>
          </div>
        ))}
      </div>

      {tables.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Table Sizes</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={tables.slice(0, 15)} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="TABLE_NAME" width={140} tick={{ fontSize: 10 }} />
              <Tooltip />
              <Bar dataKey="ROW_COUNT" fill="var(--accent)" name="Rows" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {cityStats.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>City Stats</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr>{['City', 'Restaurants', 'Customers', 'Couriers', 'Deliveries'].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontWeight: 500 }}>{h}</th>)}</tr></thead>
              <tbody>{cityStats.map((r, i) => (
                <tr key={i} style={{ borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                  <td style={{ padding: '8px 12px', fontWeight: 500 }}>{r.CITY_NAME}</td>
                  <td style={{ padding: '8px 12px' }}>{r.TOTAL_RESTAURANTS}</td>
                  <td style={{ padding: '8px 12px' }}>{r.TOTAL_CUSTOMERS}</td>
                  <td style={{ padding: '8px 12px' }}>{r.TOTAL_COURIERS}</td>
                  <td style={{ padding: '8px 12px' }}>{Number(r.TOTAL_DELIVERIES).toLocaleString()}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}

      {tables.length > 0 && (
        <div>
          <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>All Tables</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr>{['Table', 'Rows', 'Size', 'Last Altered'].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontWeight: 500 }}>{h}</th>)}</tr></thead>
              <tbody>{tables.map((t, i) => (
                <tr key={i} style={{ borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                  <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 11 }}>{t.TABLE_NAME}</td>
                  <td style={{ padding: '8px 12px' }}>{formatNumber(Number(t.ROW_COUNT || 0))}</td>
                  <td style={{ padding: '8px 12px' }}>{formatBytes(Number(t.BYTES || 0))}</td>
                  <td style={{ padding: '8px 12px', fontSize: 11 }}>{t.LAST_ALTERED}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
