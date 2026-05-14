import { useState, useEffect, useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import MetricCard from '../../shared/MetricCard';
import { fmtDec } from '../../shared/format';
import { FD_DB, FD_SCHEMA, sfQuery, cartoBasemap } from './helpers';
import { useRegion } from '../../hooks/useRegion';
import { useVehicleType } from '../../hooks/useVehicleType';

export default function DeliveryDashboard() {
  const { regionName, center, zoom } = useRegion();
  const { vehicleType } = useVehicleType();
  const [kpis, setKpis] = useState<any>({});
  const [trips, setTrips] = useState<any[]>([]);
  const [hourly, setHourly] = useState<any[]>([]);
  const [courierStats, setCourierStats] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewState, setViewState] = useState({ longitude: center.lng, latitude: center.lat, zoom, pitch: 0, bearing: 0 });

  useEffect(() => {
    setLoading(true);
    Promise.all([
      sfQuery(`SELECT COUNT(DISTINCT COURIER_ID) AS COURIERS, COUNT(DISTINCT DELIVERY_ID) AS DELIVERIES, ROUND(AVG(DELIVERY_TIME_MIN), 1) AS AVG_DELIVERY_MIN, ROUND(AVG(DISTANCE_KM), 2) AS AVG_DISTANCE_KM, COUNT(CASE WHEN ORDER_STATUS = 'completed' THEN 1 END) AS COMPLETED FROM DELIVERIES`),
      sfQuery(`SELECT DELIVERY_ID, COURIER_ID, ST_X(PICKUP_LOCATION) AS P_LNG, ST_Y(PICKUP_LOCATION) AS P_LAT, ST_X(DROPOFF_LOCATION) AS D_LNG, ST_Y(DROPOFF_LOCATION) AS D_LAT, DELIVERY_TIME_MIN, ST_ASGEOJSON(GEOMETRY)::STRING AS ROUTE_GEOJSON FROM DELIVERIES ORDER BY ORDER_TIME DESC LIMIT 200`),
      sfQuery(`SELECT HOUR(ORDER_TIME) AS HOUR, COUNT(*) AS DELIVERIES FROM DELIVERIES GROUP BY 1 ORDER BY 1`),
      sfQuery(`SELECT COURIER_ID, COUNT(*) AS TRIPS, ROUND(AVG(DELIVERY_TIME_MIN), 1) AS AVG_MIN, ROUND(AVG(DISTANCE_KM), 2) AS AVG_KM FROM DELIVERIES GROUP BY COURIER_ID ORDER BY TRIPS DESC LIMIT 20`),
    ]).then(([k, t, h, c]) => {
      setKpis(k[0] || {});
      setTrips(t);
      if (t.length) {
        const lngs = t.filter((r: any) => r.P_LNG).map((r: any) => Number(r.P_LNG));
        const lats = t.filter((r: any) => r.P_LAT).map((r: any) => Number(r.P_LAT));
        if (lngs.length) setViewState(prev => ({ ...prev, longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2, latitude: (Math.min(...lats) + Math.max(...lats)) / 2 }));
      }
      setHourly(h);
      setCourierStats(c);
      setLoading(false);
    });
  }, [regionName, vehicleType]);

  useEffect(() => {
    setViewState(prev => ({ ...prev, longitude: center.lng, latitude: center.lat, zoom }));
  }, [center.lng, center.lat, zoom]);

  const basemap = useMemo(() => cartoBasemap(), []);

  const routeLayer = useMemo(() => {
    if (!trips.length) return null;
    return new PathLayer({
      id: 'delivery-routes',
      data: trips.filter((t: any) => t.P_LNG && t.P_LAT && t.D_LNG && t.D_LAT).map((t: any) => {
        if (t.ROUTE_GEOJSON) {
          try {
            const geo = JSON.parse(t.ROUTE_GEOJSON);
            if (geo.coordinates?.length > 1) return { path: geo.coordinates };
          } catch {}
        }
        return { path: [[Number(t.P_LNG), Number(t.P_LAT)], [Number(t.D_LNG), Number(t.D_LAT)]] };
      }),
      getPath: (d: any) => d.path,
      getColor: [41, 181, 232, 80],
      getWidth: 2,
      widthMinPixels: 1,
    });
  }, [trips]);

  const pickupLayer = useMemo(() => {
    if (!trips.length) return null;
    return new ScatterplotLayer({
      id: 'pickups',
      data: trips.filter((t: any) => t.P_LNG && t.P_LAT),
      getPosition: (d: any) => [Number(d.P_LNG), Number(d.P_LAT)],
      getFillColor: [34, 197, 94, 180],
      getRadius: 40, radiusMinPixels: 3,
    });
  }, [trips]);

  const layers = useMemo(() => [basemap, routeLayer, pickupLayer].filter(Boolean), [basemap, routeLayer, pickupLayer]);

  return (
    <div className="panel">
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Delivery Dashboard</h2>
      <p className="subtitle">Fleet-wide delivery analytics</p>
      <div className="metric-grid">
        <MetricCard label="Couriers" value={loading ? '...' : (kpis.COURIERS ?? '—')} />
        <MetricCard label="Deliveries" value={loading ? '...' : (kpis.DELIVERIES ?? '—')} />
        <MetricCard label="Avg Time" value={loading ? '...' : `${fmtDec(kpis.AVG_DELIVERY_MIN)} min`} />
        <MetricCard label="Avg Distance" value={loading ? '...' : `${fmtDec(kpis.AVG_DISTANCE_KM)} km`} />
        <MetricCard label="Completed" value={loading ? '...' : (kpis.COMPLETED ?? '—')} />
      </div>
      <div style={{ height: 400, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8', marginBottom: 12 }}>
        {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>Loading...</div>}
        <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} style={{ width: '100%', height: '100%' }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {hourly.length > 0 && (
          <div className="chart-card">
            <h3>Deliveries by Hour</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={hourly}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
                <XAxis dataKey="HOUR" tick={{ fill: '#6E7681', fontSize: 11 }} />
                <YAxis tick={{ fill: '#6E7681', fontSize: 11 }} />
                <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
                <Bar dataKey="DELIVERIES" fill="#29B5E8" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        {courierStats.length > 0 && (
          <div className="chart-card">
            <h3>Top Couriers</h3>
            <div style={{ maxHeight: 200, overflowY: 'auto' }}>
              <table className="sidebar-table">
                <thead><tr><th>Courier</th><th>Trips</th><th>Avg Min</th><th>Avg KM</th></tr></thead>
                <tbody>{courierStats.map((c: any) => (
                  <tr key={c.COURIER_ID}>
                    <td style={{ fontSize: 10 }}>{String(c.COURIER_ID).slice(-8)}</td>
                    <td>{c.TRIPS}</td>
                    <td>{fmtDec(c.AVG_MIN)}</td>
                    <td>{fmtDec(c.AVG_KM)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
