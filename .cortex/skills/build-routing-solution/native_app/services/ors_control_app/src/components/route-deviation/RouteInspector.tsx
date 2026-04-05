import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import MetricCard from '../../shared/MetricCard';
import { fmtDec } from '../../shared/format';
import { RD_DB, RD_SCHEMA, sfQuery, cartoBasemap } from './helpers';

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default function RouteInspector() {
  const [selectedTruck, setSelectedTruck] = useState('');
  const [truckTrips, setTruckTrips] = useState<any[]>([]);
  const [selectedTrip, setSelectedTrip] = useState('');
  const [gpsPoints, setGpsPoints] = useState<any[]>([]);
  const [showTeleports, setShowTeleports] = useState(true);
  const [showDetours, setShowDetours] = useState(true);
  const [hideTeleported, setHideTeleported] = useState(false);
  const [maxAccuracy, setMaxAccuracy] = useState(50);
  const [trucks, setTrucks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewState, setViewState] = useState({ longitude: -122.43, latitude: 37.77, zoom: 12, pitch: 0, bearing: 0 });

  useEffect(() => {
    setLoading(true);
    sfQuery(`SELECT DISTINCT VEHICLE_ID FROM TRIP_DEVIATION_ANALYSIS ORDER BY VEHICLE_ID LIMIT 100`)
      .then(t => { setTrucks(t); setLoading(false); });
  }, []);

  useEffect(() => {
    if (!selectedTruck) return;
    sfQuery(`SELECT TRIP_ID, TRIP_DATE, ROUND(DISTANCE_DEVIATION_PCT, 1) AS DEV_PCT, POINT_COUNT AS PTS FROM TRIP_DEVIATION_ANALYSIS WHERE VEHICLE_ID = '${selectedTruck}' ORDER BY DISTANCE_DEVIATION_PCT DESC LIMIT 50`)
      .then(setTruckTrips);
  }, [selectedTruck]);

  const loadTrip = useCallback(async (tripId: string) => {
    setSelectedTrip(tripId);
    const pts = await sfQuery(`SELECT LATITUDE, LONGITUDE, SPEED_KMH, HEADING_DEG, POSTED_SPEED_KMH, GPS_ACCURACY_M, IS_DETOUR, IS_SPEEDING, TS, STATUS FROM ${RD_DB}.${RD_SCHEMA}.VW_VEHICLE_TELEMETRY WHERE TRIP_ID = '${tripId}' ORDER BY TS`);
    setGpsPoints(pts);
    if (pts.length > 0) {
      const lngs = pts.map((p: any) => Number(p.LONGITUDE));
      const lats = pts.map((p: any) => Number(p.LATITUDE));
      setViewState(prev => ({ ...prev, longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2, latitude: (Math.min(...lats) + Math.max(...lats)) / 2, zoom: 12 }));
    }
  }, []);

  const enrichedPoints = useMemo(() => {
    return gpsPoints.map((p: any, i: number) => {
      let isTeleport = false;
      if (i > 0) {
        const prev = gpsPoints[i - 1];
        const dist = haversineKm(Number(prev.LATITUDE), Number(prev.LONGITUDE), Number(p.LATITUDE), Number(p.LONGITUDE));
        if (dist > 5) isTeleport = true;
      }
      return { ...p, isTeleport, idx: i };
    });
  }, [gpsPoints]);

  const filteredPoints = useMemo(() => {
    let pts = enrichedPoints;
    if (hideTeleported) pts = pts.filter(p => !p.isTeleport);
    if (maxAccuracy < 100) pts = pts.filter(p => Number(p.GPS_ACCURACY_M || 0) <= maxAccuracy);
    return pts;
  }, [enrichedPoints, hideTeleported, maxAccuracy]);

  const teleportCount = useMemo(() => enrichedPoints.filter(p => p.isTeleport).length, [enrichedPoints]);
  const detourCount = useMemo(() => gpsPoints.filter((p: any) => p.IS_DETOUR === true || p.IS_DETOUR === 'true').length, [gpsPoints]);
  const basemap = useMemo(() => cartoBasemap(), []);

  const pathLayer = useMemo(() => {
    if (filteredPoints.length < 2) return null;
    return new PathLayer({ id: 'gps-track', data: [{ path: filteredPoints.map(p => [Number(p.LONGITUDE), Number(p.LATITUDE)]) }], getPath: (d: any) => d.path, getColor: [41, 181, 232, 120], getWidth: 3, widthMinPixels: 2 });
  }, [filteredPoints]);

  const pointLayer = useMemo(() => {
    if (!filteredPoints.length) return null;
    return new ScatterplotLayer({
      id: 'gps-points', data: filteredPoints, getPosition: (d: any) => [Number(d.LONGITUDE), Number(d.LATITUDE)],
      getFillColor: (d: any) => {
        if (showTeleports && d.isTeleport) return [239, 68, 68, 255];
        if (showDetours && (d.IS_DETOUR === true || d.IS_DETOUR === 'true')) return [255, 165, 0, 220];
        return [41, 181, 232, 150];
      },
      getRadius: 30, radiusMinPixels: 3, pickable: true, updateTriggers: { getFillColor: [showTeleports, showDetours] },
    });
  }, [filteredPoints, showTeleports, showDetours]);

  const layers = useMemo(() => [basemap, pathLayer, pointLayer].filter(Boolean), [basemap, pathLayer, pointLayer]);
  const speedData = useMemo(() => filteredPoints.map(p => ({ idx: p.idx, speed: Number(p.SPEED_KMH || 0), limit: Number(p.POSTED_SPEED_KMH || 0) })), [filteredPoints]);
  const accuracyData = useMemo(() => filteredPoints.map(p => ({ idx: p.idx, accuracy: Number(p.GPS_ACCURACY_M || 0) })), [filteredPoints]);

  return (
    <div className="panel">
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Route Inspector</h2>
      <p className="subtitle">GPS trace analysis with teleport and detour detection</p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="form-group" style={{ minWidth: 140 }}>
          <label>Truck</label>
          <select className="form-select" value={selectedTruck} onChange={e => setSelectedTruck(e.target.value)}>
            <option value="">Select...</option>
            {trucks.map(t => <option key={t.VEHICLE_ID} value={t.VEHICLE_ID}>{t.VEHICLE_ID}</option>)}
          </select>
        </div>
        {truckTrips.length > 0 && (
          <div className="form-group" style={{ minWidth: 200 }}>
            <label>Trip</label>
            <select className="form-select" value={selectedTrip} onChange={e => loadTrip(e.target.value)}>
              <option value="">Select...</option>
              {truckTrips.map(t => <option key={t.TRIP_ID} value={t.TRIP_ID}>{String(t.TRIP_ID).slice(-12)} ({fmtDec(t.DEV_PCT)}% · {t.PTS} pts)</option>)}
            </select>
          </div>
        )}
      </div>

      {gpsPoints.length > 0 && (
        <div className="metric-grid" style={{ marginBottom: 12 }}>
          <MetricCard label="GPS Points" value={filteredPoints.length} />
          <MetricCard label="Teleports" value={teleportCount} />
          <MetricCard label="Detours" value={detourCount} />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="check-label"><input type="checkbox" checked={showTeleports} onChange={e => setShowTeleports(e.target.checked)} /> Show teleports (red)</label>
        <label className="check-label"><input type="checkbox" checked={hideTeleported} onChange={e => setHideTeleported(e.target.checked)} /> Hide teleported</label>
        <label className="check-label"><input type="checkbox" checked={showDetours} onChange={e => setShowDetours(e.target.checked)} /> Show detours (orange)</label>
        <div style={{ minWidth: 160 }}>
          <label className="range-label">Max GPS accuracy: {maxAccuracy}m</label>
          <input type="range" min={5} max={100} value={maxAccuracy} onChange={e => setMaxAccuracy(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
      </div>

      <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
        {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>Loading...</div>}
        <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} style={{ width: '100%', height: '100%' }} />
      </div>

      {speedData.length > 0 && (
        <div className="chart-card" style={{ marginTop: 12 }}>
          <h4>Speed vs Speed Limit</h4>
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={speedData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
              <XAxis dataKey="idx" tick={{ fill: '#6E7681', fontSize: 10 }} />
              <YAxis tick={{ fill: '#6E7681', fontSize: 10 }} unit=" km/h" />
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
              <Line type="monotone" dataKey="speed" stroke="#29B5E8" strokeWidth={1.5} dot={false} name="Speed" />
              <Line type="monotone" dataKey="limit" stroke="#E5484D" strokeWidth={1} dot={false} strokeDasharray="4 2" name="Limit" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      {accuracyData.length > 0 && (
        <div className="chart-card" style={{ marginTop: 12 }}>
          <h4>GPS Accuracy</h4>
          <ResponsiveContainer width="100%" height={100}>
            <AreaChart data={accuracyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
              <XAxis dataKey="idx" tick={{ fill: '#6E7681', fontSize: 10 }} />
              <YAxis tick={{ fill: '#6E7681', fontSize: 10 }} unit="m" />
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
              <Area type="monotone" dataKey="accuracy" stroke="#E5A100" fill="rgba(229,161,0,0.2)" name="Accuracy" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
