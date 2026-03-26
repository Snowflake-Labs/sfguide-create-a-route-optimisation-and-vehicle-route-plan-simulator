import { useMemo, useState } from 'react';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import MapView from '../../shared/MapView';
import MetricCard from '../../shared/MetricCard';
import { useSfQuery, useSnowflake } from '../../hooks/useSnowflake';
import { useRegion } from '../../hooks/useRegion';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

export default function FleetMap({ sourceDb, sourceSchema }: Props) {
  const { regionName, center, zoom } = useRegion();
  const [selectedRoute, setSelectedRoute] = useState<any>(null);
  const [routeGeo, setRouteGeo] = useState<any>(null);
  const { query } = useSnowflake();

  const { data: summary } = useSfQuery(
    `SELECT COUNT(DISTINCT COURIER_ID) AS COURIERS, COUNT(DISTINCT DELIVERY_ID) AS DELIVERIES,
            ROUND(AVG(DELIVERY_TIME_MIN), 1) AS AVG_DELIVERY_MIN
     FROM DELIVERIES WHERE REGION = '${regionName}'`, sourceDb, sourceSchema, [regionName]);

  const { data: couriers, loading } = useSfQuery(
    `SELECT COURIER_ID, COUNT(*) AS TRIPS, ROUND(AVG(DELIVERY_TIME_MIN), 1) AS AVG_MIN,
            MIN(ST_X(PICKUP_LOCATION)) AS LNG, MIN(ST_Y(PICKUP_LOCATION)) AS LAT
     FROM DELIVERIES WHERE REGION = '${regionName}' GROUP BY COURIER_ID ORDER BY TRIPS DESC LIMIT 100`, sourceDb, sourceSchema, [regionName]);

  const loadRoute = async (courierId: string) => {
    setSelectedRoute(courierId);
    const r = await query(
      `SELECT ST_X(PICKUP_LOCATION) AS P_LNG, ST_Y(PICKUP_LOCATION) AS P_LAT,
              ST_X(DROPOFF_LOCATION) AS D_LNG, ST_Y(DROPOFF_LOCATION) AS D_LAT,
              DELIVERY_TIME_MIN
       FROM DELIVERIES WHERE COURIER_ID = '${courierId}' LIMIT 50`,
      { database: sourceDb, schema: sourceSchema });
    setRouteGeo(r);
  };

  const layers = useMemo(() => {
    const l: any[] = [];
    if (couriers.length) {
      l.push(new ScatterplotLayer({
        id: 'courier-pos', data: couriers,
        getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)],
        getFillColor: (d: any) => d.COURIER_ID === selectedRoute ? [255, 107, 53, 255] : [41, 181, 232, 180],
        getRadius: 80, radiusMinPixels: 4, pickable: true,
        onClick: ({ object }: any) => object && loadRoute(object.COURIER_ID),
      }));
    }
    if (routeGeo?.length) {
      l.push(new PathLayer({
        id: 'delivery-routes',
        data: routeGeo.map((r: any) => ({
          path: [[Number(r.P_LNG), Number(r.P_LAT)], [Number(r.D_LNG), Number(r.D_LAT)]],
        })),
        getPath: (d: any) => d.path, getColor: [255, 107, 53, 160], getWidth: 2, widthMinPixels: 1,
      }));
    }
    return l;
  }, [couriers, routeGeo, selectedRoute]);

  const s = summary[0] || {};

  return (
    <div className="page-full">
      <div className="page-sidebar-panel">
        <h2>Delivery Fleet Map</h2>
        <div className="metric-grid-vertical">
          <MetricCard label="Couriers" value={s.COURIERS || '...'} />
          <MetricCard label="Deliveries" value={s.DELIVERIES || '...'} />
          <MetricCard label="Avg Delivery" value={s.AVG_DELIVERY_MIN ? `${s.AVG_DELIVERY_MIN} min` : '...'} />
        </div>
        {selectedRoute && <p style={{ fontSize: 12, color: '#29B5E8', marginBottom: 8 }}>Showing routes for {selectedRoute}</p>}
        <h3 style={{ fontSize: 13, marginBottom: 8 }}>Top Couriers</h3>
        <div className="data-table-container" style={{ maxHeight: 350 }}>
          <table className="data-table">
            <thead><tr><th className="data-table-th">Courier</th><th className="data-table-th">Trips</th><th className="data-table-th">Avg Min</th></tr></thead>
            <tbody>{couriers.map((c: any) => (
              <tr key={c.COURIER_ID} onClick={() => loadRoute(c.COURIER_ID)} style={{ cursor: 'pointer', background: selectedRoute === c.COURIER_ID ? 'rgba(41,181,232,0.1)' : undefined }}>
                <td style={{ fontSize: 11 }}>{String(c.COURIER_ID).slice(-8)}</td><td>{c.TRIPS}</td><td>{c.AVG_MIN}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
      <MapView layers={layers} initialViewState={{ longitude: center.lng, latitude: center.lat, zoom }} />
    </div>
  );
}
