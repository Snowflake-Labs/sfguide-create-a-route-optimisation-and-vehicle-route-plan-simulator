import { useState, useEffect, useMemo, useCallback } from 'react';
import { ScatterplotLayer } from '@deck.gl/layers';
import MapView from '../../shared/MapView';
import MetricCard from '../../shared/MetricCard';
import { useSnowflake } from '../../hooks/useSnowflake';
import { useRegion } from '../../hooks/useRegion';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

const STATE_COLORS: Record<string, [number, number, number, number]> = {
  DRIVING: [41, 181, 232, 200],
  IDLE: [234, 179, 8, 200],
  DWELLING: [255, 107, 53, 200],
  STOPPED: [239, 68, 68, 200],
};

export default function LiveOperations({ sourceDb, sourceSchema }: Props) {
  const { regionName, center, zoom } = useRegion();

  const [vehicles, setVehicles] = useState<any[]>([]);
  const [openDwells, setOpenDwells] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const { query } = useSnowflake();

  const refresh = useCallback(async () => {
    setLoading(true);
    const v = await query(
      `SELECT DRIVER_ID, CURRENT_STATE, ST_X(LAST_POSITION) AS LNG, ST_Y(LAST_POSITION) AS LAT,
              LAST_UPDATE, CURRENT_SPEED_KMH
       FROM DT_STATE_CHANGES WHERE REGION = '${regionName}'
       QUALIFY ROW_NUMBER() OVER (PARTITION BY DRIVER_ID ORDER BY EVENT_TIMESTAMP DESC) = 1
       LIMIT 500`,
      { database: sourceDb, schema: sourceSchema },
    );
    setVehicles(v);
    const d = await query(
      `SELECT DRIVER_ID, FACILITY_NAME, DWELL_START, DWELL_DURATION_MIN, SLA_THRESHOLD_MIN,
              ROUND(SLA_THRESHOLD_MIN - DWELL_DURATION_MIN, 1) AS TIME_REMAINING
       FROM DT_DWELL_ENRICHED WHERE DWELL_END IS NULL AND REGION = '${regionName}' ORDER BY DWELL_DURATION_MIN DESC LIMIT 50`,
      { database: sourceDb, schema: sourceSchema },
    );
    setOpenDwells(d);
    setLoading(false);
  }, [query, sourceDb, sourceSchema, regionName]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  const stateCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    vehicles.forEach((v: any) => { counts[v.CURRENT_STATE] = (counts[v.CURRENT_STATE] || 0) + 1; });
    return counts;
  }, [vehicles]);

  const layers = useMemo(() => {
    if (!vehicles.length) return [];
    return [
      new ScatterplotLayer({
        id: 'vehicle-positions',
        data: vehicles.filter((v: any) => v.LNG && v.LAT),
        getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)],
        getFillColor: (d: any) => STATE_COLORS[d.CURRENT_STATE] || [128, 128, 128, 200],
        getRadius: 100,
        radiusMinPixels: 4,
        radiusMaxPixels: 12,
        pickable: true,
      }),
    ];
  }, [vehicles]);

  return (
    <div className="page-full">
      <div className="page-sidebar-panel">
        <h2>Live Operations</h2>
        <p>{loading ? 'Refreshing...' : `${vehicles.length} vehicles tracked`}</p>
        <button className="btn-primary" onClick={refresh} style={{ marginBottom: 12, width: '100%' }}>Refresh Now</button>
        <div className="metric-grid-vertical">
          <MetricCard label="Driving" value={stateCounts['DRIVING'] || 0} />
          <MetricCard label="Idle" value={stateCounts['IDLE'] || 0} />
          <MetricCard label="Dwelling" value={stateCounts['DWELLING'] || 0} />
          <MetricCard label="Stopped" value={stateCounts['STOPPED'] || 0} />
        </div>
        {openDwells.length > 0 && (
          <>
            <h3 style={{ fontSize: 13, marginTop: 12, marginBottom: 8 }}>Open Dwells</h3>
            <div className="data-table-container" style={{ maxHeight: 250 }}>
              <table className="data-table">
                <thead><tr>
                  <th className="data-table-th">Driver</th>
                  <th className="data-table-th">Min</th>
                  <th className="data-table-th">Left</th>
                </tr></thead>
                <tbody>
                  {openDwells.map((d: any, i: number) => (
                    <tr key={i}>
                      <td>{d.DRIVER_ID}</td>
                      <td>{d.DWELL_DURATION_MIN}</td>
                      <td style={{ color: Number(d.TIME_REMAINING) < 0 ? '#E5484D' : '#0DB048' }}>{d.TIME_REMAINING}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="legend" style={{ marginTop: 16 }}>
          {Object.entries(STATE_COLORS).map(([state, color]) => (
            <div key={state} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: `rgb(${color.slice(0, 3).join(',')})` }} />
              <span style={{ fontSize: 11, color: '#6E7681' }}>{state}</span>
            </div>
          ))}
        </div>
      </div>
      <MapView layers={layers} initialViewState={{ longitude: center.lng, latitude: center.lat, zoom }} />
    </div>
  );
}
