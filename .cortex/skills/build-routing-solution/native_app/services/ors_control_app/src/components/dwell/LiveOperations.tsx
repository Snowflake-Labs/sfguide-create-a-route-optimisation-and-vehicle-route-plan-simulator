import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer } from '@deck.gl/layers';
import { useSnowflake } from '../../hooks/useSnowflake';
import { DWELL_DB, DWELL_SCHEMA, cartoBasemap } from './helpers';

const STATE_COLORS: Record<string, [number, number, number, number]> = {
  DRIVING: [41, 181, 232, 200],
  IDLE: [234, 179, 8, 200],
  DWELLING: [255, 107, 53, 200],
  STOPPED: [239, 68, 68, 200],
};

export default function LiveOperations() {
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [openDwells, setOpenDwells] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewState, setViewState] = useState({ longitude: 9.57, latitude: 50.91, zoom: 6, pitch: 0, bearing: 0 });

  const { query } = useSnowflake();

  const refresh = useCallback(async () => {
    setLoading(true);
    const [v, d] = await Promise.all([
      query(`SELECT TRUCK_ID AS DRIVER_ID, STATUS AS CURRENT_STATE, LONGITUDE AS LNG, LATITUDE AS LAT, TS AS LAST_UPDATE, SPEED_KMH AS CURRENT_SPEED_KMH FROM DT_STATE_CHANGES WHERE IS_STATE_CHANGE = TRUE QUALIFY ROW_NUMBER() OVER (PARTITION BY TRUCK_ID ORDER BY TS DESC) = 1 LIMIT 500`, { database: DWELL_DB, schema: DWELL_SCHEMA }),
      query(`SELECT TRUCK_ID AS DRIVER_ID, LOCATION_NAME AS FACILITY_NAME, SESSION_START AS DWELL_START, ROUND(DWELL_MINUTES,1) AS DWELL_DURATION_MIN, 30 AS SLA_THRESHOLD_MIN, ROUND(30 - DWELL_MINUTES, 1) AS TIME_REMAINING FROM DT_DWELL_ENRICHED WHERE SESSION_END IS NULL ORDER BY DWELL_MINUTES DESC LIMIT 50`, { database: DWELL_DB, schema: DWELL_SCHEMA }),
    ]);
    setVehicles(v);
    setOpenDwells(d);
    setLoading(false);
  }, [query]);

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

  const basemap = useMemo(() => cartoBasemap(), []);

  const vehicleLayer = useMemo(() => {
    const valid = vehicles.filter((v: any) => v.LNG && v.LAT);
    if (!valid.length) return null;
    return new ScatterplotLayer({
      id: 'vehicle-positions',
      data: valid,
      getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)],
      getFillColor: (d: any) => STATE_COLORS[d.CURRENT_STATE] || [128, 128, 128, 200],
      getRadius: 100,
      radiusMinPixels: 4,
      radiusMaxPixels: 12,
      pickable: true,
    });
  }, [vehicles]);

  const layers = useMemo(() => [basemap, vehicleLayer].filter(Boolean), [basemap, vehicleLayer]);

  const getTooltip = useCallback(({ object }: any) => {
    if (!object || !object.DRIVER_ID) return null;
    return { html: `<b>${object.DRIVER_ID}</b><br/>State: ${object.CURRENT_STATE}<br/>Speed: ${object.CURRENT_SPEED_KMH || 0} km/h`, style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' } };
  }, []);

  return (
    <div className="page-full">
      <div className="page-sidebar-panel">
        <h2>Live Operations</h2>
        <p>{loading ? 'Refreshing...' : `${vehicles.length} vehicles tracked`} · Auto-refresh 30s</p>
        <button className="btn-primary" onClick={refresh} style={{ width: '100%', marginBottom: 12 }}>Refresh Now</button>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {Object.entries(STATE_COLORS).map(([state, color]) => (
            <div key={state} style={{ padding: '6px 10px', borderRadius: 8, background: 'rgba(0,0,0,0.02)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6, flex: '1 0 45%' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: `rgba(${color.slice(0, 3).join(',')},1)` }} />
              <div>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{state}</div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{stateCounts[state] || 0}</div>
              </div>
            </div>
          ))}
        </div>
        {openDwells.length > 0 && (
          <>
            <h3>Open Dwells</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><tr>{['Driver', 'Min', 'Left'].map(h => <th key={h} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontWeight: 500 }}>{h}</th>)}</tr></thead>
              <tbody>{openDwells.map((d: any, i: number) => (
                <tr key={i} style={{ borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                  <td style={{ padding: '6px 8px' }}>{d.DRIVER_ID}</td>
                  <td style={{ padding: '6px 8px' }}>{d.DWELL_DURATION_MIN}</td>
                  <td style={{ padding: '6px 8px', color: Number(d.TIME_REMAINING) < 0 ? '#E5484D' : '#0DB048', fontWeight: 600 }}>{d.TIME_REMAINING}</td>
                </tr>
              ))}</tbody>
            </table>
          </>
        )}
      </div>
      <div className="map-view">
        {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>Refreshing...</div>}
        <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} getTooltip={getTooltip} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  );
}
