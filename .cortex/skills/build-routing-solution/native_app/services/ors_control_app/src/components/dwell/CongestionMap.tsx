import { useState, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { useSfQuery } from '../../hooks/useSnowflake';
import { DWELL_DB, DWELL_SCHEMA, cartoBasemap } from './helpers';

const COLOR_RANGE: [number, number, number][] = [
  [1, 152, 189], [73, 227, 206], [216, 254, 181],
  [254, 237, 177], [254, 173, 84], [209, 55, 78],
];

export default function CongestionMap() {
  const [hour, setHour] = useState(12);
  const [viewState, setViewState] = useState({ longitude: 9.57, latitude: 50.91, zoom: 6, pitch: 45, bearing: 0 });

  const { data, loading } = useSfQuery(
    `SELECT H3_INT_TO_STRING(H3_CELL_R7::NUMBER) AS H3_INDEX, EXTRACT(HOUR FROM HOUR_BUCKET) AS HOUR_OF_DAY, SUM(SESSION_COUNT) AS DWELL_COUNT, ROUND(AVG(AVG_DWELL_MIN),1) AS AVG_DWELL_MIN FROM DT_H3_CONGESTION WHERE EXTRACT(HOUR FROM HOUR_BUCKET) = ${hour} GROUP BY H3_CELL_R7, EXTRACT(HOUR FROM HOUR_BUCKET) LIMIT 5000`,
    DWELL_DB, DWELL_SCHEMA, [hour],
  );

  const maxCount = useMemo(() => Math.max(1, ...data.map((r: any) => Number(r.DWELL_COUNT || 0))), [data]);
  const basemap = useMemo(() => cartoBasemap(), []);

  const hexLayer = useMemo(() => {
    if (!data.length) return null;
    return new H3HexagonLayer({
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
    <div className="page-full" style={{ flexDirection: 'column' }}>
      <div className="page-overlay-panel">
        <h3>Congestion Map</h3>
        <p>{loading ? 'Loading...' : `${data.length} hexagons at hour ${hour}:00`}</p>
        <div style={{ marginTop: 8, minWidth: 220 }}>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Hour of Day: <strong>{hour}:00</strong></label>
          <input type="range" min={0} max={23} value={hour} onChange={e => setHour(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
      </div>
      <div className="map-view">
        {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>Loading...</div>}
        <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} getTooltip={getTooltip} style={{ width: '100%', height: '100%' }} />
        <div style={{ position: 'absolute', bottom: 12, left: 12, right: 12 }}>
          <div style={{ display: 'flex', gap: 0, height: 8, borderRadius: 4, overflow: 'hidden' }}>
            {COLOR_RANGE.map((c, i) => <div key={i} style={{ flex: 1, background: `rgb(${c.join(',')})` }} />)}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-secondary)' }}>
            <span>Low</span><span>High</span>
          </div>
        </div>
      </div>
    </div>
  );
}
