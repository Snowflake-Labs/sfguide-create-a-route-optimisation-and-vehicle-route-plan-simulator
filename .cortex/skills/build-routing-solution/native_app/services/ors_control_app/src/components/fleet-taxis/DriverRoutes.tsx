import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import MetricCard from '../../shared/MetricCard';
import { FT_DB, FT_SCHEMA, sfQuery, cartoBasemap } from './helpers';

export default function DriverRoutes() {
  const [selectedDriver, setSelectedDriver] = useState<string | null>(null);
  const [routes, setRoutes] = useState<any[]>([]);
  const [gpsPoints, setGpsPoints] = useState<any[]>([]);
  const [selectedTrip, setSelectedTrip] = useState<string | null>(null);
  const [sliderIdx, setSliderIdx] = useState(0);
  const [aiAnalysis, setAiAnalysis] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [drivers, setDrivers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewState, setViewState] = useState({ longitude: -122.42, latitude: 37.77, zoom: 11, pitch: 0, bearing: 0 });

  useEffect(() => {
    setLoading(true);
    sfQuery(`SELECT DRIVER_ID, COUNT(*) AS TRIPS, ROUND(SUM(ROUTE_DISTANCE_METERS / 1000), 1) AS TOTAL_KM, ROUND(AVG(ROUTE_DURATION_SECS / 60), 1) AS AVG_DURATION, ROUND(AVG(AVERAGE_KMH), 1) AS AVG_SPEED FROM TRIP_SUMMARY GROUP BY DRIVER_ID ORDER BY TRIPS DESC LIMIT 50`)
      .then(d => { setDrivers(d); setLoading(false); });
  }, []);

  const loadRoutes = useCallback(async (driverId: string) => {
    setSelectedDriver(driverId);
    setSelectedTrip(null);
    setGpsPoints([]);
    setAiAnalysis('');
    const r = await sfQuery(`SELECT TRIP_ID, ST_X(ORIGIN) AS P_LNG, ST_Y(ORIGIN) AS P_LAT, ST_X(DESTINATION) AS D_LNG, ST_Y(DESTINATION) AS D_LAT, ROUND(ROUTE_DISTANCE_METERS / 1000, 2) AS TRIP_KM, ROUND(ROUTE_DURATION_SECS / 60, 1) AS TRIP_MIN, ORIGIN_ADDRESS, DESTINATION_ADDRESS, ST_ASGEOJSON(GEOMETRY)::STRING AS ROUTE_GEOJSON FROM TRIP_SUMMARY WHERE DRIVER_ID = '${driverId}' ORDER BY TRIP_START_TIME DESC LIMIT 50`);
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
    const pts = await sfQuery(`SELECT LON, LAT, TO_VARCHAR(CURR_TIME, 'YYYY-MM-DD HH24:MI:SS') AS CURR_TIME, KMH, DRIVER_STATE, POINT_INDEX FROM DRIVER_LOCATIONS_V WHERE TRIP_ID = '${tripId}' ORDER BY POINT_INDEX`);
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
      result.push(new PathLayer({ id: 'driver-routes', data: routes.filter((r: any) => r.P_LNG && r.D_LNG).map((r: any) => {
        if (r.ROUTE_GEOJSON) {
          try {
            const geo = JSON.parse(r.ROUTE_GEOJSON);
            if (geo.coordinates?.length > 1) return { path: geo.coordinates };
          } catch {}
        }
        return { path: [[Number(r.P_LNG), Number(r.P_LAT)], [Number(r.D_LNG), Number(r.D_LAT)]] };
      }), getPath: (d: any) => d.path, getColor: [41, 181, 232, 120], getWidth: 2, widthMinPixels: 1 }));
      result.push(new ScatterplotLayer({ id: 'pickups', data: routes.filter((r: any) => r.P_LNG), getPosition: (d: any) => [Number(d.P_LNG), Number(d.P_LAT)], getFillColor: [34, 197, 94, 180], getRadius: 40, radiusMinPixels: 4 }));
      result.push(new ScatterplotLayer({ id: 'dropoffs', data: routes.filter((r: any) => r.D_LNG), getPosition: (d: any) => [Number(d.D_LNG), Number(d.D_LAT)], getFillColor: [239, 68, 68, 150], getRadius: 30, radiusMinPixels: 3 }));
    }
    return result;
  }, [gpsPoints, routes, sliderIdx]);

  const layers = useMemo(() => [basemap, ...dataLayers].filter(Boolean), [basemap, dataLayers]);
  const speedData = useMemo(() => gpsPoints.map((p: any, i: number) => ({ idx: i, speed: Number(p.KMH || 0) })), [gpsPoints]);

  const sel = drivers.find((d: any) => d.DRIVER_ID === selectedDriver);
  const selTrip = routes.find((r: any) => r.TRIP_ID === selectedTrip);

  const handleDriverChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v) loadRoutes(v); else { setSelectedDriver(null); setRoutes([]); setGpsPoints([]); setSelectedTrip(null); }
  }, [loadRoutes]);

  const handleTripChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v) loadTrip(v); else { setSelectedTrip(null); setGpsPoints([]); }
  }, [loadTrip]);

  return (
    <div className="panel">
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Driver Routes</h2>
      <p className="subtitle">{loading ? 'Loading...' : `${drivers.length} drivers`}</p>
      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="form-group" style={{ flex: 1, minWidth: 200 }}>
          <label>Driver</label>
          <select className="form-select" value={selectedDriver || ''} onChange={handleDriverChange}>
            <option value="">Select a driver...</option>
            {drivers.map((d: any) => (
              <option key={d.DRIVER_ID} value={d.DRIVER_ID}>
                {d.DRIVER_ID} \u2014 {d.TRIPS} trips, {d.TOTAL_KM} km
              </option>
            ))}
          </select>
        </div>
        {selectedDriver && routes.length > 0 && (
          <div className="form-group" style={{ flex: 1, minWidth: 200 }}>
            <label>Trip</label>
            <select className="form-select" value={selectedTrip || ''} onChange={handleTripChange}>
              <option value="">Select a trip...</option>
              {routes.map((r: any) => (
                <option key={r.TRIP_ID} value={r.TRIP_ID}>
                  {String(r.TRIP_ID).slice(-10)} \u2014 {r.TRIP_KM} km, {r.TRIP_MIN} min
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {sel && (
        <div className="metric-grid" style={{ marginBottom: 12 }}>
          <MetricCard label="Trips" value={sel.TRIPS} />
          <MetricCard label="Total Km" value={sel.TOTAL_KM} />
          <MetricCard label="Avg Speed" value={`${sel.AVG_SPEED} km/h`} />
          <MetricCard label="Avg Duration" value={`${sel.AVG_DURATION} min`} />
        </div>
      )}
      {selTrip && (
        <div className="metric-grid" style={{ marginBottom: 12 }}>
          <MetricCard label="Distance" value={`${selTrip.TRIP_KM} km`} />
          <MetricCard label="Duration" value={`${selTrip.TRIP_MIN} min`} />
          {selTrip.ORIGIN_ADDRESS && <MetricCard label="From" value={selTrip.ORIGIN_ADDRESS} />}
          {selTrip.DESTINATION_ADDRESS && <MetricCard label="To" value={selTrip.DESTINATION_ADDRESS} />}
        </div>
      )}
      {selectedTrip && gpsPoints.length > 1 && (
        <div style={{ marginBottom: 12 }}>
          <label className="range-label">Playback: {gpsPoints[sliderIdx]?.CURR_TIME ? String(gpsPoints[sliderIdx].CURR_TIME).slice(11, 19) : `${sliderIdx}/${gpsPoints.length - 1}`}</label>
          <input type="range" min={0} max={gpsPoints.length - 1} value={sliderIdx} onChange={e => setSliderIdx(Number(e.target.value))} style={{ width: '100%' }} />
          {gpsPoints[sliderIdx] && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
              Speed: {gpsPoints[sliderIdx].KMH} km/h | State: {gpsPoints[sliderIdx].DRIVER_STATE}
            </div>
          )}
          <button className="btn-primary" onClick={analyzeTrip} disabled={aiLoading} style={{ width: '100%', marginTop: 8 }}>{aiLoading ? 'Analyzing...' : 'AI Analysis'}</button>
          {aiAnalysis && <div className="info-box" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{aiAnalysis}</div>}
        </div>
      )}
      <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
        {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>Loading...</div>}
        <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} style={{ width: '100%', height: '100%' }} />
      </div>
      {speedData.length > 0 && (
        <div className="chart-card" style={{ marginTop: 12 }}>
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
  );
}
