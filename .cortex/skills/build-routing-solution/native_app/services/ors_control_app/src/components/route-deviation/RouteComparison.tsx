import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { sfQuery, cartoBasemap } from './helpers';

export default function RouteComparison() {
  const [routes, setRoutes] = useState<any[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);
  const [actualPath, setActualPath] = useState<any[]>([]);
  const [expectedPath, setExpectedPath] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewState, setViewState] = useState({ longitude: -122.43, latitude: 37.77, zoom: 11, pitch: 0, bearing: 0 });

  useEffect(() => {
    setLoading(true);
    sfQuery(`SELECT TRIP_ID, DRIVER_ID, TRIP_DATE, ROUND(DISTANCE_DEVIATION_PCT, 1) AS DEV_PCT, ROUND(ACTUAL_DISTANCE_KM, 1) AS ACTUAL_KM, ROUND(EXPECTED_DISTANCE_KM, 1) AS EXPECTED_KM, ORIGIN_ADDRESS, DESTINATION_ADDRESS FROM TRIP_DEVIATION_ANALYSIS ORDER BY DISTANCE_DEVIATION_PCT DESC LIMIT 100`)
      .then(setRoutes)
      .finally(() => setLoading(false));
  }, []);

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
    <div>
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Route Comparison</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>Expected vs actual route overlay</p>

      {selected && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
          {[
            { label: 'Deviation', value: `${selected.DEV_PCT}%` },
            { label: 'Actual', value: `${selected.ACTUAL_KM} km` },
            { label: 'Expected', value: `${selected.EXPECTED_KM} km` },
          ].map(m => (
            <div key={m.label} style={{ padding: 12, borderRadius: 8, background: 'rgba(0,0,0,0.02)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{m.label}</div>
              <div style={{ fontSize: 16, fontWeight: 600, marginTop: 4 }}>{m.value}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '0 0 280px', maxHeight: 560, overflowY: 'auto' }}>
          <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 11 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 3, background: '#22C55E', display: 'inline-block' }} /> Expected</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 3, background: '#EF4444', display: 'inline-block' }} /> Actual</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead><tr>{['Trip', 'Driver', 'Dev%'].map(h => <th key={h} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)' }}>{h}</th>)}</tr></thead>
            <tbody>{routes.map((r: any) => (
              <tr key={r.TRIP_ID} onClick={() => loadRoute(r.TRIP_ID)} style={{ cursor: 'pointer', background: selectedRoute === r.TRIP_ID ? 'rgba(41,181,232,0.1)' : undefined }}>
                <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{String(r.TRIP_ID).slice(-10)}</td>
                <td style={{ padding: '6px 8px' }}>{r.DRIVER_ID}</td>
                <td style={{ padding: '6px 8px', color: Number(r.DEV_PCT) > 20 ? '#E5484D' : undefined, fontWeight: 600 }}>{r.DEV_PCT}%</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <div style={{ flex: 1, minWidth: 300 }}>
          <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
            {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>Loading...</div>}
            <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} style={{ width: '100%', height: '100%' }} />
          </div>
        </div>
      </div>
    </div>
  );
}
