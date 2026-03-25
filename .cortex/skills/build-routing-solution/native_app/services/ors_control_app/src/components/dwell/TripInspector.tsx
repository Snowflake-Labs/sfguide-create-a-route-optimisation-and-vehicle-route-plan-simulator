import { useState, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { useSfQuery, useSnowflake } from '../../hooks/useSnowflake';
import { DWELL_DB, DWELL_SCHEMA, cartoBasemap } from './helpers';
import { useRegion } from '../../hooks/useRegion';

export default function TripInspector() {
  const { center, zoom: regionZoom } = useRegion();
  const [selectedTrip, setSelectedTrip] = useState<string | null>(null);
  const [tripPoints, setTripPoints] = useState<any[]>([]);
  const [dwellPoints, setDwellPoints] = useState<any[]>([]);
  const [viewState, setViewState] = useState({ longitude: center.lng, latitude: center.lat, zoom: regionZoom, pitch: 0, bearing: 0 });

  const { data: trips, loading } = useSfQuery(
    `SELECT SESSION_ID AS TRIP_ID, TRUCK_ID AS DRIVER_ID, SESSION_START AS START_TIME, SESSION_END AS END_TIME, NULL AS DISTANCE_KM, 1 AS DWELL_COUNT, ROUND(DWELL_MINUTES, 1) AS TOTAL_DWELL_MIN FROM DT_DWELL_ENRICHED ORDER BY SESSION_START DESC LIMIT 100`,
    DWELL_DB, DWELL_SCHEMA,
  );

  const { query } = useSnowflake();

  const loadTrip = useCallback(async (tripId: string) => {
    setSelectedTrip(tripId);
    const [points, dwells] = await Promise.all([
      query(`SELECT LONGITUDE AS LNG, LATITUDE AS LAT, TS AS EVENT_TIMESTAMP, SPEED_KMH FROM DT_STATE_CHANGES WHERE TRUCK_ID = '${tripId}' ORDER BY TS LIMIT 2000`, { database: DWELL_DB, schema: DWELL_SCHEMA }),
      query(`SELECT AVG_LNG AS LNG, AVG_LAT AS LAT, LOCATION_NAME AS FACILITY_NAME, ROUND(DWELL_MINUTES, 1) AS DWELL_MIN, CASE WHEN DWELL_MINUTES > 30 THEN 'BREACH' ELSE 'OK' END AS SLA_STATUS FROM DT_DWELL_ENRICHED WHERE TRUCK_ID = '${tripId}'`, { database: DWELL_DB, schema: DWELL_SCHEMA }),
    ]);
    setTripPoints(points);
    setDwellPoints(dwells);
    if (points.length > 0) {
      const lngs = points.map((p: any) => Number(p.LNG));
      const lats = points.map((p: any) => Number(p.LAT));
      setViewState(prev => ({ ...prev, longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2, latitude: (Math.min(...lats) + Math.max(...lats)) / 2, zoom: 11 }));
    }
  }, [query]);

  const basemap = useMemo(() => cartoBasemap(), []);

  const dataLayers = useMemo(() => {
    const result: any[] = [];
    if (tripPoints.length > 1) {
      const path = tripPoints.map((p: any) => [Number(p.LNG), Number(p.LAT)]);
      result.push(new PathLayer({ id: 'trip-path', data: [{ path }], getPath: (d: any) => d.path, getColor: [41, 181, 232, 200], getWidth: 3, widthMinPixels: 2 }));
    }
    if (dwellPoints.length) {
      result.push(new ScatterplotLayer({ id: 'dwell-points', data: dwellPoints, getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)], getFillColor: (d: any) => d.SLA_STATUS === 'OK' ? [34, 197, 94, 220] : [239, 68, 68, 220], getRadius: 80, radiusMinPixels: 6, pickable: true }));
    }
    return result;
  }, [tripPoints, dwellPoints]);

  const layers = useMemo(() => [basemap, ...dataLayers].filter(Boolean), [basemap, dataLayers]);

  const getTooltip = useCallback(({ object }: any) => {
    if (!object) return null;
    if (object.FACILITY_NAME !== undefined) {
      return { html: `<b>${object.FACILITY_NAME || 'Unknown'}</b><br/>Dwell: ${object.DWELL_MIN} min<br/>SLA: ${object.SLA_STATUS}`, style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' } };
    }
    return null;
  }, []);

  return (
    <div className="page-full">
      <div className="page-sidebar-panel">
        <h2>Trip Inspector</h2>
        <p>{loading ? 'Loading trips...' : `${trips.length} recent trips`}{selectedTrip && ` · Selected: ${String(selectedTrip).slice(-12)}`}</p>
        {selectedTrip && dwellPoints.length > 0 && (
          <div className="info-box">
            <h4>Dwell Stops ({dwellPoints.length})</h4>
            {dwellPoints.map((d: any, i: number) => (
              <div key={i} style={{ fontSize: 12, marginBottom: 2 }}>
                <strong>{d.FACILITY_NAME || 'Unknown'}</strong>: {d.DWELL_MIN} min
                <span style={{ color: d.SLA_STATUS === 'OK' ? 'var(--green)' : 'var(--red)', marginLeft: 6, fontWeight: 600 }}>{d.SLA_STATUS}</span>
              </div>
            ))}
          </div>
        )}
        <table className="sidebar-table">
          <thead><tr>{['Trip', 'Driver', 'Dwells'].map(h => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{trips.map((t: any) => (
            <tr key={t.TRIP_ID} className={`clickable${selectedTrip === t.DRIVER_ID ? ' selected' : ''}`} onClick={() => loadTrip(t.DRIVER_ID)}>
              <td className="mono">{String(t.TRIP_ID).slice(-12)}</td>
              <td>{t.DRIVER_ID}</td>
              <td>{t.DWELL_COUNT}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="map-view">
        <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} getTooltip={getTooltip} style={{ width: '100%', height: '100%' }} />
        <div className="map-legend">
          <div className="map-legend-item"><div className="map-legend-dot" style={{ background: 'rgb(34,197,94)' }} /> SLA OK</div>
          <div className="map-legend-item"><div className="map-legend-dot" style={{ background: 'rgb(239,68,68)' }} /> Breach</div>
        </div>
      </div>
    </div>
  );
}
