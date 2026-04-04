import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import MetricCard from '../../shared/MetricCard';
import { fmtDec } from '../../shared/format';
import { FD_DB, FD_SCHEMA, sfQuery, cartoBasemap } from './helpers';

export default function FleetMap() {
  const [selectedCourier, setSelectedCourier] = useState<string | null>(null);
  const [routeGeo, setRouteGeo] = useState<any[]>([]);
  const [kpis, setKpis] = useState<any>({});
  const [couriers, setCouriers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewState, setViewState] = useState({ longitude: -122.43, latitude: 37.77, zoom: 12, pitch: 0, bearing: 0 });

  useEffect(() => {
    setLoading(true);
    Promise.all([
      sfQuery(`SELECT COUNT(DISTINCT COURIER_ID) AS COURIERS, COUNT(DISTINCT DELIVERY_ID) AS DELIVERIES, ROUND(AVG(DELIVERY_TIME_MIN), 1) AS AVG_DELIVERY_MIN FROM DELIVERIES`),
      sfQuery(`SELECT COURIER_ID, COUNT(*) AS TRIPS, ROUND(AVG(DELIVERY_TIME_MIN), 1) AS AVG_MIN, MIN(ST_X(PICKUP_LOCATION)) AS LNG, MIN(ST_Y(PICKUP_LOCATION)) AS LAT FROM DELIVERIES GROUP BY COURIER_ID ORDER BY TRIPS DESC LIMIT 100`),
    ]).then(([k, c]) => {
      setKpis(k[0] || {});
      setCouriers(c);
      setLoading(false);
    });
  }, []);

  const loadRoutes = useCallback(async (courierId: string) => {
    setSelectedCourier(courierId);
    const routes = await sfQuery(`SELECT ST_X(PICKUP_LOCATION) AS P_LNG, ST_Y(PICKUP_LOCATION) AS P_LAT, ST_X(DROPOFF_LOCATION) AS D_LNG, ST_Y(DROPOFF_LOCATION) AS D_LAT, DELIVERY_TIME_MIN FROM DELIVERIES WHERE COURIER_ID = '${courierId}' LIMIT 50`);
    setRouteGeo(routes);
  }, []);

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
      html: `<b>${object.COURIER_ID}</b><br/>Trips: ${object.TRIPS}<br/>Avg: ${fmtDec(object.AVG_MIN)} min`,
      style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' },
    };
  }, []);

  return (
    <div className="panel">
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Fleet Map</h2>
      <p className="subtitle">Courier positions and delivery routes</p>
      <div className="metric-grid">
        <MetricCard label="Couriers" value={loading ? '...' : (kpis.COURIERS ?? '—')} />
        <MetricCard label="Deliveries" value={loading ? '...' : (kpis.DELIVERIES ?? '—')} />
        <MetricCard label="Avg Delivery" value={loading ? '...' : `${fmtDec(kpis.AVG_DELIVERY_MIN)} min`} />
      </div>
      <h3>Couriers</h3>
      <div style={{ maxHeight: 180, overflowY: 'auto', marginBottom: 12 }}>
        <table className="sidebar-table">
          <thead><tr>{['Courier', 'Trips', 'Avg'].map(h => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>
            {couriers.map((c: any) => (
              <tr key={c.COURIER_ID} className={`clickable${selectedCourier === c.COURIER_ID ? ' selected' : ''}`} onClick={() => loadRoutes(c.COURIER_ID)}>
                <td>{c.COURIER_ID}</td>
                <td>{c.TRIPS}</td>
                <td>{fmtDec(c.AVG_MIN)}m</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
        {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>Loading...</div>}
        <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} getTooltip={getTooltip} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  );
}
