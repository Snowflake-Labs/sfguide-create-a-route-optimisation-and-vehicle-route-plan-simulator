import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import MetricCard from '../../shared/MetricCard';
import { useSfQuery } from '../../hooks/useSnowflake';
import { FT_DB, FT_SCHEMA, cartoBasemap } from './helpers';
import { useRegion } from '../../hooks/useRegion';

export default function FleetOverview() {
  const { regionName, center, zoom } = useRegion();
  const { data: kpiRows, loading: kpiLoading } = useSfQuery(
    `SELECT COUNT(DISTINCT DRIVER_ID) AS DRIVERS, COUNT(DISTINCT TRIP_ID) AS TRIPS, ROUND(AVG(ROUTE_DISTANCE_METERS / 1000), 1) AS AVG_DISTANCE_KM, ROUND(AVG(ROUTE_DURATION_SECS / 60), 1) AS AVG_DURATION_MIN FROM TRIP_SUMMARY WHERE REGION = '${regionName}'`,
    FT_DB, FT_SCHEMA, [regionName],
  );
  const { data: trips, loading: tripsLoading } = useSfQuery(
    `SELECT TRIP_ID, DRIVER_ID, ST_X(ORIGIN) AS P_LNG, ST_Y(ORIGIN) AS P_LAT, ST_X(DESTINATION) AS D_LNG, ST_Y(DESTINATION) AS D_LAT, ROUND(ROUTE_DISTANCE_METERS / 1000, 2) AS TRIP_DISTANCE_KM, ROUND(ROUTE_DURATION_SECS / 60, 1) AS TRIP_DURATION_MIN FROM TRIP_SUMMARY WHERE REGION = '${regionName}' ORDER BY TRIP_START_TIME DESC LIMIT 200`,
    FT_DB, FT_SCHEMA, [regionName],
  );
  const { data: hourly } = useSfQuery(
    `SELECT HOUR(TRIP_START_TIME) AS HOUR, COUNT(*) AS TRIPS FROM TRIP_SUMMARY WHERE REGION = '${regionName}' GROUP BY 1 ORDER BY 1`,
    FT_DB, FT_SCHEMA, [regionName],
  );

  const kpis = kpiRows[0] || {};
  const loading = kpiLoading || tripsLoading;
  const [viewState, setViewState] = useState({ longitude: center.lng, latitude: center.lat, zoom, pitch: 0, bearing: 0 });

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
    <div className="page-dashboard">
      <h2>Fleet Overview</h2>
      <p>Taxi fleet analytics</p>
      <div className="metric-grid">
        <MetricCard label="Drivers" value={loading ? '...' : (kpis.DRIVERS ?? '—')} />
        <MetricCard label="Trips" value={loading ? '...' : (kpis.TRIPS ?? '—')} />
        <MetricCard label="Avg Distance" value={loading ? '...' : `${kpis.AVG_DISTANCE_KM ?? '—'} km`} />
        <MetricCard label="Avg Duration" value={loading ? '...' : `${kpis.AVG_DURATION_MIN ?? '—'} min`} />
      </div>
      <div className="inline-map">
        {loading && <div className="map-loading-overlay">Loading...</div>}
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
