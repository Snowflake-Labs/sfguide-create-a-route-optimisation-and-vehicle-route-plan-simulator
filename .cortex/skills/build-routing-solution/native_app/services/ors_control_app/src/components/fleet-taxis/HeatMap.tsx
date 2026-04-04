import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { FT_DB, FT_SCHEMA, sfQuery, cartoBasemap } from './helpers';

const COLOR_RANGE: [number, number, number][] = [
  [1, 152, 189], [73, 227, 206], [216, 254, 181],
  [254, 237, 177], [254, 173, 84], [209, 55, 78],
];

export default function HeatMap() {
  const [metric, setMetric] = useState<'TRIP_COUNT' | 'AVG_SPEED'>('TRIP_COUNT');
  const [hour, setHour] = useState(-1);
  const [h3Res, setH3Res] = useState(7);
  const [hexData, setHexData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewState, setViewState] = useState({ longitude: -122.42, latitude: 37.77, zoom: 11, pitch: 45, bearing: 0 });

  useEffect(() => {
    setLoading(true);
    const hourFilter = hour >= 0 ? `WHERE HOUR(TRIP_START_TIME) = ${hour}` : '';
    sfQuery(`SELECT H3_POINT_TO_CELL_STRING(ORIGIN, ${h3Res}) AS H3_INDEX, COUNT(*) AS TRIP_COUNT, ROUND(AVG(ROUTE_DISTANCE_METERS / 1000), 2) AS AVG_KM, ROUND(AVG(AVERAGE_KMH), 1) AS AVG_SPEED FROM TRIP_SUMMARY ${hourFilter} GROUP BY 1 HAVING TRIP_COUNT >= 2 ORDER BY TRIP_COUNT DESC LIMIT 8000`)
      .then(rows => { setHexData(rows); setLoading(false); });
  }, [hour, h3Res]);

  const maxVal = useMemo(() => Math.max(1, ...hexData.map((h: any) => Number(h[metric] || 0))), [hexData, metric]);
  const totalTrips = useMemo(() => hexData.reduce((s, h) => s + Number(h.TRIP_COUNT || 0), 0), [hexData]);
  const basemap = useMemo(() => cartoBasemap(), []);

  const hexLayer = useMemo(() => {
    if (!hexData.length) return null;
    const validData = hexData.filter((d: any) => d.H3_INDEX && typeof d.H3_INDEX === 'string' && d.H3_INDEX.length >= 15);
    if (!validData.length) return null;
    return new H3HexagonLayer({
      id: 'taxi-heatmap',
      data: validData,
      pickable: true,
      filled: true,
      extruded: true,
      elevationScale: 50,
      getHexagon: (d: any) => d.H3_INDEX,
      getFillColor: (d: any) => {
        const t = Math.min(Number(d[metric]) / maxVal, 1);
        const idx = Math.min(Math.floor(t * COLOR_RANGE.length), COLOR_RANGE.length - 1);
        return [...COLOR_RANGE[idx], 200] as [number, number, number, number];
      },
      getElevation: (d: any) => Number(d[metric]),
      updateTriggers: { getFillColor: [maxVal, metric], getElevation: [metric] },
    });
  }, [hexData, maxVal, metric]);

  const layers = useMemo(() => [basemap, hexLayer].filter(Boolean), [basemap, hexLayer]);

  const getTooltip = useCallback(({ object }: any) => {
    if (!object?.H3_INDEX) return null;
    return { html: `<b>${object.H3_INDEX}</b><br/>Trips: ${object.TRIP_COUNT}<br/>Avg Speed: ${object.AVG_SPEED} km/h`, style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' } };
  }, []);

  return (
    <div className="panel">
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Heat Map</h2>
      <p className="subtitle">{loading ? 'Loading...' : `${hexData.length} hexagons · ${totalTrips.toLocaleString()} trips`}</p>
      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="form-group" style={{ minWidth: 120 }}>
          <label>Metric</label>
          <select className="form-select" value={metric} onChange={e => setMetric(e.target.value as any)}>
            <option value="TRIP_COUNT">Trip Count</option>
            <option value="AVG_SPEED">Avg Speed</option>
          </select>
        </div>
        <div style={{ minWidth: 160 }}>
          <label className="range-label">Hour: {hour < 0 ? 'All' : `${hour}:00`}</label>
          <input type="range" min={-1} max={23} value={hour} onChange={e => setHour(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <div style={{ minWidth: 140 }}>
          <label className="range-label">H3 Resolution: {h3Res}</label>
          <input type="range" min={5} max={9} value={h3Res} onChange={e => setH3Res(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
      </div>
      <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
        {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>Loading...</div>}
        <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} getTooltip={getTooltip} style={{ width: '100%', height: '100%' }} />
        <div style={{ position: 'absolute', bottom: 12, left: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', gap: 0, height: 8, borderRadius: 4, overflow: 'hidden', width: 120 }}>
            {COLOR_RANGE.map((c, i) => <div key={i} style={{ flex: 1, background: `rgb(${c.join(',')})` }} />)}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#fff' }}><span>Low</span><span>High</span></div>
        </div>
      </div>
    </div>
  );
}
