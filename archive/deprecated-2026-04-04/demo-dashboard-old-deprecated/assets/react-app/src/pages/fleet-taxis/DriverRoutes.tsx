import { useMemo, useState, useCallback } from 'react';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import MapView from '../../shared/MapView';
import MetricCard from '../../shared/MetricCard';
import { useSfQuery, useSnowflake } from '../../hooks/useSnowflake';
import { useRegion } from '../../hooks/useRegion';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

export default function DriverRoutes({ sourceDb, sourceSchema, config }: Props) {
  const { regionName, center, zoom } = useRegion();

  const [selectedDriver, setSelectedDriver] = useState<string | null>(null);
  const [routes, setRoutes] = useState<any[]>([]);
  const [gpsPoints, setGpsPoints] = useState<any[]>([]);
  const [selectedTrip, setSelectedTrip] = useState<string | null>(null);
  const [sliderIdx, setSliderIdx] = useState(0);
  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const { query } = useSnowflake();

  const { data: drivers } = useSfQuery(
    `SELECT DRIVER_ID, COUNT(*) AS TRIPS,
            ROUND(SUM(ROUTE_DISTANCE_METERS / 1000), 1) AS TOTAL_KM,
            ROUND(AVG(ROUTE_DURATION_SECS / 60), 1) AS AVG_DURATION,
            ROUND(AVG(AVERAGE_KMH), 1) AS AVG_SPEED
     FROM TRIP_SUMMARY WHERE REGION = '${regionName}' GROUP BY DRIVER_ID ORDER BY TRIPS DESC LIMIT 50`, sourceDb, sourceSchema, [regionName]);

  const loadRoutes = useCallback(async (driverId: string) => {
    setSelectedDriver(driverId);
    setSelectedTrip(null);
    setGpsPoints([]);
    setAiAnalysis(null);
    const r = await query(
      `SELECT TRIP_ID,
              ST_X(ORIGIN) AS P_LNG, ST_Y(ORIGIN) AS P_LAT,
              ST_X(DESTINATION) AS D_LNG, ST_Y(DESTINATION) AS D_LAT,
              ROUND(ROUTE_DISTANCE_METERS / 1000, 2) AS TRIP_KM,
              ROUND(ROUTE_DURATION_SECS / 60, 1) AS TRIP_MIN,
              ORIGIN_ADDRESS, DESTINATION_ADDRESS
       FROM TRIP_SUMMARY WHERE DRIVER_ID = '${driverId}' AND REGION = '${regionName}' ORDER BY TRIP_START_TIME DESC LIMIT 50`,
      { database: sourceDb, schema: sourceSchema });
    setRoutes(r);
  }, [query, sourceDb, sourceSchema]);

  const loadTrip = useCallback(async (tripId: string) => {
    setSelectedTrip(tripId);
    setSliderIdx(0);
    setAiAnalysis(null);
    const pts = await query(
      `SELECT LON, LAT, CURR_TIME, KMH, DRIVER_STATE, POINT_INDEX
       FROM DRIVER_LOCATIONS_V WHERE TRIP_ID = '${tripId}' AND REGION = '${regionName}'
       ORDER BY POINT_INDEX`, { database: sourceDb, schema: sourceSchema });
    setGpsPoints(pts);
  }, [query, sourceDb, sourceSchema]);

  const analyzeTrip = useCallback(async () => {
    if (!selectedTrip || !routes.length) return;
    setAiLoading(true);
    const trip = routes.find((r: any) => r.TRIP_ID === selectedTrip);
    if (!trip) { setAiLoading(false); return; }
    try {
      const r = await query(
        `SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-3-5-sonnet',
          'Analyze this taxi trip from ${trip.ORIGIN_ADDRESS || 'origin'} to ${trip.DESTINATION_ADDRESS || 'destination'}, ${trip.TRIP_KM}km in ${trip.TRIP_MIN}min. Brief insights on trip purpose, likely traffic conditions, and efficiency.') AS ANALYSIS`,
        { database: sourceDb, schema: sourceSchema });
      setAiAnalysis(r[0]?.ANALYSIS || 'No analysis available');
    } catch { setAiAnalysis('Analysis unavailable'); }
    setAiLoading(false);
  }, [selectedTrip, routes, query, sourceDb, sourceSchema]);

  const currentPoint = gpsPoints[sliderIdx];

  const layers = useMemo(() => {
    const l: any[] = [];
    if (gpsPoints.length) {
      l.push(new PathLayer({
        id: 'gps-track',
        data: [{ path: gpsPoints.map((p: any) => [Number(p.LON), Number(p.LAT)]) }],
        getPath: (d: any) => d.path, getColor: [41, 181, 232, 120], getWidth: 3, widthMinPixels: 2,
      }));
      l.push(new ScatterplotLayer({
        id: 'origin-marker', data: [gpsPoints[0]],
        getPosition: (d: any) => [Number(d.LON), Number(d.LAT)],
        getFillColor: [34, 197, 94, 255], getRadius: 80, radiusMinPixels: 6,
      }));
      l.push(new ScatterplotLayer({
        id: 'dest-marker', data: [gpsPoints[gpsPoints.length - 1]],
        getPosition: (d: any) => [Number(d.LON), Number(d.LAT)],
        getFillColor: [239, 68, 68, 255], getRadius: 80, radiusMinPixels: 6,
      }));
      if (currentPoint) {
        l.push(new ScatterplotLayer({
          id: 'current-pos', data: [currentPoint],
          getPosition: (d: any) => [Number(d.LON), Number(d.LAT)],
          getFillColor: [255, 255, 255, 255], getLineColor: [41, 181, 232, 255],
          getRadius: 100, radiusMinPixels: 8, stroked: true, lineWidthMinPixels: 3,
        }));
      }
    } else if (routes.length) {
      l.push(new PathLayer({
        id: 'driver-routes',
        data: routes.filter((r: any) => r.P_LNG && r.D_LNG).map((r: any) => ({
          path: [[Number(r.P_LNG), Number(r.P_LAT)], [Number(r.D_LNG), Number(r.D_LAT)]],
        })),
        getPath: (d: any) => d.path, getColor: [255, 107, 53, 180], getWidth: 3, widthMinPixels: 2,
      }));
      l.push(new ScatterplotLayer({
        id: 'pickups', data: routes.filter((r: any) => r.P_LNG),
        getPosition: (d: any) => [Number(d.P_LNG), Number(d.P_LAT)],
        getFillColor: [34, 197, 94, 200], getRadius: 50, radiusMinPixels: 4,
      }));
      l.push(new ScatterplotLayer({
        id: 'dropoffs', data: routes.filter((r: any) => r.D_LNG),
        getPosition: (d: any) => [Number(d.D_LNG), Number(d.D_LAT)],
        getFillColor: [239, 68, 68, 200], getRadius: 50, radiusMinPixels: 4,
      }));
    }
    return l;
  }, [routes, gpsPoints, currentPoint]);

  const speedData = useMemo(() =>
    gpsPoints.filter((_: any, i: number) => i % 3 === 0).map((p: any) => ({
      idx: Number(p.POINT_INDEX),
      speed: Number(p.KMH),
    })), [gpsPoints]);

  const viewState = useMemo(() => {
    if (currentPoint) return { longitude: Number(currentPoint.LON), latitude: Number(currentPoint.LAT), zoom: 14 };
    const pts = gpsPoints.length ? gpsPoints : routes.filter((r: any) => r.P_LNG);
    if (pts.length) {
      const lngs = pts.map((p: any) => Number(p.LON || p.P_LNG));
      const lats = pts.map((p: any) => Number(p.LAT || p.P_LAT));
      return { longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2, latitude: (Math.min(...lats) + Math.max(...lats)) / 2, zoom: 12 };
    }
    const ors = config?.ors?.bounds?.center;
    if (ors?.lng && ors?.lat) return { longitude: ors.lng, latitude: ors.lat, zoom: 11 };
    return { longitude: center.lng, latitude: center.lat, zoom };
  }, [routes, gpsPoints, currentPoint, config]);

  const sel = drivers.find((d: any) => d.DRIVER_ID === selectedDriver);

  return (
    <div className="page-full">
      <div className="page-sidebar-panel">
        <h2>Driver Routes</h2>
        {sel && (
          <div className="metric-grid-vertical">
            <MetricCard label="Driver" value={String(sel.DRIVER_ID).slice(-8)} />
            <MetricCard label="Trips" value={sel.TRIPS} />
            <MetricCard label="Total Km" value={sel.TOTAL_KM} />
            <MetricCard label="Avg Speed" value={`${sel.AVG_SPEED} km/h`} />
          </div>
        )}
        {selectedDriver && routes.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <h3 style={{ fontSize: 13, marginBottom: 6 }}>Trips</h3>
            <div className="data-table-container" style={{ maxHeight: 150 }}>
              <table className="data-table">
                <thead><tr><th className="data-table-th">Trip</th><th className="data-table-th">Km</th><th className="data-table-th">Min</th></tr></thead>
                <tbody>{routes.map((r: any) => (
                  <tr key={r.TRIP_ID} onClick={() => loadTrip(r.TRIP_ID)}
                    style={{ cursor: 'pointer', background: selectedTrip === r.TRIP_ID ? 'rgba(41,181,232,0.15)' : undefined }}>
                    <td style={{ fontSize: 10 }}>{String(r.TRIP_ID).slice(0, 8)}</td>
                    <td>{r.TRIP_KM}</td><td>{r.TRIP_MIN}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        )}
        {gpsPoints.length > 1 && (
          <div style={{ marginTop: 12 }}>
            <h3 style={{ fontSize: 13, marginBottom: 4 }}>GPS Playback</h3>
            <input type="range" min={0} max={gpsPoints.length - 1} value={sliderIdx}
              onChange={e => setSliderIdx(Number(e.target.value))} style={{ width: '100%' }} />
            {currentPoint && (
              <div style={{ fontSize: 11, color: '#6E7681', marginTop: 4 }}>
                <div>Speed: {currentPoint.KMH} km/h | State: {currentPoint.DRIVER_STATE}</div>
                <div>Time: {String(currentPoint.CURR_TIME).slice(11, 19)}</div>
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              <ResponsiveContainer width="100%" height={100}>
                <LineChart data={speedData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="idx" tick={false} />
                  <YAxis tick={{ fill: '#6E7681', fontSize: 9 }} unit=" km/h" width={45} />
                  <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 11 }} />
                  <Line type="monotone" dataKey="speed" stroke="#29B5E8" strokeWidth={1.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <button onClick={analyzeTrip} disabled={aiLoading}
              style={{ marginTop: 8, width: '100%', padding: '6px 12px', background: '#29B5E8', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>
              {aiLoading ? 'Analyzing...' : 'AI Trip Analysis'}
            </button>
            {aiAnalysis && (
              <div style={{ marginTop: 8, padding: 8, background: 'rgba(41,181,232,0.08)', borderRadius: 6, fontSize: 11, color: '#6E7681', maxHeight: 120, overflow: 'auto' }}>
                {aiAnalysis}
              </div>
            )}
          </div>
        )}
        <h3 style={{ fontSize: 13, marginBottom: 8, marginTop: 12 }}>All Drivers</h3>
        <div className="data-table-container" style={{ maxHeight: selectedDriver ? 150 : 350 }}>
          <table className="data-table">
            <thead><tr><th className="data-table-th">Driver</th><th className="data-table-th">Trips</th><th className="data-table-th">Km</th></tr></thead>
            <tbody>{drivers.map((d: any) => (
              <tr key={d.DRIVER_ID} onClick={() => loadRoutes(d.DRIVER_ID)}
                style={{ cursor: 'pointer', background: selectedDriver === d.DRIVER_ID ? 'rgba(41,181,232,0.1)' : undefined }}>
                <td style={{ fontSize: 11 }}>{String(d.DRIVER_ID).slice(-8)}</td><td>{d.TRIPS}</td><td>{d.TOTAL_KM}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
      <MapView layers={layers} initialViewState={viewState} />
    </div>
  );
}
