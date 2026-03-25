import { useMemo, useState, useCallback } from 'react';
import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';
import MapView from '../../shared/MapView';
import MetricCard from '../../shared/MetricCard';
import DataTable from '../../shared/DataTable';
import { useSfQuery, useSnowflake } from '../../hooks/useSnowflake';
import { useRegion } from '../../hooks/useRegion';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default function RouteInspector({ sourceDb, sourceSchema }: Props) {
  const { regionName, center, zoom } = useRegion();
  const [selectedTruck, setSelectedTruck] = useState<string | null>(null);
  const [selectedTrip, setSelectedTrip] = useState<string | null>(null);
  const [gpsPoints, setGpsPoints] = useState<any[]>([]);
  const [showTeleports, setShowTeleports] = useState(true);
  const [showDetours, setShowDetours] = useState(true);
  const [hideTeleported, setHideTeleported] = useState(false);
  const [maxAccuracy, setMaxAccuracy] = useState(100);
  const { query } = useSnowflake();

  const { data: trucks } = useSfQuery(
    `SELECT DISTINCT TRUCK_ID FROM TRIP_DEVIATION_ANALYSIS WHERE REGION = '${regionName}' ORDER BY TRUCK_ID LIMIT 100`, sourceDb, sourceSchema, [regionName]);

  const { data: trips } = useSfQuery(
    selectedTruck
      ? `SELECT TRIP_ID, TRIP_DATE,
                ROUND(DISTANCE_DEVIATION_PCT, 1) AS DEV_PCT,
                ROUND(ACTUAL_DISTANCE_KM, 1) AS ACTUAL_KM
         FROM TRIP_DEVIATION_ANALYSIS WHERE TRUCK_ID = '${selectedTruck}' AND REGION = '${regionName}'
         ORDER BY DISTANCE_DEVIATION_PCT DESC LIMIT 50`
      : '', sourceDb, sourceSchema, [selectedTruck, regionName]);

  const loadTrip = useCallback(async (tripId: string) => {
    setSelectedTrip(tripId);
    const pts = await query(
      `SELECT LATITUDE, LONGITUDE, SPEED_KMH, HEADING_DEG, POSTED_SPEED_KMH,
              GPS_ACCURACY_M, IS_DETOUR, IS_SPEEDING, TS, STATUS
       FROM ${sourceDb}.${sourceSchema}.FACT_TRUCK_TELEMETRY
       WHERE TRIP_ID = '${tripId}' AND REGION = '${regionName}' ORDER BY TS`,
      { database: sourceDb, schema: sourceSchema });

    const enriched = pts.map((p: any, i: number) => {
      let isTeleport = false;
      if (i > 0) {
        const prev = pts[i - 1];
        const dist = haversineKm(Number(prev.LATITUDE), Number(prev.LONGITUDE), Number(p.LATITUDE), Number(p.LONGITUDE));
        const timeDiff = (new Date(p.TS).getTime() - new Date(prev.TS).getTime()) / 3600000;
        const impliedSpeed = timeDiff > 0 ? dist / timeDiff : 0;
        isTeleport = impliedSpeed > 200 && dist > 5;
      }
      return { ...p, IS_TELEPORT: isTeleport, IDX: i };
    });
    setGpsPoints(enriched);
  }, [query]);

  const filteredPoints = useMemo(() => {
    let pts = gpsPoints;
    if (hideTeleported) pts = pts.filter((p: any) => !p.IS_TELEPORT);
    pts = pts.filter((p: any) => Number(p.GPS_ACCURACY_M || 0) <= maxAccuracy);
    return pts;
  }, [gpsPoints, hideTeleported, maxAccuracy]);

  const layers = useMemo(() => {
    const l: any[] = [];
    if (filteredPoints.length > 1) {
      l.push(new PathLayer({
        id: 'gps-track',
        data: [{ path: filteredPoints.map((p: any) => [Number(p.LONGITUDE), Number(p.LATITUDE)]) }],
        getPath: (d: any) => d.path, getColor: [41, 181, 232, 60], getWidth: 2, widthMinPixels: 1,
      }));
      l.push(new ScatterplotLayer({
        id: 'gps-points', data: filteredPoints, pickable: true,
        getPosition: (d: any) => [Number(d.LONGITUDE), Number(d.LATITUDE)],
        getFillColor: (d: any) => {
          if (showTeleports && d.IS_TELEPORT) return [239, 68, 68, 255];
          if (showDetours && d.IS_DETOUR === true) return [255, 165, 0, 255];
          return [41, 181, 232, 150];
        },
        getRadius: (d: any) => (d.IS_TELEPORT || d.IS_DETOUR === true) ? 60 : 30,
        radiusMinPixels: 2,
        updateTriggers: { getFillColor: [showTeleports, showDetours], getRadius: [showTeleports, showDetours] },
      }));
    }
    return l;
  }, [filteredPoints, showTeleports, showDetours]);

  const speedData = useMemo(() =>
    filteredPoints.filter((_: any, i: number) => i % 5 === 0).map((p: any) => ({
      idx: p.IDX,
      speed: Number(p.SPEED_KMH),
      limit: Number(p.POSTED_SPEED_KMH || 0),
    })), [filteredPoints]);

  const accuracyData = useMemo(() =>
    filteredPoints.filter((_: any, i: number) => i % 5 === 0).map((p: any) => ({
      idx: p.IDX,
      accuracy: Number(p.GPS_ACCURACY_M || 0),
    })), [filteredPoints]);

  const viewState = useMemo(() => {
    if (filteredPoints.length) {
      const lngs = filteredPoints.map((p: any) => Number(p.LONGITUDE));
      const lats = filteredPoints.map((p: any) => Number(p.LATITUDE));
      return { longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2, latitude: (Math.min(...lats) + Math.max(...lats)) / 2, zoom: 10 };
    }
    return { longitude: center.lng, latitude: center.lat, zoom };
  }, [filteredPoints]);

  const teleportCount = gpsPoints.filter((p: any) => p.IS_TELEPORT).length;
  const detourCount = gpsPoints.filter((p: any) => p.IS_DETOUR === true).length;

  return (
    <div className="page-full">
      <div className="page-sidebar-panel" style={{ overflowY: 'auto' }}>
        <h2>Route Inspector</h2>
        <div className="form-group">
          <label>Truck</label>
          <select className="form-select" value={selectedTruck || ''} onChange={e => { setSelectedTruck(e.target.value || null); setSelectedTrip(null); setGpsPoints([]); }}>
            <option value="">Select truck...</option>
            {trucks.map((t: any) => <option key={t.TRUCK_ID} value={t.TRUCK_ID}>{t.TRUCK_ID}</option>)}
          </select>
        </div>
        {trips.length > 0 && (
          <div className="form-group" style={{ marginTop: 8 }}>
            <label>Trip</label>
            <select className="form-select" value={selectedTrip || ''} onChange={e => e.target.value && loadTrip(e.target.value)}>
              <option value="">Select trip...</option>
              {trips.map((t: any) => <option key={t.TRIP_ID} value={t.TRIP_ID}>{String(t.TRIP_ID).slice(0, 12)} ({t.DEV_PCT}% dev, {t.ACTUAL_KM}km)</option>)}
            </select>
          </div>
        )}
        {gpsPoints.length > 0 && (
          <>
            <div className="metric-grid-vertical" style={{ marginTop: 12 }}>
              <MetricCard label="GPS Points" value={filteredPoints.length} />
              <MetricCard label="Teleports" value={teleportCount} />
              <MetricCard label="Detour Points" value={detourCount} />
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, marginBottom: 4 }}>
                <input type="checkbox" checked={showTeleports} onChange={e => setShowTeleports(e.target.checked)} />
                <span style={{ color: '#EF4444' }}>Show teleports</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, marginBottom: 4 }}>
                <input type="checkbox" checked={hideTeleported} onChange={e => setHideTeleported(e.target.checked)} />
                Hide teleported points
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, marginBottom: 4 }}>
                <input type="checkbox" checked={showDetours} onChange={e => setShowDetours(e.target.checked)} />
                <span style={{ color: '#FFA500' }}>Show detours</span>
              </label>
            </div>
            <div className="form-group" style={{ marginTop: 8 }}>
              <label>Max GPS Accuracy ({maxAccuracy}m)</label>
              <input type="range" min={5} max={100} value={maxAccuracy}
                onChange={e => setMaxAccuracy(Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div style={{ marginTop: 12 }}>
              <h3 style={{ fontSize: 13, marginBottom: 4 }}>Speed Profile</h3>
              <ResponsiveContainer width="100%" height={120}>
                <LineChart data={speedData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="idx" tick={false} />
                  <YAxis tick={{ fill: '#6E7681', fontSize: 9 }} unit=" km/h" width={50} />
                  <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 11 }} />
                  <Line type="monotone" dataKey="speed" stroke="#29B5E8" strokeWidth={1.5} dot={false} name="Actual" />
                  <Line type="monotone" dataKey="limit" stroke="#E5484D" strokeWidth={1} dot={false} strokeDasharray="4 4" name="Speed Limit" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div style={{ marginTop: 8 }}>
              <h3 style={{ fontSize: 13, marginBottom: 4 }}>GPS Accuracy</h3>
              <ResponsiveContainer width="100%" height={80}>
                <AreaChart data={accuracyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="idx" tick={false} />
                  <YAxis tick={{ fill: '#6E7681', fontSize: 9 }} unit="m" width={40} />
                  <Area type="monotone" dataKey="accuracy" stroke="#8B5CF6" fill="rgba(139,92,246,0.15)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>
      <MapView layers={layers} initialViewState={viewState} />
    </div>
  );
}
