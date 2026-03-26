import { useMemo } from 'react';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import MapView from '../../shared/MapView';
import MetricCard from '../../shared/MetricCard';
import { useSfQuery } from '../../hooks/useSnowflake';
import { useRegion } from '../../hooks/useRegion';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

export default function MatrixBuilder({ sourceDb, sourceSchema }: Props) {
  const { regionName, center, zoom } = useRegion();

  const { data: matrices, loading } = useSfQuery(
    `SELECT REGION_NAME, H3_RESOLUTION, TOTAL_HEXES, STATUS, CREATED_AT
     FROM MATRIX_REGISTRY WHERE REGION = '${regionName}' ORDER BY CREATED_AT DESC LIMIT 20`, sourceDb, sourceSchema, [regionName]);

  const { data: hexes } = useSfQuery(
    `SELECT H3_INDEX, TRAVEL_TIME_MIN FROM TRAVEL_TIME_MATRIX WHERE REGION = '${regionName}' LIMIT 5000`, sourceDb, sourceSchema, [regionName]);

  const maxTime = useMemo(() => Math.max(1, ...hexes.map((h: any) => Number(h.TRAVEL_TIME_MIN) || 1)), [hexes]);

  const layers = useMemo(() => {
    if (!hexes.length) return [];
    return [new H3HexagonLayer({
      id: 'matrix-hexes', data: hexes, pickable: true, filled: true, extruded: false,
      getHexagon: (d: any) => d.H3_INDEX,
      getFillColor: (d: any) => {
        const t = Math.min(Number(d.TRAVEL_TIME_MIN) / maxTime, 1);
        return [Math.round(120 + t * 135), Math.round(180 * (1 - t)), Math.round(232 * (1 - t)), 180] as [number, number, number, number];
      },
      updateTriggers: { getFillColor: [maxTime] },
    })];
  }, [hexes, maxTime]);

  const totalHexes = matrices.reduce((s: number, m: any) => s + Number(m.TOTAL_HEXES || 0), 0);

  return (
    <div className="page-full">
      <div className="page-sidebar-panel">
        <h2>Matrix Builder</h2>
        <div className="metric-grid-vertical">
          <MetricCard label="Matrices" value={loading ? '...' : matrices.length} />
          <MetricCard label="Total Hexes" value={totalHexes.toLocaleString()} />
        </div>
        <h3 style={{ fontSize: 13, marginTop: 12, marginBottom: 8 }}>Matrix Registry</h3>
        <div className="data-table-container" style={{ maxHeight: 350 }}>
          <table className="data-table">
            <thead><tr><th className="data-table-th">Region</th><th className="data-table-th">Res</th><th className="data-table-th">Hexes</th><th className="data-table-th">Status</th></tr></thead>
            <tbody>{matrices.map((m: any, i: number) => (
              <tr key={i}>
                <td>{m.REGION_NAME}</td><td>{m.H3_RESOLUTION}</td>
                <td>{Number(m.TOTAL_HEXES).toLocaleString()}</td>
                <td><span className={`status-badge ${m.STATUS === 'COMPLETE' ? 'ok' : 'pending'}`}>{m.STATUS}</span></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
      <MapView layers={layers} initialViewState={{ longitude: center.lng, latitude: center.lat, zoom: zoom }} />
    </div>
  );
}
