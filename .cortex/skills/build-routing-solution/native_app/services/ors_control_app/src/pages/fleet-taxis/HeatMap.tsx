import { useMemo, useState } from 'react';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import MapView from '../../shared/MapView';
import MetricCard from '../../shared/MetricCard';
import { useSfQuery } from '../../hooks/useSnowflake';
import { useRegion } from '../../hooks/useRegion';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

const COLOR_RANGE: [number, number, number][] = [
  [65, 182, 196], [127, 205, 187], [199, 233, 180],
  [237, 248, 177], [255, 255, 204], [255, 237, 160],
  [254, 217, 118], [254, 178, 76], [253, 141, 60],
  [252, 78, 42], [227, 26, 28], [177, 0, 38],
];

export default function HeatMap({ sourceDb, sourceSchema, config }: Props) {
  const { regionName, center, zoom } = useRegion();

  const [metric, setMetric] = useState<'TRIP_COUNT' | 'AVG_SPEED'>('TRIP_COUNT');
  const [hour, setHour] = useState<number | null>(null);
  const [h3Res, setH3Res] = useState(8);

  const hourFilter = hour !== null
    ? `WHERE REGION = '${regionName}' AND HOUR(TRIP_START_TIME) = ${hour}`
    : `WHERE REGION = '${regionName}'`;

  const { data, loading } = useSfQuery(
    `SELECT H3_POINT_TO_CELL_STRING(ORIGIN, ${h3Res}) AS H3_INDEX,
            COUNT(*) AS TRIP_COUNT,
            ROUND(AVG(ROUTE_DISTANCE_METERS / 1000), 2) AS AVG_KM,
            ROUND(AVG(AVERAGE_KMH), 1) AS AVG_SPEED
     FROM TRIP_SUMMARY ${hourFilter}
     GROUP BY 1 HAVING TRIP_COUNT >= 2
     ORDER BY TRIP_COUNT DESC LIMIT 8000`, sourceDb, sourceSchema, [hour, h3Res, regionName]);

  const maxVal = useMemo(() => Math.max(1, ...data.map((d: any) => Number(d[metric]) || 1)), [data, metric]);

  const layers = useMemo(() => {
    const l: any[] = [];
    if (data.length) {
      l.push(new H3HexagonLayer({
        id: 'taxi-heatmap', data, pickable: true, filled: true, extruded: true,
        elevationScale: metric === 'TRIP_COUNT' ? 20 : 50,
        getHexagon: (d: any) => d.H3_INDEX,
        getFillColor: (d: any) => {
          const t = Math.min(Number(d[metric]) / maxVal, 1);
          const idx = Math.min(Math.floor(t * COLOR_RANGE.length), COLOR_RANGE.length - 1);
          return [...COLOR_RANGE[idx], 200] as [number, number, number, number];
        },
        getElevation: (d: any) => Number(d[metric]),
        updateTriggers: { getFillColor: [maxVal, metric], getElevation: [metric] },
      }));
    }
    return l;
  }, [data, maxVal, metric]);

  const viewState = useMemo(() => {
    if (data.length) {
      return undefined;
    }
    const ors = config?.ors?.bounds?.center;
    if (ors?.lng && ors?.lat) return { longitude: ors.lng, latitude: ors.lat, zoom: 11, pitch: 45 };
    return { longitude: center.lng, latitude: center.lat, zoom, pitch: 45 };
  }, [data, config, center, zoom]);

  return (
    <div className="page-full">
      <div className="page-overlay-panel">
        <h3>Taxi Heatmap</h3>
        <p>{loading ? 'Loading...' : `${data.length} hexagons`}</p>
        <div className="form-group" style={{ marginTop: 10 }}>
          <label>Metric</label>
          <select className="form-select" value={metric} onChange={e => setMetric(e.target.value as any)}>
            <option value="TRIP_COUNT">Trip Count</option>
            <option value="AVG_SPEED">Avg Speed (km/h)</option>
          </select>
        </div>
        <div className="form-group" style={{ marginTop: 8 }}>
          <label>Hour Filter {hour !== null ? `(${hour}:00)` : '(All)'}</label>
          <input type="range" min={0} max={23} value={hour ?? 12}
            onChange={e => setHour(Number(e.target.value))} style={{ width: '100%' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
            <button onClick={() => setHour(null)}
              style={{ fontSize: 10, background: 'none', border: '1px solid #E1E4E8', borderRadius: 4, padding: '2px 6px', cursor: 'pointer', color: '#6E7681' }}>
              All Hours
            </button>
          </div>
        </div>
        <div className="form-group" style={{ marginTop: 8 }}>
          <label>H3 Resolution ({h3Res})</label>
          <input type="range" min={6} max={10} value={h3Res}
            onChange={e => setH3Res(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <div style={{ marginTop: 12 }}>
          <MetricCard label="Total Trips" value={data.reduce((s: number, d: any) => s + Number(d.TRIP_COUNT), 0).toLocaleString()} />
        </div>
      </div>
      <MapView layers={layers} initialViewState={viewState || { longitude: center.lng, latitude: center.lat, zoom, pitch: 45 }} />
    </div>
  );
}
