import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer } from '@deck.gl/layers';
import { sfQuery, cartoBasemap } from './helpers';

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
  const [viewState, setViewState] = useState({ longitude: -122.43, latitude: 37.77, zoom: 10, pitch: 0, bearing: 0 });

  const refresh = useCallback(async () => {
    setLoading(true);
    const [v, d] = await Promise.all([
      sfQuery(`SELECT DRIVER_ID, CURRENT_STATE, ST_X(LAST_POSITION) AS LNG, ST_Y(LAST_POSITION) AS LAT, LAST_UPDATE, CURRENT_SPEED_KMH FROM DT_STATE_CHANGES QUALIFY ROW_NUMBER() OVER (PARTITION BY DRIVER_ID ORDER BY EVENT_TIMESTAMP DESC) = 1 LIMIT 500`),
      sfQuery(`SELECT DRIVER_ID, FACILITY_NAME, DWELL_START, DWELL_DURATION_MIN, SLA_THRESHOLD_MIN, ROUND(SLA_THRESHOLD_MIN - DWELL_DURATION_MIN, 1) AS TIME_REMAINING FROM DT_DWELL_ENRICHED WHERE DWELL_END IS NULL ORDER BY DWELL_DURATION_MIN DESC LIMIT 50`),
    ]);
    setVehicles(v);
    setOpenDwells(d);
    setLoading(false);
  }, []);

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
    return {
      html: `<b>${object.DRIVER_ID}</b><br/>State: ${object.CURRENT_STATE}<br/>Speed: ${object.CURRENT_SPEED_KMH || 0} km/h`,
      style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' },
    };
  }, []);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: 20, margin: 0 }}>Live Operations</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0 }}>
            {loading ? 'Refreshing...' : `${vehicles.length} vehicles tracked`} · Auto-refresh 30s
          </p>
        </div>
        <button className="btn-primary" onClick={refresh} style={{ marginLeft: 'auto' }}>Refresh Now</button>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        {Object.entries(STATE_COLORS).map(([state, color]) => (
          <div key={state} style={{ padding: '8px 16px', borderRadius: 8, background: 'rgba(0,0,0,0.02)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: `rgba(${color.slice(0, 3).join(',')},1)` }} />
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{state}</div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{stateCounts[state] || 0}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 300 }}>
          <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
            {loading && (
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>
                Refreshing...
              </div>
            )}
            <DeckGL
              viewState={viewState}
              onViewStateChange={({ viewState: vs }: any) => setViewState(vs)}
              controller={true}
              layers={layers}
              getTooltip={getTooltip}
              style={{ width: '100%', height: '100%' }}
            />
          </div>
        </div>

        {openDwells.length > 0 && (
          <div style={{ flex: '0 0 280px', maxHeight: 560, overflowY: 'auto' }}>
            <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Open Dwells</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  {['Driver', 'Min', 'Left'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {openDwells.map((d: any, i: number) => (
                  <tr key={i} style={{ borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                    <td style={{ padding: '6px 8px' }}>{d.DRIVER_ID}</td>
                    <td style={{ padding: '6px 8px' }}>{d.DWELL_DURATION_MIN}</td>
                    <td style={{ padding: '6px 8px', color: Number(d.TIME_REMAINING) < 0 ? '#E5484D' : '#0DB048', fontWeight: 600 }}>{d.TIME_REMAINING}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
