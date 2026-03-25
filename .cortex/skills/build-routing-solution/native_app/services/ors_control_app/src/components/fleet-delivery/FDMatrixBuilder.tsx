import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import MetricCard from '../../shared/MetricCard';
import DataTable from '../../shared/DataTable';
import { FD_DB, FD_SCHEMA, sfQuery, cartoBasemap } from './helpers';

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
      setLoading(false);
    });
  }, []);

  const totalHexes = useMemo(() => registry.reduce((s, r) => s + Number(r.TOTAL_HEXES || 0), 0), [registry]);
  const maxTime = useMemo(() => Math.max(1, ...hexData.map((h: any) => Number(h.TRAVEL_TIME_MIN || 0))), [hexData]);
  const basemap = useMemo(() => cartoBasemap(), []);

  const hexLayer = useMemo(() => {
    if (!hexData.length) return null;
    const validData = hexData.filter((d: any) => d.H3_INDEX && typeof d.H3_INDEX === 'string' && d.H3_INDEX.length >= 15);
    if (!validData.length) return null;
    return new H3HexagonLayer({
      id: 'matrix-hexes',
      data: validData,
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
    <div className="panel">
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Matrix Builder</h2>
      <p className="subtitle">Travel time matrix registry and visualization</p>
      <div className="metric-grid">
        <MetricCard label="Matrices" value={loading ? '...' : registry.length} />
        <MetricCard label="Total Hexes" value={loading ? '...' : totalHexes.toLocaleString()} />
      </div>
      <h3>Registry</h3>
      <DataTable data={registry} columns={['REGION_NAME', 'H3_RESOLUTION', 'TOTAL_HEXES', 'STATUS']} />
      <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8', marginTop: 12 }}>
        {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>Loading...</div>}
        <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} getTooltip={getTooltip} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  );
}
