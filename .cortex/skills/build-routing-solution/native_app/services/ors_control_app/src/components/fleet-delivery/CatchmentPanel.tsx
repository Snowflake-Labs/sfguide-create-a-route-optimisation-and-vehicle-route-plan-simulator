import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer } from '@deck.gl/layers';
import MetricCard from '../../shared/MetricCard';
import { FD_DB, FD_SCHEMA, sfQuery, cartoBasemap } from './helpers';

export default function CatchmentPanel() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [customers, setCustomers] = useState<any[]>([]);
  const [restaurants, setRestaurants] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewState, setViewState] = useState({ longitude: -122.43, latitude: 37.77, zoom: 12, pitch: 0, bearing: 0 });

  useEffect(() => {
    setLoading(true);
    sfQuery(`SELECT RESTAURANT_ID, RESTAURANT_NAME, ST_X(LOCATION) AS LNG, ST_Y(LOCATION) AS LAT, TOTAL_ORDERS, AVG_DELIVERY_TIME_MIN FROM RESTAURANTS_ENRICHED ORDER BY TOTAL_ORDERS DESC LIMIT 100`)
      .then(r => { setRestaurants(r); setLoading(false); });
  }, []);

  const selected = useMemo(() => restaurants.find(r => r.RESTAURANT_ID === selectedId), [restaurants, selectedId]);

  const loadCatchment = useCallback(async (id: string) => {
    setSelectedId(id);
    const c = await sfQuery(`SELECT ST_X(CUSTOMER_LOCATION) AS LNG, ST_Y(CUSTOMER_LOCATION) AS LAT, DELIVERY_TIME_MIN FROM DELIVERIES WHERE RESTAURANT_ID = '${id}' LIMIT 500`);
    setCustomers(c);
  }, []);

  const basemap = useMemo(() => cartoBasemap(), []);

  const restaurantLayer = useMemo(() => {
    if (!restaurants.length) return null;
    return new ScatterplotLayer({
      id: 'restaurants',
      data: restaurants.filter((r: any) => r.LNG && r.LAT),
      getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)],
      getFillColor: (d: any) => d.RESTAURANT_ID === selectedId ? [41, 181, 232, 255] : [100, 100, 100, 180],
      getRadius: 80,
      radiusMinPixels: 5,
      pickable: true,
      updateTriggers: { getFillColor: [selectedId] },
    });
  }, [restaurants, selectedId]);

  const customerLayer = useMemo(() => {
    if (!customers.length) return null;
    return new ScatterplotLayer({
      id: 'customers',
      data: customers.filter((c: any) => c.LNG && c.LAT),
      getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)],
      getFillColor: [34, 197, 94, 150],
      getRadius: 40,
      radiusMinPixels: 3,
    });
  }, [customers]);

  const layers = useMemo(() => [basemap, customerLayer, restaurantLayer].filter(Boolean), [basemap, customerLayer, restaurantLayer]);

  const getTooltip = useCallback(({ object }: any) => {
    if (!object?.RESTAURANT_NAME) return null;
    return {
      html: `<b>${object.RESTAURANT_NAME}</b><br/>Orders: ${object.TOTAL_ORDERS}<br/>Avg: ${Number(object.AVG_DELIVERY_TIME_MIN).toFixed(1)} min`,
      style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' },
    };
  }, []);

  return (
    <div className="panel">
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Catchment Analysis</h2>
      <p className="subtitle">Restaurant delivery catchment areas</p>
      <div className="metric-grid">
        <MetricCard label="Selected" value={selected?.RESTAURANT_NAME || '—'} />
        <MetricCard label="Orders" value={selected?.TOTAL_ORDERS ?? '—'} />
        <MetricCard label="Customers" value={customers.length || '—'} />
      </div>
      <h3>Restaurants</h3>
      <div style={{ maxHeight: 180, overflowY: 'auto', marginBottom: 12 }}>
        <table className="sidebar-table">
          <thead><tr>{['Name', 'Orders'].map(h => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{restaurants.map((r: any) => (
            <tr key={r.RESTAURANT_ID} className={`clickable${selectedId === r.RESTAURANT_ID ? ' selected' : ''}`} onClick={() => loadCatchment(r.RESTAURANT_ID)}>
              <td>{r.RESTAURANT_NAME}</td>
              <td>{r.TOTAL_ORDERS}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
        {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>Loading...</div>}
        <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} getTooltip={getTooltip} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  );
}
