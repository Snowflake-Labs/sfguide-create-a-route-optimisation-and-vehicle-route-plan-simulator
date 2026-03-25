import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer } from '@deck.gl/layers';
import { sfQuery, cartoBasemap } from './helpers';

export default function CatchmentPanel() {
  const [restaurants, setRestaurants] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [customers, setCustomers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewState, setViewState] = useState({ longitude: -122.43, latitude: 37.77, zoom: 11, pitch: 0, bearing: 0 });

  useEffect(() => {
    setLoading(true);
    sfQuery(`SELECT RESTAURANT_ID, RESTAURANT_NAME, ST_X(LOCATION) AS LNG, ST_Y(LOCATION) AS LAT, TOTAL_ORDERS, AVG_DELIVERY_TIME_MIN FROM RESTAURANTS_ENRICHED ORDER BY TOTAL_ORDERS DESC LIMIT 100`)
      .then(setRestaurants)
      .finally(() => setLoading(false));
  }, []);

  const loadCatchment = useCallback(async (id: string) => {
    setSelectedId(id);
    const c = await sfQuery(`SELECT ST_X(CUSTOMER_LOCATION) AS LNG, ST_Y(CUSTOMER_LOCATION) AS LAT, DELIVERY_TIME_MIN FROM DELIVERIES WHERE RESTAURANT_ID = '${id}' LIMIT 500`);
    setCustomers(c);
  }, []);

  const selected = useMemo(() => restaurants.find(r => r.RESTAURANT_ID === selectedId), [restaurants, selectedId]);

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
    <div>
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Catchment Analysis</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>Restaurant delivery catchment areas</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
        {[
          { label: 'Selected', value: selected?.RESTAURANT_NAME || '—' },
          { label: 'Orders', value: selected?.TOTAL_ORDERS ?? '—' },
          { label: 'Customers', value: customers.length || '—' },
        ].map(m => (
          <div key={m.label} style={{ padding: 16, borderRadius: 8, background: 'rgba(0,0,0,0.02)', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{m.label}</div>
            <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{m.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 300 }}>
          <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
            {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>Loading...</div>}
            <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} getTooltip={getTooltip} style={{ width: '100%', height: '100%' }} />
          </div>
        </div>
        <div style={{ flex: '0 0 260px', maxHeight: 560, overflowY: 'auto' }}>
          <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Restaurants</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr>{['Name', 'Orders'].map(h => <th key={h} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontWeight: 500 }}>{h}</th>)}</tr></thead>
            <tbody>{restaurants.map((r: any) => (
              <tr key={r.RESTAURANT_ID} onClick={() => loadCatchment(r.RESTAURANT_ID)} style={{ cursor: 'pointer', background: selectedId === r.RESTAURANT_ID ? 'rgba(41,181,232,0.1)' : undefined, borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                <td style={{ padding: '6px 8px', fontSize: 11 }}>{r.RESTAURANT_NAME}</td>
                <td style={{ padding: '6px 8px' }}>{r.TOTAL_ORDERS}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
