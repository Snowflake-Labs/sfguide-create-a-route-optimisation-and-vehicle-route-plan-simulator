import { useState, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useSfQuery, useSnowflake } from '../../hooks/useSnowflake';
import { FT_DB, FT_SCHEMA, cartoBasemap } from './helpers';
import { useRegion } from '../../hooks/useRegion';

export default function DriverRoutes() {
  const { regionName, center, zoom: regionZoom } = useRegion();
  const [selectedDriver, setSelectedDriver] = useState<string | null>(null);
  const [routes, setRoutes] = useState<any[]>([]);
  const [gpsPoints, setGpsPoints] = useState<any[]>([]);
  const [selectedTrip, setSelectedTrip] = useState<string | null>(null);
  const [sliderIdx, setSliderIdx] = useState(0);
  const [aiAnalysis, setAiAnalysis] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [viewState, setViewState] = useState({ longitude: center.lng, latitude: center.lat, zoom: regionZoom, pitch: 0, bearing: 0 });

  const { data: drivers, loading } = useSfQuery(
    `SELECT DRIVER_ID, COUNT(*) AS TRIPS, ROUND(SUM(ROUTE_DISTANCE_METERS / 1000), 1) AS TOTAL_KM, ROUND(AVG(ROUTE_DURATION_SECS / 60), 1) AS AVG_DURATION, ROUND(AVG(AVERAGE_KMH), 1) AS AVG_SPEED FROM TRIP_SUMMARY WHERE REGION = '${regionName}' GROUP BY DRIVER_ID ORDER BY TRIPS DESC LIMIT 50`,
    FT_DB, FT_SCHEMA, [regionName],
  );

  const { query } = useSnowflake();

  const loadRoutes = useCallback(async (driverId: string) => {
    setSelectedDriver(driverId);
    setSelectedTrip(null);
    setGpsPoints([]);
    setAiAnalysis('');
    const r = await query(`SELECT TRIP_ID, ST_X(ORIGIN) AS P_LNG, ST_Y(ORIGIN) AS P_LAT, ST_X(DESTINATION) AS D_LNG, ST_Y(DESTINATION) AS D_LAT, ROUND(ROUTE_DISTANCE_METERS / 1000, 2) AS TRIP_KM, ROUND(ROUTE_DURATION_SECS / 60, 1) AS TRIP_MIN, ORIGIN_ADDRESS, DESTINATION_ADDRESS FROM TRIP_SUMMARY WHERE DRIVER_ID = '${driverId}' ORDER BY TRIP_START_TIME DESC LIMIT 50`, { database: FT_DB, schema: FT_SCHEMA });
    setRoutes(r);
    if (r.length > 0) {
      const lngs = r.filter((t: any) => t.P_LNG).map((t: any) => Number(t.P_LNG));
      const lats = r.filter((t: any) => t.P_LAT).map((t: any) => Number(t.P_LAT));
      if (lngs.length) setViewState(prev => ({ ...prev, longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2, latitude: (Math.min(...lats) + Math.max(...lats)) / 2, zoom: 11 }));
    }
  }, [query]);

  const loadTrip = useCallback(async (tripId: string) => {
    setSelectedTrip(tripId);
    setSliderIdx(0);
    const pts = await query(`SELECT LON, LAT, CURR_TIME, KMH, DRIVER_STATE, POINT_INDEX FROM DRIVER_LOCATIONS_V WHERE TRIP_ID = '${tripId}' ORDER BY POINT_INDEX`, { database: FT_DB, schema: FT_SCHEMA });
    setGpsPoints(pts);
    if (pts.length > 0) setViewState(prev => ({ ...prev, longitude: Number(pts[0].LON), latitude: Number(pts[0].LAT), zoom: 13 }));
  }, [query]);

  const analyzeTrip = useCallback(async () => {
    if (!selectedTrip || gpsPoints.length === 0) return;
    setAiLoading(true);
    const summary = `Trip ${selectedTrip}: ${gpsPoints.length} GPS points, speeds ${Math.min(...gpsPoints.map((p: any) => Number(p.KMH || 0)))}-${Math.max(...gpsPoints.map((p: any) => Number(p.KMH || 0)))} km/h.`;
    const rows = await query(`SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-3-5-sonnet', 'Analyze this taxi trip and identify patterns or anomalies: ${summary.replace(/'/g, "''")}') AS ANALYSIS`, { database: 'FLEET_INTELLIGENCE', schema: 'FLEET_INTELLIGENCE_TAXIS' });
    setAiAnalysis(rows[0]?.ANALYSIS || 'No analysis available.');
    setAiLoading(false);
  }, [selectedTrip, gpsPoints, query]);

  const basemap = useMemo(() => cartoBasemap(), []);

  const dataLayers = useMemo(() => {
    const result: any[] = [];
    if (gpsPoints.length > 1) {
      const path = gpsPoints.map((p: any) => [Number(p.LON), Number(p.LAT)]);
      result.push(new PathLayer({ id: 'gps-track', data: [{ path }], getPath: (d: any) => d.path, getColor: [41, 181, 232, 200], getWidth: 3, widthMinPixels: 2 }));
      result.push(new ScatterplotLayer({ id: 'origin-marker', data: [gpsPoints[0]], getPosition: (d: any) => [Number(d.LON), Number(d.LAT)], getFillColor: [34, 197, 94, 255], getRadius: 60, radiusMinPixels: 6 }));
      result.push(new ScatterplotLayer({ id: 'dest-marker', data: [gpsPoints[gpsPoints.length - 1]], getPosition: (d: any) => [Number(d.LON), Number(d.LAT)], getFillColor: [239, 68, 68, 255], getRadius: 60, radiusMinPixels: 6 }));
      if (sliderIdx > 0 && sliderIdx < gpsPoints.length) {
        result.push(new ScatterplotLayer({ id: 'current-pos', data: [gpsPoints[sliderIdx]], getPosition: (d: any) => [Number(d.LON), Number(d.LAT)], getFillColor: [255, 255, 255, 220], getLineColor: [41, 181, 232, 255], getRadius: 50, radiusMinPixels: 8, stroked: true, lineWidthMinPixels: 3 }));
      }
    } else if (routes.length) {
      result.push(new PathLayer({ id: 'driver-routes', data: routes.filter((r: any) => r.P_LNG && r.D_LNG).map((r: any) => ({ path: [[Number(r.P_LNG), Number(r.P_LAT)], [Number(r.D_LNG), Number(r.D_LAT)]] })), getPath: (d: any) => d.path, getColor: [41, 181, 232, 120], getWidth: 2, widthMinPixels: 1 }));
      result.push(new ScatterplotLayer({ id: 'pickups', data: routes.filter((r: any) => r.P_LNG), getPosition: (d: any) => [Number(d.P_LNG), Number(d.P_LAT)], getFillColor: [34, 197, 94, 180], getRadius: 40, radiusMinPixels: 4 }));
      result.push(new ScatterplotLayer({ id: 'dropoffs', data: routes.filter((r: any) => r.D_LNG), getPosition: (d: any) => [Number(d.D_LNG), Number(d.D_LAT)], getFillColor: [239, 68, 68, 150], getRadius: 30, radiusMinPixels: 3 }));
    }
    return result;
  }, [gpsPoints, routes, sliderIdx]);

  const layers = useMemo(() => [basemap, ...dataLayers].filter(Boolean), [basemap, dataLayers]);
  const speedData = useMemo(() => gpsPoints.map((p: any, i: number) => ({ idx: i, speed: Number(p.KMH || 0) })), [gpsPoints]);

  return (
    <div className="page-full">
      <div className="page-sidebar-panel">
        <h2>Driver Routes</h2>
        <p>{loading ? 'Loading...' : `${drivers.length} drivers`}{selectedDriver && ` · ${selectedDriver} · ${routes.length} trips`}</p>
        {selectedTrip && gpsPoints.length > 1 && (
          <div style={{ marginBottom: 12 }}>
            <label className="range-label">Playback: point {sliderIdx}/{gpsPoints.length - 1}</label>
            <input type="range" min={0} max={gpsPoints.length - 1} value={sliderIdx} onChange={e => setSliderIdx(Number(e.target.value))} style={{ width: '100%' }} />
            <button className="btn-primary" onClick={analyzeTrip} disabled={aiLoading} style={{ width: '100%', marginTop: 8 }}>{aiLoading ? 'Analyzing...' : 'AI Analysis'}</button>
            {aiAnalysis && <div className="info-box" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{aiAnalysis}</div>}
          </div>
        )}
        {routes.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <h3>Trips</h3>
            <table className="sidebar-table">
              <thead><tr>{['Trip', 'Km', 'Min'].map(h => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>{routes.map((r: any) => (
                <tr key={r.TRIP_ID} className={`clickable${selectedTrip === r.TRIP_ID ? ' selected' : ''}`} onClick={() => loadTrip(r.TRIP_ID)}>
                  <td className="mono">{String(r.TRIP_ID).slice(-10)}</td>
                  <td>{r.TRIP_KM}</td>
                  <td>{r.TRIP_MIN}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <h3>Drivers</h3>
        <table className="sidebar-table">
          <thead><tr>{['Driver', 'Trips', 'Km', 'Spd'].map(h => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{drivers.map((d: any) => (
            <tr key={d.DRIVER_ID} className={`clickable${selectedDriver === d.DRIVER_ID ? ' selected' : ''}`} onClick={() => loadRoutes(d.DRIVER_ID)}>
              <td>{d.DRIVER_ID}</td>
              <td>{d.TRIPS}</td>
              <td>{d.TOTAL_KM}</td>
              <td>{d.AVG_SPEED}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="map-split">
        <div className="map-view">
          <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} style={{ width: '100%', height: '100%' }} />
        </div>
        {speedData.length > 0 && (
          <div className="chart-card chart-bottom">
            <h4>Speed Profile</h4>
            <ResponsiveContainer width="100%" height={120}>
              <LineChart data={speedData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
                <XAxis dataKey="idx" tick={{ fill: '#6E7681', fontSize: 10 }} />
                <YAxis tick={{ fill: '#6E7681', fontSize: 10 }} unit=" km/h" />
                <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
                <Line type="monotone" dataKey="speed" stroke="#29B5E8" strokeWidth={1.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}
