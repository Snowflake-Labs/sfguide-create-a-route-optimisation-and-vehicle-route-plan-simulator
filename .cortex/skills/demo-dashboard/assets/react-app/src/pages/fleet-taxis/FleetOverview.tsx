import { useMemo } from 'react';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import MapView from '../../shared/MapView';
import MetricCard from '../../shared/MetricCard';
import { useSfQuery } from '../../hooks/useSnowflake';
import { useRegion } from '../../hooks/useRegion';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

export default function FleetOverview({ sourceDb, sourceSchema, config }: Props) {
  const { regionName, center, zoom } = useRegion();

  const { data: kpis } = useSfQuery(
    `SELECT COUNT(DISTINCT DRIVER_ID) AS DRIVERS, COUNT(DISTINCT TRIP_ID) AS TRIPS,
            ROUND(AVG(ROUTE_DISTANCE_METERS / 1000), 1) AS AVG_DISTANCE_KM,
            ROUND(AVG(ROUTE_DURATION_SECS / 60), 1) AS AVG_DURATION_MIN
     FROM TRIP_SUMMARY WHERE REGION = '${regionName}'`, sourceDb, sourceSchema, [regionName]);

  const { data: recent } = useSfQuery(
    `SELECT TRIP_ID, DRIVER_ID,
            ST_X(ORIGIN) AS P_LNG, ST_Y(ORIGIN) AS P_LAT,
            ST_X(DESTINATION) AS D_LNG, ST_Y(DESTINATION) AS D_LAT,
            ROUND(ROUTE_DISTANCE_METERS / 1000, 2) AS TRIP_DISTANCE_KM,
            ROUND(ROUTE_DURATION_SECS / 60, 1) AS TRIP_DURATION_MIN
     FROM TRIP_SUMMARY WHERE REGION = '${regionName}' ORDER BY TRIP_START_TIME DESC LIMIT 200`, sourceDb, sourceSchema, [regionName]);

  const { data: hourly } = useSfQuery(
    `SELECT HOUR(TRIP_START_TIME) AS HOUR, COUNT(*) AS TRIPS
     FROM TRIP_SUMMARY WHERE REGION = '${regionName}' GROUP BY 1 ORDER BY 1`, sourceDb, sourceSchema, [regionName]);

  const k = kpis[0] || {};

  const paths = useMemo(() =>
    recent.filter((r: any) => r.P_LNG && r.D_LNG).map((r: any) => ({
      path: [[Number(r.P_LNG), Number(r.P_LAT)], [Number(r.D_LNG), Number(r.D_LAT)]],
    })), [recent]);

  const layers = useMemo(() => {
    const l: any[] = [];
    if (paths.length) {
      l.push(new PathLayer({
        id: 'taxi-routes', data: paths, getPath: (d: any) => d.path,
        getColor: [41, 181, 232, 80], getWidth: 2, widthMinPixels: 1,
      }));
    }
    if (recent.length) {
      l.push(new ScatterplotLayer({
        id: 'pickups', data: recent.filter((r: any) => r.P_LNG),
        getPosition: (d: any) => [Number(d.P_LNG), Number(d.P_LAT)],
        getFillColor: [34, 197, 94, 120], getRadius: 30, radiusMinPixels: 2,
      }));
    }
    return l;
  }, [paths, recent]);

  const hourData = useMemo(() =>
    hourly.map((h: any) => ({ hour: `${h.HOUR}:00`, trips: Number(h.TRIPS) })), [hourly]);

  const viewState = useMemo(() => {
    const valid = recent.filter((r: any) => r.P_LNG && r.D_LNG);
    if (valid.length) {
      const lngs = valid.flatMap((r: any) => [Number(r.P_LNG), Number(r.D_LNG)]);
      const lats = valid.flatMap((r: any) => [Number(r.P_LAT), Number(r.D_LAT)]);
      return {
        longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2,
        latitude: (Math.min(...lats) + Math.max(...lats)) / 2,
        zoom: 11,
      };
    }
    const ors = config?.ors?.bounds?.center;
    if (ors?.lng && ors?.lat) return { longitude: ors.lng, latitude: ors.lat, zoom: 11 };
    return { longitude: center.lng, latitude: center.lat, zoom };
  }, [recent, config]);

  return (
    <div className="page-full">
      <div className="page-sidebar-panel">
        <h2>Fleet Overview</h2>
        <div className="metric-grid-vertical">
          <MetricCard label="Drivers" value={k.DRIVERS || '...'} />
          <MetricCard label="Total Trips" value={Number(k.TRIPS || 0).toLocaleString()} />
          <MetricCard label="Avg Distance" value={`${k.AVG_DISTANCE_KM || '...'} km`} />
          <MetricCard label="Avg Duration" value={`${k.AVG_DURATION_MIN || '...'} min`} />
        </div>
        <div className="chart-card">
          <h3>Trips by Hour</h3>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={hourData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="hour" tick={{ fill: '#6E7681', fontSize: 9 }} />
              <YAxis tick={{ fill: '#6E7681', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="trips" fill="#29B5E8" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <MapView layers={layers} initialViewState={viewState} />
    </div>
  );
}
