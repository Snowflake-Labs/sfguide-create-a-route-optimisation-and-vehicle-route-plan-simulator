import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { sfQuery, cartoBasemap } from './helpers';

export default function TripInspector() {
  const [trips, setTrips] = useState<any[]>([]);
  const [selectedTrip, setSelectedTrip] = useState<string | null>(null);
  const [tripPoints, setTripPoints] = useState<any[]>([]);
  const [dwellPoints, setDwellPoints] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewState, setViewState] = useState({ longitude: -122.43, latitude: 37.77, zoom: 10, pitch: 0, bearing: 0 });

  useEffect(() => {
    setLoading(true);
    sfQuery(`SELECT TRIP_ID, DRIVER_ID, START_TIME, END_TIME, ROUND(TOTAL_DISTANCE_KM, 1) AS DISTANCE_KM, DWELL_COUNT, ROUND(TOTAL_DWELL_MIN, 1) AS TOTAL_DWELL_MIN FROM DT_DWELL_ENRICHED ORDER BY START_TIME DESC LIMIT 100`)
      .then(setTrips)
      .finally(() => setLoading(false));
  }, []);

  const loadTrip = useCallback(async (tripId: string) => {
    setSelectedTrip(tripId);
    const [points, dwells] = await Promise.all([
      sfQuery(`SELECT ST_X(GEOMETRY) AS LNG, ST_Y(GEOMETRY) AS LAT, EVENT_TIMESTAMP, SPEED_KMH FROM DT_STATE_CHANGES WHERE TRIP_ID = '${tripId}' ORDER BY EVENT_TIMESTAMP`),
      sfQuery(`SELECT ST_X(DWELL_LOCATION) AS LNG, ST_Y(DWELL_LOCATION) AS LAT, FACILITY_NAME, ROUND(DWELL_DURATION_MIN, 1) AS DWELL_MIN, SLA_STATUS FROM DT_DWELL_ENRICHED WHERE TRIP_ID = '${tripId}'`),
    ]);
    setTripPoints(points);
    setDwellPoints(dwells);
    if (points.length > 0) {
      const lngs = points.map((p: any) => Number(p.LNG));
      const lats = points.map((p: any) => Number(p.LAT));
      setViewState(prev => ({
        ...prev,
        longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2,
        latitude: (Math.min(...lats) + Math.max(...lats)) / 2,
        zoom: 11,
      }));
    }
  }, []);

  const basemap = useMemo(() => cartoBasemap(), []);

  const dataLayers = useMemo(() => {
    const result: any[] = [];
    if (tripPoints.length > 1) {
      const path = tripPoints.map((p: any) => [Number(p.LNG), Number(p.LAT)]);
      result.push(new PathLayer({
        id: 'trip-path',
        data: [{ path }],
        getPath: (d: any) => d.path,
        getColor: [41, 181, 232, 200],
        getWidth: 3,
        widthMinPixels: 2,
      }));
    }
    if (dwellPoints.length) {
      result.push(new ScatterplotLayer({
        id: 'dwell-points',
        data: dwellPoints,
        getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)],
        getFillColor: (d: any) => d.SLA_STATUS === 'OK' ? [34, 197, 94, 220] : [239, 68, 68, 220],
        getRadius: 80,
        radiusMinPixels: 6,
        pickable: true,
      }));
    }
    return result;
  }, [tripPoints, dwellPoints]);

  const layers = useMemo(() => [basemap, ...dataLayers].filter(Boolean), [basemap, dataLayers]);

  const getTooltip = useCallback(({ object }: any) => {
    if (!object) return null;
    if (object.FACILITY_NAME !== undefined) {
      return {
        html: `<b>${object.FACILITY_NAME || 'Unknown'}</b><br/>Dwell: ${object.DWELL_MIN} min<br/>SLA: ${object.SLA_STATUS}`,
        style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' },
      };
    }
    return null;
  }, []);

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ fontSize: 20, margin: 0 }}>Trip Inspector</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0 }}>
            {loading ? 'Loading trips...' : `${trips.length} recent trips`}
            {selectedTrip && ` · Selected: ${String(selectedTrip).slice(-12)}`}
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '0 0 280px', maxHeight: 560, overflowY: 'auto' }}>
          {selectedTrip && dwellPoints.length > 0 && (
            <div style={{ marginBottom: 12, padding: 10, borderRadius: 6, background: 'rgba(41,181,232,0.06)', border: '1px solid rgba(41,181,232,0.15)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Dwell Stops ({dwellPoints.length})</div>
              {dwellPoints.map((d: any, i: number) => (
                <div key={i} style={{ fontSize: 12, marginBottom: 2 }}>
                  <strong>{d.FACILITY_NAME || 'Unknown'}</strong>: {d.DWELL_MIN} min
                  <span style={{ color: d.SLA_STATUS === 'OK' ? '#0DB048' : '#E5484D', marginLeft: 6, fontWeight: 600 }}>{d.SLA_STATUS}</span>
                </div>
              ))}
            </div>
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                {['Trip', 'Driver', 'Dwells'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontWeight: 500 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trips.map((t: any) => (
                <tr key={t.TRIP_ID} onClick={() => loadTrip(t.TRIP_ID)} style={{ cursor: 'pointer', background: selectedTrip === t.TRIP_ID ? 'rgba(41,181,232,0.1)' : undefined }}>
                  <td style={{ padding: '6px 8px', fontSize: 11, fontFamily: 'monospace' }}>{String(t.TRIP_ID).slice(-12)}</td>
                  <td style={{ padding: '6px 8px' }}>{t.DRIVER_ID}</td>
                  <td style={{ padding: '6px 8px' }}>{t.DWELL_COUNT}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ flex: 1, minWidth: 300 }}>
          <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
            <DeckGL
              viewState={viewState}
              onViewStateChange={({ viewState: vs }: any) => setViewState(vs)}
              controller={true}
              layers={layers}
              getTooltip={getTooltip}
              style={{ width: '100%', height: '100%' }}
            />
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 11, color: 'var(--text-secondary)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgb(34,197,94)' }} /> SLA OK
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgb(239,68,68)' }} /> Breach
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
