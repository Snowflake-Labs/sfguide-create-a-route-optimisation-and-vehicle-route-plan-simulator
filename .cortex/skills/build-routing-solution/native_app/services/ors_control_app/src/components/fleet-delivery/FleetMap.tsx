import { useState, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import MetricCard from '../../shared/MetricCard';
import { useSfQuery } from '../../hooks/useSnowflake';
import { useSnowflake } from '../../hooks/useSnowflake';
import { FD_DB, FD_SCHEMA, cartoBasemap } from './helpers';
import { useRegion } from '../../hooks/useRegion';

export default function FleetMap() {
  const { regionName, center, zoom: regionZoom } = useRegion();
  const [selectedCourier, setSelectedCourier] = useState<string | null>(null);
  const [routeGeo, setRouteGeo] = useState<any[]>([]);
  const [viewState, setViewState] = useState({ longitude: center.lng, latitude: center.lat, zoom: regionZoom, pitch: 0, bearing: 0 });

  const { data: kpiRows, loading: kpiLoading } = useSfQuery(
    `SELECT COUNT(DISTINCT COURIER_ID) AS COURIERS, COUNT(DISTINCT DELIVERY_ID) AS DELIVERIES, ROUND(AVG(DELIVERY_TIME_MIN), 1) AS AVG_DELIVERY_MIN FROM DELIVERIES WHERE REGION = '${regionName}'`,
    FD_DB, FD_SCHEMA, [regionName],
  );
  const { data: couriers, loading: couriersLoading } = useSfQuery(
    `SELECT COURIER_ID, COUNT(*) AS TRIPS, ROUND(AVG(DELIVERY_TIME_MIN), 1) AS AVG_MIN, MIN(ST_X(PICKUP_LOCATION)) AS LNG, MIN(ST_Y(PICKUP_LOCATION)) AS LAT FROM DELIVERIES WHERE REGION = '${regionName}' GROUP BY COURIER_ID ORDER BY TRIPS DESC LIMIT 100`,
    FD_DB, FD_SCHEMA, [regionName],
  );

  const kpis = kpiRows[0] || {};
  const loading = kpiLoading || couriersLoading;
  const { query } = useSnowflake();

  const loadRoutes = useCallback(async (courierId: string) => {
    setSelectedCourier(courierId);
    const routes = await query(`SELECT ST_X(PICKUP_LOCATION) AS P_LNG, ST_Y(PICKUP_LOCATION) AS P_LAT, ST_X(DROPOFF_LOCATION) AS D_LNG, ST_Y(DROPOFF_LOCATION) AS D_LAT, DELIVERY_TIME_MIN FROM DELIVERIES WHERE COURIER_ID = '${courierId}' LIMIT 50`, { database: FD_DB, schema: FD_SCHEMA });
    setRouteGeo(routes);
  }, [query]);

  const basemap = useMemo(() => cartoBasemap(), []);

  const courierLayer = useMemo(() => {
    if (!couriers.length) return null;
    return new ScatterplotLayer({
      id: 'courier-pos',
      data: couriers.filter((c: any) => c.LNG && c.LAT),
      getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)],
      getFillColor: (d: any) => d.COURIER_ID === selectedCourier ? [41, 181, 232, 255] : [100, 100, 100, 180],
      getRadius: 80,
      radiusMinPixels: 4,
      radiusMaxPixels: 12,
      pickable: true,
      updateTriggers: { getFillColor: [selectedCourier] },
    });
  }, [couriers, selectedCourier]);

  const routeLayer = useMemo(() => {
    if (!routeGeo.length) return null;
    return new PathLayer({
      id: 'delivery-routes',
      data: routeGeo.map((r: any) => ({ path: [[Number(r.P_LNG), Number(r.P_LAT)], [Number(r.D_LNG), Number(r.D_LAT)]] })),
      getPath: (d: any) => d.path,
      getColor: [41, 181, 232, 150],
      getWidth: 2,
      widthMinPixels: 1,
    });
  }, [routeGeo]);

  const layers = useMemo(() => [basemap, routeLayer, courierLayer].filter(Boolean), [basemap, routeLayer, courierLayer]);

  const getTooltip = useCallback(({ object }: any) => {
    if (!object?.COURIER_ID) return null;
    return {
      html: `<b>${object.COURIER_ID}</b><br/>Trips: ${object.TRIPS}<br/>Avg: ${object.AVG_MIN} min`,
      style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' },
    };
  }, []);

  return (
    <div className="page-full">
      <div className="page-sidebar-panel">
        <h2>Fleet Map</h2>
        <p>Courier positions and delivery routes</p>
        <div className="metric-grid-vertical">
          <MetricCard label="Couriers" value={loading ? '...' : (kpis.COURIERS ?? '—')} />
          <MetricCard label="Deliveries" value={loading ? '...' : (kpis.DELIVERIES ?? '—')} />
          <MetricCard label="Avg Delivery" value={loading ? '...' : `${kpis.AVG_DELIVERY_MIN ?? '—'} min`} />
        </div>
        <h3>Couriers</h3>
        <table className="sidebar-table">
          <thead><tr>{['Courier', 'Trips', 'Avg'].map(h => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>
            {couriers.map((c: any) => (
              <tr key={c.COURIER_ID} className={`clickable${selectedCourier === c.COURIER_ID ? ' selected' : ''}`} onClick={() => loadRoutes(c.COURIER_ID)}>
                <td>{c.COURIER_ID}</td>
                <td>{c.TRIPS}</td>
                <td>{c.AVG_MIN}m</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="map-view">
        {loading && <div className="map-loading-overlay">Loading...</div>}
        <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} getTooltip={getTooltip} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  );
}
