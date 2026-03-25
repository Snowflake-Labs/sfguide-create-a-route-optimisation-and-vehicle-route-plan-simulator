import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { sfQuery, cartoBasemap } from './helpers';

export default function DriverRoutes() {
  const [drivers, setDrivers] = useState<any[]>([]);
  const [selectedDriver, setSelectedDriver] = useState<string | null>(null);
  const [routes, setRoutes] = useState<any[]>([]);
  const [gpsPoints, setGpsPoints] = useState<any[]>([]);
  const [selectedTrip, setSelectedTrip] = useState<string | null>(null);
  const [sliderIdx, setSliderIdx] = useState(0);
  const [aiAnalysis, setAiAnalysis] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [viewState, setViewState] = useState({ longitude: -122.43, latitude: 37.77, zoom: 11, pitch: 0, bearing: 0 });

  useEffect(() => {
    setLoading(true);
    sfQuery(`SELECT DRIVER_ID, COUNT(*) AS TRIPS, ROUND(SUM(ROUTE_DISTANCE_METERS / 1000), 1) AS TOTAL_KM, ROUND(AVG(ROUTE_DURATION_SECS / 60), 1) AS AVG_DURATION, ROUND(AVG(AVERAGE_KMH), 1) AS AVG_SPEED FROM TRIP_SUMMARY GROUP BY DRIVER_ID ORDER BY TRIPS DESC LIMIT 50`)
      .then(setDrivers)
      .finally(() => setLoading(false));
  }, []);

  const loadRoutes = useCallback(async (driverId: string) => {
    setSelectedDriver(driverId);
    setSelectedTrip(null);
    setGpsPoints([]);
    setAiAnalysis('');
    const r = await sfQuery(`SELECT TRIP_ID, ST_X(ORIGIN) AS P_LNG, ST_Y(ORIGIN) AS P_LAT, ST_X(DESTINATION) AS D_LNG, ST_Y(DESTINATION) AS D_LAT, ROUND(ROUTE_DISTANCE_METERS / 1000, 2) AS TRIP_KM, ROUND(ROUTE_DURATION_SECS / 60, 1) AS TRIP_MIN, ORIGIN_ADDRESS, DESTINATION_ADDRESS FROM TRIP_SUMMARY WHERE DRIVER_ID = '${driverId}' ORDER BY TRIP_START_TIME DESC LIMIT 50`);
    setRoutes(r);
    if (r.length > 0) {
      const lngs = r.filter((t: any) => t.P_LNG).map((t: any) => Number(t.P_LNG));
      const lats = r.filter((t: any) => t.P_LAT).map((t: any) => Number(t.P_LAT));
      if (lngs.length) setViewState(prev => ({ ...prev, longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2, latitude: (Math.min(...lats) + Math.max(...lats)) / 2, zoom: 11 }));
    }
  }, []);

  const loadTrip = useCallback(async (tripId: string) => {
    setSelectedTrip(tripId);
    setSliderIdx(0);
    const pts = await sfQuery(`SELECT LON, LAT, CURR_TIME, KMH, DRIVER_STATE, POINT_INDEX FROM DRIVER_LOCATIONS_V WHERE TRIP_ID = '${tripId}' ORDER BY POINT_INDEX`);
    setGpsPoints(pts);
    if (pts.length > 0) setViewState(prev => ({ ...prev, longitude: Number(pts[0].LON), latitude: Number(pts[0].LAT), zoom: 13 }));
  }, []);

  const analyzeTrip = useCallback(async () => {
    if (!selectedTrip || gpsPoints.length === 0) return;
    setAiLoading(true);
    const summary = `Trip ${selectedTrip}: ${gpsPoints.length} GPS points, speeds ${Math.min(...gpsPoints.map((p: any) => Number(p.KMH || 0)))}-${Math.max(...gpsPoints.map((p: any) => Number(p.KMH || 0)))} km/h.`;
    const rows = await sfQuery(`SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-3-5-sonnet', 'Analyze this taxi trip and identify patterns or anomalies: ${summary.replace(/'/g, "''")}') AS ANALYSIS`, 'FLEET_INTELLIGENCE', 'FLEET_INTELLIGENCE_TAXIS');
    setAiAnalysis(rows[0]?.ANALYSIS || 'No analysis available.');
    setAiLoading(false);
  }, [selectedTrip, gpsPoints]);

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
    <div>
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Driver Routes</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
        {loading ? 'Loading...' : `${drivers.length} drivers`}
        {selectedDriver && ` · ${selectedDriver} · ${routes.length} trips`}
      </p>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '0 0 280px', maxHeight: 700, overflowY: 'auto' }}>
          {selectedTrip && gpsPoints.length > 1 && (
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Playback: point {sliderIdx}/{gpsPoints.length - 1}</label>
              <input type="range" min={0} max={gpsPoints.length - 1} value={sliderIdx} onChange={e => setSliderIdx(Number(e.target.value))} style={{ width: '100%' }} />
              <button className="btn-primary" onClick={analyzeTrip} disabled={aiLoading} style={{ width: '100%', marginTop: 8 }}>{aiLoading ? 'Analyzing...' : 'AI Analysis'}</button>
              {aiAnalysis && <div style={{ marginTop: 8, fontSize: 12, padding: 10, borderRadius: 6, background: 'rgba(41,181,232,0.06)', border: '1px solid rgba(41,181,232,0.15)', whiteSpace: 'pre-wrap' }}>{aiAnalysis}</div>}
            </div>
          )}
          {routes.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <h3 style={{ fontSize: 13, marginBottom: 6 }}>Trips</h3>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead><tr>{['Trip', 'Km', 'Min'].map(h => <th key={h} style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)' }}>{h}</th>)}</tr></thead>
                <tbody>{routes.map((r: any) => (
                  <tr key={r.TRIP_ID} onClick={() => loadTrip(r.TRIP_ID)} style={{ cursor: 'pointer', background: selectedTrip === r.TRIP_ID ? 'rgba(41,181,232,0.1)' : undefined }}>
                    <td style={{ padding: '4px 6px', fontFamily: 'monospace' }}>{String(r.TRIP_ID).slice(-10)}</td>
                    <td style={{ padding: '4px 6px' }}>{r.TRIP_KM}</td>
                    <td style={{ padding: '4px 6px' }}>{r.TRIP_MIN}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <h3 style={{ fontSize: 13, marginBottom: 6 }}>Drivers</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead><tr>{['Driver', 'Trips', 'Km', 'Spd'].map(h => <th key={h} style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)' }}>{h}</th>)}</tr></thead>
            <tbody>{drivers.map((d: any) => (
              <tr key={d.DRIVER_ID} onClick={() => loadRoutes(d.DRIVER_ID)} style={{ cursor: 'pointer', background: selectedDriver === d.DRIVER_ID ? 'rgba(41,181,232,0.1)' : undefined }}>
                <td style={{ padding: '4px 6px' }}>{d.DRIVER_ID}</td>
                <td style={{ padding: '4px 6px' }}>{d.TRIPS}</td>
                <td style={{ padding: '4px 6px' }}>{d.TOTAL_KM}</td>
                <td style={{ padding: '4px 6px' }}>{d.AVG_SPEED}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>

        <div style={{ flex: 1, minWidth: 300 }}>
          <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
            <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} style={{ width: '100%', height: '100%' }} />
          </div>
          {speedData.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <h3 style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>Speed Profile</h3>
              <ResponsiveContainer width="100%" height={120}>
                <LineChart data={speedData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="idx" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} unit=" km/h" />
                  <Tooltip />
                  <Line type="monotone" dataKey="speed" stroke="var(--accent)" strokeWidth={1.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
