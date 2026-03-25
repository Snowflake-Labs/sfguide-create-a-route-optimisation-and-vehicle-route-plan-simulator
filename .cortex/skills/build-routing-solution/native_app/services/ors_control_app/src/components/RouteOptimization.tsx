import { useState, useEffect, useMemo, useCallback } from 'react';
import MetricCard from '../shared/MetricCard';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, PathLayer, GeoJsonLayer } from '@deck.gl/layers';
import { BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';

const RO_DB = 'FLEET_INTELLIGENCE';
const RO_SCHEMA = 'ROUTE_OPTIMIZATION';
const CARTO_LIGHT = '/api/tiles/{z}/{x}/{y}';

async function sfQuery(sql: string, database = RO_DB, schema = RO_SCHEMA): Promise<any[]> {
  try {
    const res = await fetch('/api/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, database, schema }) });
    const body = await res.json();
    const rows = Array.isArray(body) ? body : (body.result ?? []);
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

function cartoBasemap() {
  return new TileLayer({ id: 'carto-basemap', data: CARTO_LIGHT, minZoom: 0, maxZoom: 19, tileSize: 256, renderSubLayers: (props: any) => { const { boundingBox } = props.tile; return new BitmapLayer(props, { data: undefined, image: props.data, bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]] }); } });
}

const ROUTE_COLORS: [number, number, number][] = [[41, 181, 232], [34, 197, 94], [245, 158, 11], [239, 68, 68], [128, 0, 255], [255, 105, 180], [0, 191, 255], [50, 205, 50]];

interface VehicleConfig { id: number; profile: string; startLng: number; startLat: number; endLng: number; endLat: number; capacity: number; }

export default function RouteOptimization() {
  const [searchText, setSearchText] = useState('');
  const [centerCoords, setCenterCoords] = useState<[number, number] | null>(null);
  const [radius, setRadius] = useState(5);
  const [industries, setIndustries] = useState<any[]>([]);
  const [selectedIndustry, setSelectedIndustry] = useState('');
  const [places, setPlaces] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<VehicleConfig[]>([{ id: 1, profile: 'driving-car', startLng: -122.43, startLat: 37.77, endLng: -122.43, endLat: 37.77, capacity: 10 }]);
  const [isoMinutes, setIsoMinutes] = useState(15);
  const [catchmentGeoJson, setCatchmentGeoJson] = useState<any>(null);
  const [vrpResult, setVrpResult] = useState<any>(null);
  const [routePaths, setRoutePaths] = useState<any[]>([]);
  const [solving, setSolving] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [showVehicles, setShowVehicles] = useState(false);
  const [loading, setLoading] = useState(false);
  const [viewState, setViewState] = useState({ longitude: -122.43, latitude: 37.77, zoom: 12, pitch: 0, bearing: 0 });

  useEffect(() => {
    sfQuery(`SELECT DISTINCT INDUSTRY FROM LOOKUP ORDER BY INDUSTRY`).then(r => setIndustries(r));
  }, []);

  const geocode = useCallback(async () => {
    if (!searchText.trim()) return;
    setGeocoding(true);
    const rows = await sfQuery(`SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-sonnet-4-5', 'Give me the latitude and longitude for "${searchText.replace(/'/g, "''")}". Reply ONLY with JSON: {"lat":number,"lng":number}') AS RESULT`);
    try {
      const parsed = JSON.parse(rows[0]?.RESULT || '{}');
      if (parsed.lat && parsed.lng) {
        setCenterCoords([parsed.lng, parsed.lat]);
        setViewState(prev => ({ ...prev, longitude: parsed.lng, latitude: parsed.lat, zoom: 13 }));
        setVehicles(prev => prev.map(v => ({ ...v, startLng: parsed.lng, startLat: parsed.lat, endLng: parsed.lng, endLat: parsed.lat })));
      }
    } catch {}
    setGeocoding(false);
  }, [searchText]);

  const loadPlaces = useCallback(async () => {
    if (!centerCoords) return;
    setLoading(true);
    const indFilter = selectedIndustry ? ` AND CATEGORY = '${selectedIndustry}'` : '';
    const [p, j] = await Promise.all([
      sfQuery(`SELECT NAME, CATEGORY, ST_X(GEOMETRY) AS LNG, ST_Y(GEOMETRY) AS LAT FROM PLACES WHERE ST_DWITHIN(GEOMETRY, ST_MAKEPOINT(${centerCoords[0]}, ${centerCoords[1]}), ${radius * 1000})${indFilter} LIMIT 200`),
      sfQuery(`SELECT ID, SLOT_START, SLOT_END, SKILLS, PRODUCT, STATUS FROM JOB_TEMPLATE WHERE STATUS = 'active' LIMIT 30`),
    ]);
    setPlaces(p);
    setJobs(j);
    setLoading(false);
  }, [centerCoords, radius, selectedIndustry]);

  useEffect(() => { if (centerCoords) loadPlaces(); }, [centerCoords, radius, selectedIndustry]);

  const previewCatchment = useCallback(async () => {
    if (!centerCoords) return;
    const rows = await sfQuery(`SELECT GEOJSON AS GEO FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.ISOCHRONES_GEO('${vehicles[0].profile}', ${centerCoords[0]}, ${centerCoords[1]}, ${isoMinutes}))`, RO_DB, RO_SCHEMA);
    if (rows[0]?.GEO) {
      try { setCatchmentGeoJson(JSON.parse(rows[0].GEO)); } catch {}
    }
  }, [centerCoords, vehicles, isoMinutes]);

  const optimizeRoutes = useCallback(async () => {
    if (!places.length) return;
    setSolving(true);
    setRoutePaths([]);
    setVrpResult(null);

    const vrpJobs = places.slice(0, 30).map((p: any, i: number) => ({
      id: i + 1, location: [Number(p.LNG), Number(p.LAT)], service: 300,
      ...(jobs[i % jobs.length] ? { time_windows: [[0, 86400]] } : {}),
    }));
    const vrpVehicles = vehicles.map((v, i) => ({
      id: i + 1, profile: v.profile, start: [v.startLng, v.startLat], end: [v.endLng, v.endLat],
      capacity: [v.capacity], time_window: [0, 86400],
    }));

    const rows = await sfQuery(`SELECT * FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.OPTIMIZATION(PARSE_JSON('${JSON.stringify(vrpJobs).replace(/'/g, "''")}'), PARSE_JSON('${JSON.stringify(vrpVehicles).replace(/'/g, "''")}')))`);
    if (rows.length > 0) {
      setVrpResult(rows[0]);
      const paths: any[] = [];
      for (let i = 0; i < vehicles.length; i++) {
        const routeSteps = rows.filter((r: any) => Number(r.VEHICLE_ID || r.VEHICLE) === i + 1);
        if (routeSteps.length < 2) continue;
        const coords = routeSteps.map((s: any) => `${s.LON || s.LONGITUDE},${s.LAT || s.LATITUDE}`).join('|');
        const dirRows = await sfQuery(`SELECT GEOJSON FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS_GEO('${vehicles[i].profile}', '${coords}'))`);
        if (dirRows[0]?.GEOJSON) {
          try { paths.push({ vehicleIdx: i, geojson: JSON.parse(dirRows[0].GEOJSON) }); } catch {}
        }
      }
      setRoutePaths(paths);
    }
    setSolving(false);
  }, [places, jobs, vehicles]);

  const basemap = useMemo(() => cartoBasemap(), []);

  const dataLayers = useMemo(() => {
    const result: any[] = [];
    if (catchmentGeoJson) {
      result.push(new GeoJsonLayer({ id: 'catchment', data: catchmentGeoJson, filled: true, stroked: true, getFillColor: [41, 181, 232, 40], getLineColor: [41, 181, 232, 180], lineWidthMinPixels: 2 }));
    }
    routePaths.forEach((rp, i) => {
      const c = ROUTE_COLORS[rp.vehicleIdx % ROUTE_COLORS.length];
      result.push(new GeoJsonLayer({ id: `route-${i}`, data: rp.geojson, stroked: true, filled: false, getLineColor: [...c, 200], lineWidthMinPixels: 3 }));
    });
    if (places.length) {
      result.push(new ScatterplotLayer({ id: 'places', data: places.filter((p: any) => p.LNG && p.LAT), getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)], getFillColor: [41, 181, 232, 180], getRadius: 50, radiusMinPixels: 4, pickable: true }));
    }
    if (centerCoords) {
      result.push(new ScatterplotLayer({ id: 'depot', data: [{ lng: centerCoords[0], lat: centerCoords[1] }], getPosition: (d: any) => [d.lng, d.lat], getFillColor: [245, 158, 11, 255], getLineColor: [255, 255, 255, 255], getRadius: 80, radiusMinPixels: 8, stroked: true, lineWidthMinPixels: 3 }));
    }
    return result;
  }, [catchmentGeoJson, routePaths, places, centerCoords]);

  const layers = useMemo(() => [basemap, ...dataLayers].filter(Boolean), [basemap, dataLayers]);

  const getTooltip = useCallback(({ object }: any) => {
    if (!object?.NAME) return null;
    return { html: `<b>${object.NAME}</b><br/>${object.CATEGORY || ''}`, style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' } };
  }, []);

  return (
    <div className="panel">
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Route Optimization</h2>
      <p className="subtitle">VRP solver with ORS isochrones and directions</p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <label className="range-label">Search Location</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="select" value={searchText} onChange={e => setSearchText(e.target.value)} onKeyDown={e => e.key === 'Enter' && geocode()} placeholder="Enter address or city..." style={{ flex: 1 }} />
            <button className="btn-primary" onClick={geocode} disabled={geocoding}>{geocoding ? '...' : 'Go'}</button>
          </div>
        </div>
        <div style={{ minWidth: 160 }}>
          <label className="range-label">Radius: {radius} km</label>
          <input type="range" min={1} max={20} value={radius} onChange={e => setRadius(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <div style={{ minWidth: 120 }}>
          <label className="range-label">Industry</label>
          <select className="select" value={selectedIndustry} onChange={e => setSelectedIndustry(e.target.value)}>
            <option value="">All</option>
            {industries.map(i => <option key={i.INDUSTRY} value={i.INDUSTRY}>{i.INDUSTRY}</option>)}
          </select>
        </div>
      </div>

      <div className="metric-grid">
        <MetricCard label="Places" value={places.length} />
        <MetricCard label="Job Templates" value={jobs.length} />
        <MetricCard label="Vehicles" value={vehicles.length} />
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <button className="btn-primary" onClick={() => setShowVehicles(!showVehicles)} style={{ fontSize: 12 }}>{showVehicles ? 'Hide' : 'Show'} Vehicle Config</button>
        <button className="btn-primary" onClick={previewCatchment} disabled={!centerCoords} style={{ fontSize: 12 }}>Preview Catchment ({isoMinutes}m)</button>
        <div style={{ minWidth: 120 }}>
          <input type="range" min={5} max={60} step={5} value={isoMinutes} onChange={e => setIsoMinutes(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <button className="btn-primary" onClick={optimizeRoutes} disabled={solving || !places.length} style={{ fontSize: 12, background: '#0DB048' }}>{solving ? 'Solving...' : 'Optimize Routes'}</button>
      </div>

      {showVehicles && (
        <div style={{ marginBottom: 12, padding: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'rgba(0,0,0,0.02)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <h3 style={{ fontSize: 13, margin: 0 }}>Vehicles</h3>
            <button onClick={() => setVehicles(prev => [...prev, { id: prev.length + 1, profile: 'driving-car', startLng: centerCoords?.[0] || -122.43, startLat: centerCoords?.[1] || 37.77, endLng: centerCoords?.[0] || -122.43, endLat: centerCoords?.[1] || 37.77, capacity: 10 }])} style={{ fontSize: 11, padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', cursor: 'pointer' }}>+ Add</button>
          </div>
          {vehicles.map((v, i) => (
            <div key={v.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, fontSize: 12 }}>
              <span style={{ width: 12, height: 12, borderRadius: '50%', background: `rgb(${ROUTE_COLORS[i % ROUTE_COLORS.length].join(',')})`, flexShrink: 0 }} />
              <select className="select" value={v.profile} onChange={e => setVehicles(prev => prev.map((vv, ii) => ii === i ? { ...vv, profile: e.target.value } : vv))} style={{ width: 120 }}>
                <option value="driving-car">Car</option>
                <option value="driving-hgv">HGV</option>
                <option value="cycling-regular">Bicycle</option>
              </select>
              <span style={{ color: 'var(--text-secondary)' }}>Cap:</span>
              <input type="number" value={v.capacity} onChange={e => setVehicles(prev => prev.map((vv, ii) => ii === i ? { ...vv, capacity: Number(e.target.value) } : vv))} style={{ width: 50 }} />
              {vehicles.length > 1 && <button onClick={() => setVehicles(prev => prev.filter((_, ii) => ii !== i))} style={{ fontSize: 11, color: '#E5484D', background: 'transparent', border: 'none', cursor: 'pointer' }}>x</button>}
            </div>
          ))}
        </div>
      )}

      {vrpResult && (
        <div className="info-box success">
          Solution: {routePaths.length} routes generated
        </div>
      )}

      <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
        {(loading || solving) && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>{solving ? 'Solving VRP...' : 'Loading...'}</div>}
        <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} getTooltip={getTooltip} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  );
}
