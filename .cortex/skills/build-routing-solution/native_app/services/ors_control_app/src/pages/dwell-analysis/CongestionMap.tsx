import { useMemo, useState } from 'react';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import MapView from '../../shared/MapView';
import { useSfQuery } from '../../hooks/useSnowflake';
import { useRegion } from '../../hooks/useRegion';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

const COLOR_RANGE: [number, number, number][] = [
  [1, 152, 189], [73, 227, 206], [216, 254, 181],
  [254, 237, 177], [254, 173, 84], [209, 55, 78],
];

export default function CongestionMap({ sourceDb, sourceSchema }: Props) {
  const { regionName, center, zoom } = useRegion();

  const [hour, setHour] = useState(12);

  const { data, loading } = useSfQuery(
    `SELECT H3_INDEX, HOUR_OF_DAY, DWELL_COUNT, AVG_DWELL_MIN
     FROM DT_H3_CONGESTION WHERE HOUR_OF_DAY = ${hour} AND REGION = '${regionName}'`,
    sourceDb, sourceSchema, [hour, regionName],
  );

  const maxCount = useMemo(() => Math.max(1, ...data.map((r: any) => Number(r.DWELL_COUNT))), [data]);

  const layers = useMemo(() => {
    if (!data.length) return [];
    return [
      new H3HexagonLayer({
        id: 'congestion-h3',
        data,
        pickable: true,
        filled: true,
        extruded: true,
        elevationScale: 50,
        getHexagon: (d: any) => d.H3_INDEX,
        getFillColor: (d: any) => {
          const t = Math.min(Number(d.DWELL_COUNT) / maxCount, 1);
          const idx = Math.min(Math.floor(t * COLOR_RANGE.length), COLOR_RANGE.length - 1);
          return [...COLOR_RANGE[idx], 200] as [number, number, number, number];
        },
        getElevation: (d: any) => Number(d.DWELL_COUNT),
        updateTriggers: { getFillColor: [maxCount], getElevation: [data.length] },
      }),
    ];
  }, [data, maxCount]);

  return (
    <div className="page-full">
      <div className="page-overlay-panel">
        <h3>H3 Congestion Map</h3>
        <p>{loading ? 'Loading...' : `${data.length} hexagons at hour ${hour}:00`}</p>
        <div className="form-group" style={{ marginTop: 12 }}>
          <label>Hour of Day: {hour}:00</label>
          <input type="range" min={0} max={23} value={hour} onChange={e => setHour(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
      </div>
      <MapView layers={layers} initialViewState={{ longitude: center.lng, latitude: center.lat, zoom, pitch: 45 }} />
    </div>
  );
}
