import { useState, useEffect, useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import MetricCard from '../../shared/MetricCard';
import { FT_DB, FT_SCHEMA, sfQuery, cartoBasemap } from './helpers';

export default function FleetOverview() {
  const [kpis, setKpis] = useState<any>({});
  const [trips, setTrips] = useState<any[]>([]);
  const [hourly, setHourly] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewState, setViewState] = useState({ longitude: -73.98, latitude: 40.75, zoom: 11, pitch: 0, bearing: 0 });

  useEffect(() => {
    setLoading(true);
    Promise.all([
      sfQuery(`SELECT COUNT(DISTINCT DRIVER_ID) AS DRIVERS, COUNT(DISTINCT TRIP_ID) AS TRIPS, ROUND(AVG(ROUTE_DISTANCE_METERS / 1000), 1) AS AVG_DISTANCE_KM, ROUND(AVG(ROUTE_DURATION_SECS / 60), 1) AS AVG_DURATION_MIN FROM TRIP_SUMMARY`),
      sfQuery(`SELECT TRIP_ID, DRIVER_ID, ST_X(ORIGIN) AS P_LNG, ST_Y(ORIGIN) AS P_LAT, ST_X(DESTINATION) AS D_LNG, ST_Y(DESTINATION) AS D_LAT, ROUND(ROUTE_DISTANCE_METERS / 1000, 2) AS TRIP_DISTANCE_KM, ROUND(ROUTE_DURATION_SECS / 60, 1) AS TRIP_DURATION_MIN FROM TRIP_SUMMARY ORDER BY TRIP_START_TIME DESC LIMIT 200`),
      sfQuery(`SELECT HOUR(TRIP_START_TIME) AS HOUR, COUNT(*) AS TRIPS FROM TRIP_SUMMARY GROUP BY 1 ORDER BY 1`),
    ]).then(([k, t, h]) => {
      setKpis(k[0] || {});
      setTrips(t);
      setHourly(h);
      setLoading(false);
    });
  }, []);

  const basemap = useMemo(() => cartoBasemap(), []);

  const routeLayer = useMemo(() => {
    if (!trips.length) return null;
    return new PathLayer({
      id: 'taxi-routes',
      data: trips.filter((t: any) => t.P_LNG && t.P_LAT && t.D_LNG && t.D_LAT).map((t: any) => ({
        path: [[Number(t.P_LNG), Number(t.P_LAT)], [Number(t.D_LNG), Number(t.D_LAT)]],
      })),
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
      getRadius: 40,
      radiusMinPixels: 3,
    });
  }, [trips]);

  const layers = useMemo(() => [basemap, routeLayer, pickupLayer].filter(Boolean), [basemap, routeLayer, pickupLayer]);

  return (
    <div className="panel">
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Fleet Overview</h2>
      <p className="subtitle">Taxi fleet analytics</p>
      <div className="metric-grid">
        <MetricCard label="Drivers" value={loading ? '...' : (kpis.DRIVERS ?? '—')} />
        <MetricCard label="Trips" value={loading ? '...' : (kpis.TRIPS ?? '—')} />
        <MetricCard label="Avg Distance" value={loading ? '...' : `${kpis.AVG_DISTANCE_KM ?? '—'} km`} />
        <MetricCard label="Avg Duration" value={loading ? '...' : `${kpis.AVG_DURATION_MIN ?? '—'} min`} />
      </div>
      <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8', marginBottom: 12 }}>
        {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>Loading...</div>}
        <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} style={{ width: '100%', height: '100%' }} />
      </div>
      {hourly.length > 0 && (
        <div className="chart-card">
          <h3>Trips by Hour</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={hourly}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
              <XAxis dataKey="HOUR" tick={{ fill: '#6E7681', fontSize: 11 }} />
              <YAxis tick={{ fill: '#6E7681', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="TRIPS" fill="#29B5E8" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
