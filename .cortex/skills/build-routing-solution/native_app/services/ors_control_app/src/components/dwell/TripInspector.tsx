import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { sfQuery, cartoBasemap } from './helpers';
import { fmtDec } from '../../shared/format';

export default function TripInspector() {
  const [trips, setTrips] = useState<any[]>([]);
  const [tripsLoading, setTripsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTrip, setSelectedTrip] = useState<string | null>(null);
  const [tripPoints, setTripPoints] = useState<any[]>([]);
  const [dwellPoints, setDwellPoints] = useState<any[]>([]);
  const [viewState, setViewState] = useState({ longitude: -122.43, latitude: 37.77, zoom: 11, pitch: 0, bearing: 0 });

  useEffect(() => {
    setTripsLoading(true);
    setError(null);
    sfQuery(
      `SELECT TRIP_ID, VEHICLE_ID AS DRIVER_ID, MIN(SESSION_START) AS START_TIME, MAX(SESSION_END) AS END_TIME, COUNT(*) AS DWELL_COUNT, ROUND(SUM(DWELL_MINUTES), 1) AS TOTAL_DWELL_MIN FROM DT_DWELL_ENRICHED WHERE STATUS LIKE 'DWELL%' GROUP BY TRIP_ID, VEHICLE_ID ORDER BY START_TIME DESC LIMIT 50`
    ).then(rows => {
      setTrips(rows);
      setTripsLoading(false);
      if (rows.length === 0) setError('No trip data found. Check that the dwell analysis pipeline has been deployed.');
    }).catch(() => {
      setTripsLoading(false);
      setError('Failed to load trips. Check that the API is reachable.');
    });
  }, []);

  const loadTrip = useCallback(async (tripId: string) => {
    setSelectedTrip(tripId);
    const [points, dwells] = await Promise.all([
      sfQuery(`SELECT LONGITUDE AS LNG, LATITUDE AS LAT, TS AS EVENT_TIMESTAMP, SPEED_KMH FROM DT_STATE_CHANGES WHERE TRIP_ID = '${tripId}' ORDER BY TS`),
      sfQuery(`SELECT AVG_LNG AS LNG, AVG_LAT AS LAT, LOCATION_NAME AS FACILITY_NAME, ROUND(DWELL_MINUTES, 1) AS DWELL_MIN, CASE WHEN DWELL_MINUTES > 30 THEN 'BREACH' ELSE 'OK' END AS SLA_STATUS FROM DT_DWELL_ENRICHED WHERE TRIP_ID = '${tripId}'`),
    ]);
    setTripPoints(points);
    setDwellPoints(dwells);
    if (points.length > 0) {
      const lngs = points.map((p: any) => Number(p.LNG));
      const lats = points.map((p: any) => Number(p.LAT));
      setViewState(prev => ({ ...prev, longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2, latitude: (Math.min(...lats) + Math.max(...lats)) / 2, zoom: 13 }));
    }
  }, []);

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
      return {
        html: `<b>${object.FACILITY_NAME || 'Unknown'}</b><br/>Dwell: ${fmtDec(object.DWELL_MIN)} min<br/>SLA: ${object.SLA_STATUS}`,
        style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' },
      };
    }
    return null;
  }, []);

  return (
    <div>
      <h3>Trip Inspector</h3>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
        {tripsLoading ? 'Loading trips...' : `${trips.length} recent trips`}
        {selectedTrip && ` · Selected: ${String(selectedTrip).slice(0, 8)}...`}
      </p>

      {error && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 13, color: '#E5484D' }}>
          {error}
        </div>
      )}

      {selectedTrip && dwellPoints.length > 0 && (
        <div style={{ background: 'var(--surface-alt, rgba(41,181,232,0.05))', borderRadius: 8, padding: 12, marginBottom: 12, border: '1px solid var(--border)' }}>
          <h4 style={{ fontSize: 14, marginBottom: 6 }}>Dwell Stops ({dwellPoints.length})</h4>
          {dwellPoints.map((d: any, i: number) => (
            <div key={i} style={{ fontSize: 12, marginBottom: 2 }}>
              <strong>{d.FACILITY_NAME || 'Unknown'}</strong>: {fmtDec(d.DWELL_MIN)} min
              <span style={{ color: d.SLA_STATUS === 'OK' ? '#0DB048' : '#E5484D', marginLeft: 6, fontWeight: 600 }}>{d.SLA_STATUS}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
        <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} getTooltip={getTooltip} style={{ width: '100%', height: '100%' }} />
        <div style={{ position: 'absolute', bottom: 12, left: 12, display: 'flex', gap: 12, fontSize: 12, background: 'rgba(0,0,0,0.6)', padding: '6px 12px', borderRadius: 6, color: '#fff' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: 'rgb(34,197,94)', display: 'inline-block' }} /> SLA OK</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: 'rgb(239,68,68)', display: 'inline-block' }} /> Breach</span>
        </div>
      </div>

      <div style={{ marginTop: 12, overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {['Trip', 'Driver', 'Dwells', 'Dwell Min'].map(h => (
                <th key={h} style={{ padding: '6px 8px', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: 500 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {trips.map((t: any) => (
              <tr
                key={t.TRIP_ID}
                onClick={() => loadTrip(t.TRIP_ID)}
                style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer', background: selectedTrip === t.TRIP_ID ? 'rgba(41,181,232,0.1)' : 'transparent' }}
              >
                <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: 11 }}>{String(t.TRIP_ID).slice(0, 8)}</td>
                <td style={{ padding: '6px 8px' }}>{t.DRIVER_ID}</td>
                <td style={{ padding: '6px 8px' }}>{t.DWELL_COUNT}</td>
                <td style={{ padding: '6px 8px' }}>{fmtDec(t.TOTAL_DWELL_MIN)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
