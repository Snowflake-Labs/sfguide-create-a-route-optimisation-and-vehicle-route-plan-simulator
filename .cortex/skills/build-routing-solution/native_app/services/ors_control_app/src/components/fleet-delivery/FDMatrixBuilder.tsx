import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { sfQuery, cartoBasemap } from './helpers';

export default function FDMatrixBuilder() {
  const [registry, setRegistry] = useState<any[]>([]);
  const [hexData, setHexData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewState, setViewState] = useState({ longitude: -122.43, latitude: 37.77, zoom: 11, pitch: 0, bearing: 0 });

  useEffect(() => {
    setLoading(true);
    Promise.all([
      sfQuery(`SELECT REGION_NAME, H3_RESOLUTION, TOTAL_HEXES, STATUS, CREATED_AT FROM MATRIX_REGISTRY ORDER BY CREATED_AT DESC LIMIT 20`),
      sfQuery(`SELECT H3_INDEX, TRAVEL_TIME_MIN FROM TRAVEL_TIME_MATRIX LIMIT 5000`),
    ]).then(([r, h]) => {
      setRegistry(r);
      setHexData(h);
    }).finally(() => setLoading(false));
  }, []);

  const totalHexes = useMemo(() => registry.reduce((s, r) => s + Number(r.TOTAL_HEXES || 0), 0), [registry]);
  const maxTime = useMemo(() => Math.max(1, ...hexData.map((h: any) => Number(h.TRAVEL_TIME_MIN || 0))), [hexData]);

  const basemap = useMemo(() => cartoBasemap(), []);

  const hexLayer = useMemo(() => {
    if (!hexData.length) return null;
    return new H3HexagonLayer({
      id: 'matrix-hexes',
      data: hexData,
      pickable: true,
      filled: true,
      extruded: false,
      getHexagon: (d: any) => d.H3_INDEX,
      getFillColor: (d: any) => {
        const t = Math.min(Number(d.TRAVEL_TIME_MIN) / maxTime, 1);
        const r = Math.floor(t * 255);
        const g = Math.floor((1 - t) * 200);
        return [r, g, 60, 180] as [number, number, number, number];
      },
      updateTriggers: { getFillColor: [maxTime] },
    });
  }, [hexData, maxTime]);

  const layers = useMemo(() => [basemap, hexLayer].filter(Boolean), [basemap, hexLayer]);

  const getTooltip = useCallback(({ object }: any) => {
    if (!object?.H3_INDEX) return null;
    return {
      html: `<b>${object.H3_INDEX}</b><br/>Travel time: ${Number(object.TRAVEL_TIME_MIN).toFixed(1)} min`,
      style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' },
    };
  }, []);

  return (
    <div>
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Matrix Builder</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>Travel time matrix registry and visualization</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
        {[
          { label: 'Matrices', value: registry.length },
          { label: 'Total Hexes', value: totalHexes.toLocaleString() },
        ].map(m => (
          <div key={m.label} style={{ padding: 16, borderRadius: 8, background: 'rgba(0,0,0,0.02)', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{m.label}</div>
            <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{m.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 300 }}>
          <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
            {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>Loading...</div>}
            <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} getTooltip={getTooltip} style={{ width: '100%', height: '100%' }} />
          </div>
        </div>
        {registry.length > 0 && (
          <div style={{ flex: '0 0 300px', maxHeight: 560, overflowY: 'auto' }}>
            <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Registry</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><tr>{['Region', 'Res', 'Hexes', 'Status'].map(h => <th key={h} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontWeight: 500 }}>{h}</th>)}</tr></thead>
              <tbody>{registry.map((r, i) => (
                <tr key={i} style={{ borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                  <td style={{ padding: '6px 8px' }}>{r.REGION_NAME}</td>
                  <td style={{ padding: '6px 8px' }}>{r.H3_RESOLUTION}</td>
                  <td style={{ padding: '6px 8px' }}>{Number(r.TOTAL_HEXES).toLocaleString()}</td>
                  <td style={{ padding: '6px 8px' }}><span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11, background: r.STATUS === 'COMPLETE' ? 'rgba(13,176,72,0.1)' : 'rgba(234,179,8,0.1)', color: r.STATUS === 'COMPLETE' ? '#0DB048' : '#E5A100' }}>{r.STATUS}</span></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
