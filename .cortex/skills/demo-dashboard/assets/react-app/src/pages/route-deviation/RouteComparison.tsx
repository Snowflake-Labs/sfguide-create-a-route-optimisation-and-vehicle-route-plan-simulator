import { useMemo, useState } from 'react';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import MapView from '../../shared/MapView';
import MetricCard from '../../shared/MetricCard';
import { useSfQuery, useSnowflake } from '../../hooks/useSnowflake';
import { useRegion } from '../../hooks/useRegion';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

export default function RouteComparison({ sourceDb, sourceSchema }: Props) {
  const { regionName, center, zoom } = useRegion();
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);
  const [actualPath, setActualPath] = useState<any[]>([]);
  const [expectedPath, setExpectedPath] = useState<any[]>([]);
  const { query } = useSnowflake();

  const { data: routes } = useSfQuery(
    `SELECT TRIP_ID, DRIVER_ID, TRIP_DATE,
            ROUND(DISTANCE_DEVIATION_PCT, 1) AS DEV_PCT,
            ROUND(DISTANCE_DEVIATION_KM, 2) AS DEV_KM,
            ROUND(ACTUAL_DISTANCE_KM, 1) AS ACTUAL_KM,
            ORIGIN_NAME, DEST_NAME
     FROM TRIP_DEVIATION_ANALYSIS WHERE REGION = '${regionName}' ORDER BY DISTANCE_DEVIATION_PCT DESC LIMIT 100`, sourceDb, sourceSchema, [regionName]);

  const loadRoute = async (tripId: string) => {
    setSelectedRoute(tripId);
    const actual = await query(
      `SELECT f.INDEX AS POINT_INDEX,
              GET(f.VALUE, 0)::FLOAT AS LNG,
              GET(f.VALUE, 1)::FLOAT AS LAT
       FROM TRIP_DEVIATION_ANALYSIS t,
         LATERAL FLATTEN(INPUT => ST_ASGEOJSON(t.ACTUAL_PATH):coordinates) f
       WHERE t.TRIP_ID = '${tripId}' ORDER BY f.INDEX`,
      { database: sourceDb, schema: sourceSchema });
    setActualPath(actual);
    const expected = await query(
      `SELECT f.INDEX AS POINT_INDEX,
              GET(f.VALUE, 0)::FLOAT AS LNG,
              GET(f.VALUE, 1)::FLOAT AS LAT
       FROM TRIP_DEVIATION_ANALYSIS t,
         LATERAL FLATTEN(INPUT => ST_ASGEOJSON(t.EXPECTED_PATH):coordinates) f
       WHERE t.TRIP_ID = '${tripId}' ORDER BY f.INDEX`,
      { database: sourceDb, schema: sourceSchema });
    setExpectedPath(expected);
  };

  const layers = useMemo(() => {
    const l: any[] = [];
    if (expectedPath.length > 1) {
      l.push(new PathLayer({
        id: 'expected-route',
        data: [{ path: expectedPath.map((p: any) => [Number(p.LNG), Number(p.LAT)]) }],
        getPath: (d: any) => d.path, getColor: [34, 197, 94, 180], getWidth: 4, widthMinPixels: 2,
      }));
    }
    if (actualPath.length > 1) {
      l.push(new PathLayer({
        id: 'actual-route',
        data: [{ path: actualPath.map((p: any) => [Number(p.LNG), Number(p.LAT)]) }],
        getPath: (d: any) => d.path, getColor: [239, 68, 68, 180], getWidth: 4, widthMinPixels: 2,
      }));
    }
    if (actualPath.length) {
      l.push(new ScatterplotLayer({
        id: 'start-marker', data: [actualPath[0]],
        getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)],
        getFillColor: [41, 181, 232, 255], getRadius: 100, radiusMinPixels: 6,
      }));
      l.push(new ScatterplotLayer({
        id: 'end-marker', data: [actualPath[actualPath.length - 1]],
        getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)],
        getFillColor: [168, 85, 247, 255], getRadius: 100, radiusMinPixels: 6,
      }));
    }
    return l;
  }, [actualPath, expectedPath]);

  const viewState = useMemo(() => {
    const pts = [...actualPath, ...expectedPath].filter((p: any) => p.LNG);
    if (pts.length) {
      const lngs = pts.map((p: any) => Number(p.LNG));
      const lats = pts.map((p: any) => Number(p.LAT));
      return { longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2, latitude: (Math.min(...lats) + Math.max(...lats)) / 2, zoom: 10 };
    }
    return { longitude: center.lng, latitude: center.lat, zoom };
  }, [actualPath, expectedPath]);

  const sel = routes.find((r: any) => r.TRIP_ID === selectedRoute);

  return (
    <div className="page-full">
      <div className="page-sidebar-panel">
        <h2>Route Comparison</h2>
        {sel && (
          <div className="metric-grid-vertical">
            <MetricCard label="Deviation" value={`${sel.DEV_PCT}%`} subtitle={`${sel.DEV_KM} km`} />
            <MetricCard label="Actual Distance" value={`${sel.ACTUAL_KM} km`} />
            <MetricCard label="From" value={String(sel.ORIGIN_NAME || '').slice(0, 20)} />
            <MetricCard label="To" value={String(sel.DEST_NAME || '').slice(0, 20)} />
          </div>
        )}
        <div className="legend" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <div style={{ width: 16, height: 3, background: '#0DB048', borderRadius: 2 }} />
            <span style={{ fontSize: 11, color: '#6E7681' }}>Expected Route</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 16, height: 3, background: '#E5484D', borderRadius: 2 }} />
            <span style={{ fontSize: 11, color: '#6E7681' }}>Actual Route</span>
          </div>
        </div>
        <h3 style={{ fontSize: 13, marginBottom: 8 }}>Routes (by deviation)</h3>
        <div className="data-table-container" style={{ maxHeight: 320 }}>
          <table className="data-table">
            <thead><tr><th className="data-table-th">Trip</th><th className="data-table-th">Dev %</th><th className="data-table-th">Km</th></tr></thead>
            <tbody>{routes.map((r: any) => (
              <tr key={r.TRIP_ID} onClick={() => loadRoute(r.TRIP_ID)} style={{ cursor: 'pointer', background: selectedRoute === r.TRIP_ID ? 'rgba(41,181,232,0.1)' : undefined }}>
                <td style={{ fontSize: 11 }}>{String(r.TRIP_ID).slice(-12)}</td>
                <td style={{ color: Number(r.DEV_PCT) > 20 ? '#E5484D' : Number(r.DEV_PCT) > 10 ? '#E5A100' : '#0DB048' }}>{r.DEV_PCT}%</td>
                <td>{r.DEV_KM}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
      <MapView layers={layers} initialViewState={viewState} />
    </div>
  );
}
