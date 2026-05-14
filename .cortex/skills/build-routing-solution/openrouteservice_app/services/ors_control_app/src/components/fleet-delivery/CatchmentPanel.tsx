import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer } from '@deck.gl/layers';
import MetricCard from '../../shared/MetricCard';
import { fmtDec } from '../../shared/format';
import { FD_DB, FD_SCHEMA, sfQuery, cartoBasemap } from './helpers';
import { useRegion } from '../../hooks/useRegion';
import { useVehicleType } from '../../hooks/useVehicleType';

const ZONE_COLORS: [number, number, number][] = [[34, 197, 94], [41, 181, 232], [245, 158, 11], [239, 68, 68], [128, 0, 255]];
const ZONE_MINUTES = [5, 10, 15];

export default function CatchmentPanel() {
  const { regionName, center, zoom } = useRegion();
  const { vehicleType } = useVehicleType();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [customers, setCustomers] = useState<any[]>([]);
  const [restaurants, setRestaurants] = useState<any[]>([]);
  const [catchmentZones, setCatchmentZones] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [travelMode, setTravelMode] = useState('cycling-electric');
  const [numZones, setNumZones] = useState(3);
  const [maxMinutes, setMaxMinutes] = useState(15);
  const [viewState, setViewState] = useState({ longitude: center.lng, latitude: center.lat, zoom, pitch: 0, bearing: 0 });

  useEffect(() => {
    setLoading(true);
    sfQuery(`SELECT RESTAURANT_ID, RESTAURANT_NAME, ST_X(LOCATION) AS LNG, ST_Y(LOCATION) AS LAT, TOTAL_ORDERS, AVG_DELIVERY_TIME_MIN FROM RESTAURANTS_ENRICHED ORDER BY TOTAL_ORDERS DESC LIMIT 100`)
      .then(r => { setRestaurants(r); setLoading(false); });
  }, [regionName, vehicleType]);

  useEffect(() => {
    setViewState(prev => ({ ...prev, longitude: center.lng, latitude: center.lat, zoom }));
  }, [center.lng, center.lat, zoom]);

  const selected = useMemo(() => restaurants.find(r => r.RESTAURANT_ID === selectedId), [restaurants, selectedId]);

  const loadCatchment = useCallback(async (id: string) => {
    setSelectedId(id);
    setCatchmentZones([]);
    setAnalyzing(true);

    const rest = restaurants.find(r => r.RESTAURANT_ID === id);
    if (rest?.LNG && rest?.LAT) {
      setViewState(prev => ({ ...prev, longitude: Number(rest.LNG), latitude: Number(rest.LAT), zoom: 13 }));
    }

    const [custRows] = await Promise.all([
      sfQuery(`SELECT ST_X(CUSTOMER_LOCATION) AS LNG, ST_Y(CUSTOMER_LOCATION) AS LAT, DELIVERY_TIME_MIN FROM DELIVERIES WHERE RESTAURANT_ID = '${id}' LIMIT 500`),
    ]);
    setCustomers(custRows);

    if (rest?.LNG && rest?.LAT) {
      const lng = Number(rest.LNG);
      const lat = Number(rest.LAT);
      const zones: any[] = [];
      for (let i = numZones; i >= 1; i--) {
        const minutes = Math.round(maxMinutes * (i / numZones));
        try {
          const rows = await sfQuery(
            `SELECT GEOJSON AS GEO FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES('${travelMode}', ${lng}::FLOAT, ${lat}::FLOAT, ${minutes}::INT))`,
            'OPENROUTESERVICE_APP', 'CORE'
          );
          if (rows[0]?.GEO) {
            zones.push({ zoneIdx: i - 1, minutes, geojson: JSON.parse(rows[0].GEO) });
          }
        } catch {}
      }
      setCatchmentZones(zones);
    }
    setAnalyzing(false);
  }, [restaurants, travelMode, numZones, maxMinutes]);

  const basemap = useMemo(() => cartoBasemap(), []);

  const dataLayers = useMemo(() => {
    const result: any[] = [];

    catchmentZones.forEach((z, i) => {
      const c = ZONE_COLORS[z.zoneIdx % ZONE_COLORS.length];
      result.push(new GeoJsonLayer({
        id: `zone-${i}`, data: z.geojson, filled: true, stroked: true,
        getFillColor: [...c, 40], getLineColor: [...c, 180], lineWidthMinPixels: 2,
      }));
    });

    if (customers.length) {
      result.push(new ScatterplotLayer({
        id: 'customers', data: customers.filter((c: any) => c.LNG && c.LAT),
        getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)],
        getFillColor: [34, 197, 94, 150], getRadius: 40, radiusMinPixels: 3,
      }));
    }

    if (restaurants.length) {
      result.push(new ScatterplotLayer({
        id: 'restaurants', data: restaurants.filter((r: any) => r.LNG && r.LAT),
        getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)],
        getFillColor: (d: any) => d.RESTAURANT_ID === selectedId ? [255, 255, 255, 255] : [100, 100, 100, 180],
        getLineColor: (d: any) => d.RESTAURANT_ID === selectedId ? [239, 68, 68, 255] : [0, 0, 0, 0],
        stroked: true, lineWidthMinPixels: 2,
        getRadius: 80, radiusMinPixels: 5, pickable: true,
        updateTriggers: { getFillColor: [selectedId], getLineColor: [selectedId] },
      }));
    }

    return result;
  }, [catchmentZones, customers, restaurants, selectedId]);

  const layers = useMemo(() => [basemap, ...dataLayers].filter(Boolean), [basemap, dataLayers]);

  const getTooltip = useCallback(({ object }: any) => {
    if (!object?.RESTAURANT_NAME) return null;
    return {
      html: `<b>${object.RESTAURANT_NAME}</b><br/>Orders: ${object.TOTAL_ORDERS}<br/>Avg: ${fmtDec(object.AVG_DELIVERY_TIME_MIN)} min`,
      style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' },
    };
  }, []);

  return (
    <div className="panel">
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Catchment Analysis</h2>
      <p className="subtitle">Restaurant delivery isochrone catchment</p>
      <div className="metric-grid">
        <MetricCard label="Selected" value={selected?.RESTAURANT_NAME || '—'} />
        <MetricCard label="Orders" value={selected?.TOTAL_ORDERS ?? '—'} />
        <MetricCard label="Customers" value={customers.length || '—'} />
        <MetricCard label="Zones" value={catchmentZones.length || '—'} />
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="form-group" style={{ minWidth: 140 }}>
          <label>Travel Mode</label>
          <select className="form-select" value={travelMode} onChange={e => setTravelMode(e.target.value)}>
            <option value="cycling-electric">E-Bike</option>
            <option value="cycling-regular">Bicycle</option>
            <option value="foot-walking">Walking</option>
          </select>
        </div>
        <div style={{ minWidth: 100 }}>
          <label className="range-label">Zones: {numZones}</label>
          <input type="range" min={1} max={5} value={numZones} onChange={e => setNumZones(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <div style={{ minWidth: 120 }}>
          <label className="range-label">Max: {maxMinutes} min</label>
          <input type="range" min={5} max={30} step={5} value={maxMinutes} onChange={e => setMaxMinutes(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
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
        {(loading || analyzing) && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>{analyzing ? 'Computing isochrones...' : 'Loading...'}</div>}
        <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} getTooltip={getTooltip} style={{ width: '100%', height: '100%' }} />
        {catchmentZones.length > 0 && (
          <div style={{ position: 'absolute', bottom: 12, left: 12, display: 'flex', gap: 8, background: 'rgba(0,0,0,0.6)', borderRadius: 6, padding: '4px 8px' }}>
            {catchmentZones.map((z, i) => <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#fff' }}><span style={{ width: 10, height: 10, borderRadius: 2, background: `rgb(${ZONE_COLORS[z.zoneIdx % ZONE_COLORS.length].join(',')})` }} />{z.minutes} min</span>)}
          </div>
        )}
      </div>
    </div>
  );
}
