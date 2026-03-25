import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { sfQuery, cartoBasemap } from './helpers';

export default function FleetOverview() {
  const [kpis, setKpis] = useState<any>({});
  const [trips, setTrips] = useState<any[]>([]);
  const [hourly, setHourly] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewState, setViewState] = useState({ longitude: -122.43, latitude: 37.77, zoom: 11, pitch: 0, bearing: 0 });

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
    }).finally(() => setLoading(false));
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
    <div>
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Fleet Overview</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>Taxi fleet analytics</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
        {[
          { label: 'Drivers', value: kpis.DRIVERS ?? '—' },
          { label: 'Trips', value: kpis.TRIPS ?? '—' },
          { label: 'Avg Distance', value: `${kpis.AVG_DISTANCE_KM ?? '—'} km` },
          { label: 'Avg Duration', value: `${kpis.AVG_DURATION_MIN ?? '—'} min` },
        ].map(m => (
          <div key={m.label} style={{ padding: 16, borderRadius: 8, background: 'rgba(0,0,0,0.02)', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{m.label}</div>
            <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{m.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
        <div style={{ flex: 1, minWidth: 300 }}>
          <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
            {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>Loading...</div>}
            <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} style={{ width: '100%', height: '100%' }} />
          </div>
        </div>
      </div>

      {hourly.length > 0 && (
        <div>
          <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Trips by Hour</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={hourly}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="HOUR" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="TRIPS" fill="var(--accent)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
