import { useMemo, useState } from 'react';
import { ScatterplotLayer, PolygonLayer } from '@deck.gl/layers';
import MapView from '../../shared/MapView';
import MetricCard from '../../shared/MetricCard';
import { useSfQuery, useSnowflake } from '../../hooks/useSnowflake';
import { useRegion } from '../../hooks/useRegion';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

export default function CatchmentPanel({ sourceDb, sourceSchema }: Props) {
  const { regionName, center, zoom } = useRegion();
  const [selectedRestaurant, setSelectedRestaurant] = useState<string | null>(null);
  const [catchmentGeo, setCatchmentGeo] = useState<any[]>([]);
  const { query } = useSnowflake();

  const { data: restaurants, loading } = useSfQuery(
    `SELECT RESTAURANT_ID, RESTAURANT_NAME, ST_X(LOCATION) AS LNG, ST_Y(LOCATION) AS LAT,
            TOTAL_ORDERS, AVG_DELIVERY_TIME_MIN
     FROM RESTAURANTS WHERE REGION = '${regionName}' ORDER BY TOTAL_ORDERS DESC LIMIT 100`, sourceDb, sourceSchema, [regionName]);

  const loadCatchment = async (id: string) => {
    setSelectedRestaurant(id);
    const geo = await query(
      `SELECT ST_X(CUSTOMER_LOCATION) AS LNG, ST_Y(CUSTOMER_LOCATION) AS LAT, DELIVERY_TIME_MIN
       FROM DELIVERIES WHERE RESTAURANT_ID = '${id}' LIMIT 500`,
      { database: sourceDb, schema: sourceSchema });
    setCatchmentGeo(geo);
  };

  const layers = useMemo(() => {
    const l: any[] = [];
    if (restaurants.length) {
      l.push(new ScatterplotLayer({
        id: 'restaurants', data: restaurants, pickable: true,
        getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)],
        getFillColor: (d: any) => d.RESTAURANT_ID === selectedRestaurant ? [255, 107, 53, 255] : [41, 181, 232, 200],
        getRadius: 60, radiusMinPixels: 5,
        onClick: ({ object }: any) => object && loadCatchment(object.RESTAURANT_ID),
      }));
    }
    if (catchmentGeo.length) {
      l.push(new ScatterplotLayer({
        id: 'customers', data: catchmentGeo,
        getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)],
        getFillColor: [34, 197, 94, 120], getRadius: 30, radiusMinPixels: 3,
      }));
    }
    return l;
  }, [restaurants, catchmentGeo, selectedRestaurant]);

  const s = restaurants.find((r: any) => r.RESTAURANT_ID === selectedRestaurant);

  return (
    <div className="page-full">
      <div className="page-sidebar-panel">
        <h2>Catchment Analysis</h2>
        <p>{loading ? 'Loading...' : `${restaurants.length} restaurants`}</p>
        {s && (
          <div className="metric-grid-vertical" style={{ marginBottom: 12 }}>
            <MetricCard label="Selected" value={s.RESTAURANT_NAME || s.RESTAURANT_ID} />
            <MetricCard label="Orders" value={s.TOTAL_ORDERS} />
            <MetricCard label="Customers" value={catchmentGeo.length} subtitle="in catchment" />
          </div>
        )}
        <h3 style={{ fontSize: 13, marginBottom: 8 }}>Restaurants</h3>
        <div className="data-table-container" style={{ maxHeight: 350 }}>
          <table className="data-table">
            <thead><tr><th className="data-table-th">Name</th><th className="data-table-th">Orders</th></tr></thead>
            <tbody>{restaurants.map((r: any) => (
              <tr key={r.RESTAURANT_ID} onClick={() => loadCatchment(r.RESTAURANT_ID)} style={{ cursor: 'pointer', background: selectedRestaurant === r.RESTAURANT_ID ? 'rgba(41,181,232,0.1)' : undefined }}>
                <td style={{ fontSize: 11 }}>{String(r.RESTAURANT_NAME || r.RESTAURANT_ID).slice(0, 22)}</td>
                <td>{r.TOTAL_ORDERS}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
      <MapView layers={layers} initialViewState={{ longitude: center.lng, latitude: center.lat, zoom }} />
    </div>
  );
}
