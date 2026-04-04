import { useState, useMemo } from 'react';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import MapView from '../../shared/MapView';
import DataTable from '../../shared/DataTable';
import { fmtDec } from '../../shared/format';
import { useSfQuery, useSnowflake } from '../../hooks/useSnowflake';
import { useRegion } from '../../hooks/useRegion';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

export default function TripInspector({ sourceDb, sourceSchema }: Props) {
  const { regionName, center, zoom } = useRegion();

  const [selectedTrip, setSelectedTrip] = useState<string | null>(null);
  const [tripPoints, setTripPoints] = useState<any[]>([]);
  const [dwellPoints, setDwellPoints] = useState<any[]>([]);
  const { query } = useSnowflake();

  const { data: trips, loading } = useSfQuery(
    `SELECT TRIP_ID, DRIVER_ID, START_TIME, END_TIME,
            ROUND(TOTAL_DISTANCE_KM, 1) AS DISTANCE_KM,
            DWELL_COUNT, ROUND(TOTAL_DWELL_MIN, 1) AS TOTAL_DWELL_MIN
     FROM DT_DWELL_ENRICHED WHERE REGION = '${regionName}'
     ORDER BY START_TIME DESC LIMIT 100`,
    sourceDb, sourceSchema, [regionName],
  );

  const loadTrip = async (tripId: string) => {
    setSelectedTrip(tripId);
    const points = await query(
      `SELECT ST_X(GEOMETRY) AS LNG, ST_Y(GEOMETRY) AS LAT, EVENT_TIMESTAMP, SPEED_KMH
       FROM DT_STATE_CHANGES WHERE TRIP_ID = '${tripId}' AND REGION = '${regionName}' ORDER BY EVENT_TIMESTAMP`,
      { database: sourceDb, schema: sourceSchema },
    );
    setTripPoints(points);
    const dwells = await query(
      `SELECT ST_X(DWELL_LOCATION) AS LNG, ST_Y(DWELL_LOCATION) AS LAT,
              FACILITY_NAME, ROUND(DWELL_DURATION_MIN, 1) AS DWELL_MIN, SLA_STATUS
       FROM DT_DWELL_ENRICHED WHERE TRIP_ID = '${tripId}' AND REGION = '${regionName}'`,
      { database: sourceDb, schema: sourceSchema },
    );
    setDwellPoints(dwells);
  };

  const layers = useMemo(() => {
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

  const viewState = useMemo(() => {
    if (tripPoints.length) {
      const lngs = tripPoints.map((p: any) => Number(p.LNG));
      const lats = tripPoints.map((p: any) => Number(p.LAT));
      return {
        longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2,
        latitude: (Math.min(...lats) + Math.max(...lats)) / 2,
        zoom: 10,
      };
    }
    return { longitude: center.lng, latitude: center.lat, zoom };
  }, [tripPoints]);

  return (
    <div className="page-full">
      <div className="page-sidebar-panel">
        <h2>Trip Inspector</h2>
        <p>{loading ? 'Loading trips...' : `${trips.length} recent trips`}</p>
        {selectedTrip && dwellPoints.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <h4 style={{ fontSize: 13, marginBottom: 6 }}>Dwell Stops ({dwellPoints.length})</h4>
            {dwellPoints.map((d: any, i: number) => (
              <div key={i} className="placeholder-note" style={{ marginBottom: 4 }}>
                <strong>{d.FACILITY_NAME || 'Unknown'}</strong>: {fmtDec(d.DWELL_MIN)} min
                <span style={{ color: d.SLA_STATUS === 'OK' ? '#0DB048' : '#E5484D', marginLeft: 6 }}>{d.SLA_STATUS}</span>
              </div>
            ))}
          </div>
        )}
        <div className="data-table-container" style={{ maxHeight: 400 }}>
          <table className="data-table">
            <thead><tr>
              <th className="data-table-th">Trip</th>
              <th className="data-table-th">Driver</th>
              <th className="data-table-th">Dwells</th>
            </tr></thead>
            <tbody>
              {trips.map((t: any) => (
                <tr key={t.TRIP_ID} onClick={() => loadTrip(t.TRIP_ID)}
                    style={{ cursor: 'pointer', background: selectedTrip === t.TRIP_ID ? 'rgba(41,181,232,0.1)' : undefined }}>
                  <td style={{ fontSize: 11 }}>{String(t.TRIP_ID).slice(-12)}</td>
                  <td>{t.DRIVER_ID}</td>
                  <td>{t.DWELL_COUNT}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <MapView layers={layers} initialViewState={viewState} />
    </div>
  );
}
