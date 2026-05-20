import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import MetricCard from '../../shared/MetricCard';
import { fmtDec } from '../../shared/format';
import { RD_DB, RD_SCHEMA, sfQuery, cartoBasemap } from './helpers';
import { useRegion } from '../../hooks/useRegion';
import { useVehicleType } from '../../hooks/useVehicleType';

export default function RouteComparison() {
  const { regionName, center, zoom } = useRegion();
  const { vehicleType } = useVehicleType();
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);
  const [actualPath, setActualPath] = useState<any[]>([]);
  const [expectedPath, setExpectedPath] = useState<any[]>([]);
  const [routes, setRoutes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewState, setViewState] = useState({ longitude: center.lng, latitude: center.lat, zoom, pitch: 0, bearing: 0 });

  useEffect(() => {
    setLoading(true);
    sfQuery(`SELECT TRIP_ID, DRIVER_ID, TRIP_DATE, ROUND(DISTANCE_DEVIATION_PCT, 1) AS DEV_PCT, ORIGIN_NAME, DEST_NAME FROM TRIP_DEVIATION_ANALYSIS ORDER BY DISTANCE_DEVIATION_PCT DESC LIMIT 100`)
      .then(r => { setRoutes(r); setLoading(false); });
  }, [regionName, vehicleType]);

  useEffect(() => {
    setViewState(prev => ({ ...prev, longitude: center.lng, latitude: center.lat, zoom }));
  }, [center.lng, center.lat, zoom]);

  const loadRoute = useCallback(async (tripId: string) => {
    setSelectedRoute(tripId);
    const [actual, expected] = await Promise.all([
      sfQuery(`SELECT f.INDEX AS POINT_INDEX, GET(f.VALUE, 0)::FLOAT AS LNG, GET(f.VALUE, 1)::FLOAT AS LAT FROM TRIP_DEVIATION_ANALYSIS t, LATERAL FLATTEN(INPUT => ST_ASGEOJSON(t.ACTUAL_PATH):coordinates) f WHERE t.TRIP_ID = '${tripId}' ORDER BY f.INDEX`),
      sfQuery(`SELECT f.INDEX AS POINT_INDEX, GET(f.VALUE, 0)::FLOAT AS LNG, GET(f.VALUE, 1)::FLOAT AS LAT FROM TRIP_DEVIATION_ANALYSIS t, LATERAL FLATTEN(INPUT => ST_ASGEOJSON(t.EXPECTED_PATH):coordinates) f WHERE t.TRIP_ID = '${tripId}' ORDER BY f.INDEX`),
    ]);
    setActualPath(actual);
    setExpectedPath(expected);
    const allPts = [...actual, ...expected].filter((p: any) => p.LNG && p.LAT);
    if (allPts.length) {
      const lngs = allPts.map((p: any) => Number(p.LNG));
      const lats = allPts.map((p: any) => Number(p.LAT));
      setViewState(prev => ({ ...prev, longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2, latitude: (Math.min(...lats) + Math.max(...lats)) / 2, zoom: 12 }));
    }
  }, []);

  const selected = useMemo(() => routes.find(r => r.TRIP_ID === selectedRoute), [routes, selectedRoute]);
  const basemap = useMemo(() => cartoBasemap(), []);

  const dataLayers = useMemo(() => {
    const result: any[] = [];
    if (expectedPath.length > 1) {
      result.push(new PathLayer({ id: 'expected-route', data: [{ path: expectedPath.map((p: any) => [Number(p.LNG), Number(p.LAT)]) }], getPath: (d: any) => d.path, getColor: [34, 197, 94, 200], getWidth: 4, widthMinPixels: 3 }));
    }
    if (actualPath.length > 1) {
      result.push(new PathLayer({ id: 'actual-route', data: [{ path: actualPath.map((p: any) => [Number(p.LNG), Number(p.LAT)]) }], getPath: (d: any) => d.path, getColor: [239, 68, 68, 200], getWidth: 4, widthMinPixels: 3 }));
    }
    if (actualPath.length > 0) {
      result.push(new ScatterplotLayer({ id: 'start-marker', data: [actualPath[0]], getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)], getFillColor: [41, 181, 232, 255], getRadius: 60, radiusMinPixels: 6 }));
      result.push(new ScatterplotLayer({ id: 'end-marker', data: [actualPath[actualPath.length - 1]], getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)], getFillColor: [128, 0, 255, 255], getRadius: 60, radiusMinPixels: 6 }));
    }
    return result;
  }, [actualPath, expectedPath]);

  const layers = useMemo(() => [basemap, ...dataLayers].filter(Boolean), [basemap, dataLayers]);

  return (
    <div className="panel">
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Route Comparison</h2>
      <p className="subtitle">Expected vs actual route overlay</p>
      {selected && (
        <div className="metric-grid">
          <MetricCard label="Deviation" value={`${fmtDec(selected.DEV_PCT)}%`} />
          <MetricCard label="Origin" value={selected.ORIGIN_NAME || '—'} />
          <MetricCard label="Destination" value={selected.DEST_NAME || '—'} />
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, fontSize: 12 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 16, height: 3, background: '#22C55E', borderRadius: 2 }} /> Expected</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 16, height: 3, background: '#EF4444', borderRadius: 2 }} /> Actual</span>
      </div>
      <div style={{ maxHeight: 180, overflowY: 'auto', marginBottom: 12 }}>
        <table className="sidebar-table">
          <thead><tr>{['Trip', 'Driver', 'Dev%'].map(h => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{routes.map((r: any) => (
            <tr key={r.TRIP_ID} className={`clickable${selectedRoute === r.TRIP_ID ? ' selected' : ''}`} onClick={() => loadRoute(r.TRIP_ID)}>
              <td className="mono">{String(r.TRIP_ID).slice(-10)}</td>
              <td>{r.DRIVER_ID}</td>
              <td className={Number(r.DEV_PCT) > 20 ? 'text-danger' : ''} style={{ fontWeight: 600 }}>{fmtDec(r.DEV_PCT)}%</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
        {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>Loading...</div>}
        <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  );
}
