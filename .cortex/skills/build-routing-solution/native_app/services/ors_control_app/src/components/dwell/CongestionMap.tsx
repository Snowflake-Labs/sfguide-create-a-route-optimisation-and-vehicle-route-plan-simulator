import { useState, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { useSfQuery } from '../../hooks/useSnowflake';
import { DWELL_DB, DWELL_SCHEMA, cartoBasemap } from './helpers';
import { useRegion } from '../../hooks/useRegion';

const COLOR_RANGE: [number, number, number][] = [
  [1, 152, 189], [73, 227, 206], [216, 254, 181],
  [254, 237, 177], [254, 173, 84], [209, 55, 78],
];

export default function CongestionMap() {
  const { center, zoom: regionZoom } = useRegion();
  const [hour, setHour] = useState(12);
  const [viewState, setViewState] = useState({ longitude: center.lng, latitude: center.lat, zoom: regionZoom, pitch: 45, bearing: 0 });

  const { data, loading } = useSfQuery(
    `SELECT H3_INT_TO_STRING(H3_CELL_R7::NUMBER) AS H3_INDEX, EXTRACT(HOUR FROM HOUR_BUCKET) AS HOUR_OF_DAY, SUM(SESSION_COUNT) AS DWELL_COUNT, ROUND(AVG(AVG_DWELL_MIN),1) AS AVG_DWELL_MIN FROM DT_H3_CONGESTION WHERE EXTRACT(HOUR FROM HOUR_BUCKET) = ${hour} GROUP BY H3_CELL_R7, EXTRACT(HOUR FROM HOUR_BUCKET) LIMIT 5000`,
    DWELL_DB, DWELL_SCHEMA, [hour],
  );

  const maxCount = useMemo(() => Math.max(1, ...data.map((r: any) => Number(r.DWELL_COUNT || 0))), [data]);
  const basemap = useMemo(() => cartoBasemap(), []);

  const hexLayer = useMemo(() => {
    if (!data.length) return null;
    const validData = data.filter((d: any) => d.H3_INDEX && typeof d.H3_INDEX === 'string' && d.H3_INDEX.length >= 15);
    if (!validData.length) return null;
    return new H3HexagonLayer({
      id: 'congestion-h3',
      data: validData,
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
    });
  }, [data, maxCount]);

  const layers = useMemo(() => [basemap, hexLayer].filter(Boolean), [basemap, hexLayer]);

  const getTooltip = useCallback(({ object }: any) => {
    if (!object || !object.H3_INDEX) return null;
    return {
      html: `<b>${object.H3_INDEX}</b><br/>Dwells: ${object.DWELL_COUNT}<br/>Avg: ${Number(object.AVG_DWELL_MIN).toFixed(1)} min`,
      style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' },
    };
  }, []);

  return (
    <div className="page-full">
      <div className="page-overlay-panel">
        <h3>Congestion Map</h3>
        <p>{loading ? 'Loading...' : `${data.length} hexagons at hour ${hour}:00`}</p>
        <div style={{ marginTop: 8, minWidth: 220 }}>
          <label className="range-label">Hour of Day: <strong>{hour}:00</strong></label>
          <input type="range" min={0} max={23} value={hour} onChange={e => setHour(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
      </div>
      <div className="map-view">
        {loading && <div className="map-loading-overlay">Loading...</div>}
        <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} getTooltip={getTooltip} style={{ width: '100%', height: '100%' }} />
        <div className="color-bar">
          <div className="color-bar-track">
            {COLOR_RANGE.map((c, i) => <div key={i} style={{ flex: 1, background: `rgb(${c.join(',')})` }} />)}
          </div>
          <div className="color-bar-labels">
            <span>Low</span><span>High</span>
          </div>
        </div>
      </div>
    </div>
  );
}
