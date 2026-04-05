import { useMemo, useState, useCallback } from 'react';
import { ScatterplotLayer, GeoJsonLayer } from '@deck.gl/layers';
import MapView from '../../shared/MapView';
import MetricCard from '../../shared/MetricCard';
import { fmtDec } from '../../shared/format';
import { useSfQuery, useSnowflake } from '../../hooks/useSnowflake';
import { useRegion } from '../../hooks/useRegion';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

const ZONE_COLORS: [number, number, number][] = [[34, 197, 94], [41, 181, 232], [245, 158, 11], [239, 68, 68], [128, 0, 255]];

export default function CatchmentPanel({ sourceDb, sourceSchema }: Props) {
  const { regionName, center, zoom } = useRegion();
  const [selectedRestaurant, setSelectedRestaurant] = useState<string | null>(null);
  const [catchmentGeo, setCatchmentGeo] = useState<any[]>([]);
  const [catchmentZones, setCatchmentZones] = useState<any[]>([]);
  const [travelMode, setTravelMode] = useState('cycling-electric');
  const [numZones, setNumZones] = useState(3);
  const [maxMinutes, setMaxMinutes] = useState(15);
  const [analyzing, setAnalyzing] = useState(false);
  const { query } = useSnowflake();

  const { data: restaurants, loading } = useSfQuery(
    `SELECT RESTAURANT_ID, RESTAURANT_NAME, ST_X(LOCATION) AS LNG, ST_Y(LOCATION) AS LAT,
            TOTAL_ORDERS, AVG_DELIVERY_TIME_MIN
     FROM RESTAURANTS_ENRICHED WHERE REGION = '${regionName}' ORDER BY TOTAL_ORDERS DESC LIMIT 100`, sourceDb, sourceSchema, [regionName]);

  const loadCatchment = useCallback(async (id: string) => {
    setSelectedRestaurant(id);
    setCatchmentZones([]);
    setAnalyzing(true);

    const geo = await query(
      `SELECT ST_X(CUSTOMER_LOCATION) AS LNG, ST_Y(CUSTOMER_LOCATION) AS LAT, DELIVERY_TIME_MIN
       FROM DELIVERIES WHERE RESTAURANT_ID = '${id}' LIMIT 500`,
      { database: sourceDb, schema: sourceSchema });
    setCatchmentGeo(geo);

    const rest = restaurants.find((r: any) => r.RESTAURANT_ID === id);
    if (rest?.LNG && rest?.LAT) {
      const lng = Number(rest.LNG);
      const lat = Number(rest.LAT);
      const zones: any[] = [];
      for (let i = numZones; i >= 1; i--) {
        const minutes = Math.round(maxMinutes * (i / numZones));
        try {
          const rows = await query(
            `SELECT GEOJSON AS GEO FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.ISOCHRONES('${travelMode}', ${lng}::FLOAT, ${lat}::FLOAT, ${minutes}::INT))`,
            { database: 'OPENROUTESERVICE_NATIVE_APP', schema: 'CORE' });
          if (rows[0]?.GEO) {
            zones.push({ zoneIdx: i - 1, minutes, geojson: JSON.parse(rows[0].GEO) });
          }
        } catch {}
      }
      setCatchmentZones(zones);
    }
    setAnalyzing(false);
  }, [restaurants, travelMode, numZones, maxMinutes, query, sourceDb, sourceSchema]);

  const layers = useMemo(() => {
    const l: any[] = [];

    catchmentZones.forEach((z, i) => {
      const c = ZONE_COLORS[z.zoneIdx % ZONE_COLORS.length];
      l.push(new GeoJsonLayer({
        id: `zone-${i}`, data: z.geojson, filled: true, stroked: true,
        getFillColor: [...c, 40], getLineColor: [...c, 180], lineWidthMinPixels: 2,
      }));
    });

    if (catchmentGeo.length) {
      l.push(new ScatterplotLayer({
        id: 'customers', data: catchmentGeo,
        getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)],
        getFillColor: [34, 197, 94, 120], getRadius: 30, radiusMinPixels: 3,
      }));
    }

    if (restaurants.length) {
      l.push(new ScatterplotLayer({
        id: 'restaurants', data: restaurants, pickable: true,
        getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)],
        getFillColor: (d: any) => d.RESTAURANT_ID === selectedRestaurant ? [255, 107, 53, 255] : [41, 181, 232, 200],
        getRadius: 60, radiusMinPixels: 5,
        onClick: ({ object }: any) => object && loadCatchment(object.RESTAURANT_ID),
      }));
    }
    return l;
  }, [restaurants, catchmentGeo, catchmentZones, selectedRestaurant]);

  const s = restaurants.find((r: any) => r.RESTAURANT_ID === selectedRestaurant);

  return (
    <div className="page-full">
      <div className="page-sidebar-panel">
        <h2>Catchment Analysis</h2>
        <p>{loading ? 'Loading...' : analyzing ? 'Computing isochrones...' : `${restaurants.length} restaurants`}</p>
        {s && (
          <div className="metric-grid-vertical" style={{ marginBottom: 12 }}>
            <MetricCard label="Selected" value={s.RESTAURANT_NAME || s.RESTAURANT_ID} />
            <MetricCard label="Orders" value={s.TOTAL_ORDERS} />
            <MetricCard label="Customers" value={catchmentGeo.length} subtitle="in catchment" />
            <MetricCard label="Zones" value={catchmentZones.length} />
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          <div className="form-group">
            <label>Travel Mode</label>
            <select className="form-select" value={travelMode} onChange={e => setTravelMode(e.target.value)}>
              <option value="cycling-electric">E-Bike</option>
              <option value="cycling-regular">Bicycle</option>
              <option value="foot-walking">Walking</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11 }}>Zones: {numZones}</label>
            <input type="range" min={1} max={5} value={numZones} onChange={e => setNumZones(Number(e.target.value))} style={{ width: '100%' }} />
          </div>
          <div>
            <label style={{ fontSize: 11 }}>Max: {maxMinutes} min</label>
            <input type="range" min={5} max={30} step={5} value={maxMinutes} onChange={e => setMaxMinutes(Number(e.target.value))} style={{ width: '100%' }} />
          </div>
        </div>
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
