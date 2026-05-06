import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import MetricCard from '../shared/MetricCard';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, PathLayer, GeoJsonLayer } from '@deck.gl/layers';
import { BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { useRegion } from '../hooks/useRegion';

const RO_DB = 'FLEET_INTELLIGENCE';
const RO_SCHEMA = 'ROUTE_OPTIMIZATION';
const CARTO_LIGHT = '/api/tiles/{z}/{x}/{y}';

async function sfQuery(sql: string, database = RO_DB, schema = RO_SCHEMA): Promise<any[]> {
  try {
    const res = await fetch('/api/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, database, schema }) });
    const body = await res.json();
    const rows = Array.isArray(body) ? body : (body.result ?? []);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.error('[sfQuery] Error:', err, 'SQL:', sql.slice(0, 300));
    return [];
  }
}

function cartoBasemap() {
  return new TileLayer({ id: 'carto-basemap', data: CARTO_LIGHT, minZoom: 0, maxZoom: 19, tileSize: 256, renderSubLayers: (props: any) => { const { boundingBox } = props.tile; return new BitmapLayer(props, { data: undefined, image: props.data, bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]] }); } });
}

const ROUTE_COLORS: [number, number, number][] = [[41, 181, 232], [34, 197, 94], [245, 158, 11], [239, 68, 68], [128, 0, 255], [255, 105, 180], [0, 191, 255], [50, 205, 50]];

interface VehicleConfig { id: number; profile: string; startLng: number; startLat: number; endLng: number; endLat: number; capacity: number; }

export default function RouteOptimization() {
  const { regionName, center, zoom } = useRegion();
  const [searchText, setSearchText] = useState('');
  const [centerCoords, setCenterCoords] = useState<[number, number] | null>(null);
  const [radius, setRadius] = useState(5);
  const [industries, setIndustries] = useState<any[]>([]);
  const [selectedIndustry, setSelectedIndustry] = useState('');
  const [places, setPlaces] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<VehicleConfig[]>([{ id: 1, profile: 'driving-car', startLng: center.lng, startLat: center.lat, endLng: center.lng, endLat: center.lat, capacity: 10 }]);
  const [isoMinutes, setIsoMinutes] = useState(15);
  const [catchmentGeoJson, setCatchmentGeoJson] = useState<any>(null);
  const [vrpResult, setVrpResult] = useState<any>(null);
  const [routePaths, setRoutePaths] = useState<any[]>([]);
  const [solving, setSolving] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [showVehicles, setShowVehicles] = useState(false);
  const [loading, setLoading] = useState(false);
  const [viewState, setViewState] = useState({ longitude: -122.4194, latitude: 37.7749, zoom: 11, pitch: 0, bearing: 0 });
  const [mapDims, setMapDims] = useState<{ width: number; height: number } | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = mapContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setMapDims({ width: Math.round(width), height: Math.round(height) });
    });
    ro.observe(el);
    if (el.clientWidth > 0 && el.clientHeight > 0) setMapDims({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const lng = Number(center.lng);
    const lat = Number(center.lat);
    const z = Number(zoom);
    if (Number.isFinite(lng) && Number.isFinite(lat) && Number.isFinite(z) && (lng !== 0 || lat !== 0)) {
      setViewState(prev => ({ ...prev, longitude: lng, latitude: lat, zoom: z }));
      setVehicles(prev => prev.map(v => ({ ...v, startLng: lng, startLat: lat, endLng: lng, endLat: lat })));
    }
    setCenterCoords(null);
    setPlaces([]);
    setJobs([]);
    setRoutePaths([]);
    setVrpResult(null);
    setCatchmentGeoJson(null);
  }, [center.lng, center.lat, zoom]);

  useEffect(() => {
    sfQuery(`SELECT DISTINCT INDUSTRY FROM LOOKUP WHERE REGION = '${regionName}' ORDER BY INDUSTRY`).then(r => setIndustries(r));
  }, [regionName]);

  const geocode = useCallback(async () => {
    if (!searchText.trim()) return;
    setGeocoding(true);
    const rows = await sfQuery(`SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-sonnet-4-5', 'Give me the latitude and longitude for "${searchText.replace(/'/g, "''")}". Reply ONLY with JSON: {"lat":number,"lng":number}') AS RESULT`);
    try {
      const raw = (rows[0]?.RESULT || '{}').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(raw);
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
    const placesQuery = selectedIndustry 
      ? `SELECT p.NAME, p.CATEGORY, ST_X(p.GEOMETRY) AS LNG, ST_Y(p.GEOMETRY) AS LAT 
         FROM PLACES p, LOOKUP l 
         WHERE p.REGION = '${regionName}' 
           AND l.REGION = '${regionName}'
           AND l.INDUSTRY = '${selectedIndustry}'
           AND ARRAY_CONTAINS(p.CATEGORY::VARIANT, l.CTYPE)
           AND ST_DWITHIN(p.GEOMETRY, ST_MAKEPOINT(${centerCoords[0]}, ${centerCoords[1]}), ${radius * 1000})
         LIMIT 200`
      : `SELECT NAME, CATEGORY, ST_X(GEOMETRY) AS LNG, ST_Y(GEOMETRY) AS LAT 
         FROM PLACES 
         WHERE REGION = '${regionName}' 
           AND ST_DWITHIN(GEOMETRY, ST_MAKEPOINT(${centerCoords[0]}, ${centerCoords[1]}), ${radius * 1000}) 
         LIMIT 200`;
    const [p, j] = await Promise.all([
      sfQuery(placesQuery),
      sfQuery(`SELECT ID, SLOT_START, SLOT_END, SKILLS, PRODUCT, STATUS FROM JOB_TEMPLATE WHERE REGION = '${regionName}' AND STATUS = 'active' LIMIT 30`),
    ]);
    setPlaces(p);
    setJobs(j);
    setLoading(false);
  }, [centerCoords, radius, selectedIndustry, regionName]);

  useEffect(() => { if (centerCoords) loadPlaces(); }, [centerCoords, radius, selectedIndustry]);

  const previewCatchment = useCallback(async () => {
    console.log('[Catchment] centerCoords:', centerCoords, 'profile:', vehicles[0]?.profile, 'isoMinutes:', isoMinutes);
    if (!centerCoords) { console.warn('[Catchment] No centerCoords — search for a location first'); return; }
    const rows = await sfQuery(`SELECT GEOJSON AS GEO FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES('${vehicles[0].profile}', ${centerCoords[0]}::FLOAT, ${centerCoords[1]}::FLOAT, ${isoMinutes}::INT, NULL::VARCHAR))`, 'OPENROUTESERVICE_APP', 'CORE');
    console.log('[Catchment] rows returned:', rows.length, rows[0]);
    if (rows[0]?.GEO) {
      try { setCatchmentGeoJson(JSON.parse(rows[0].GEO)); } catch (e) { console.error('[Catchment] JSON parse error:', e); }
    }
  }, [centerCoords, vehicles, isoMinutes]);

  const optimizeRoutes = useCallback(async () => {
    if (!places.length) return;
    setSolving(true);
    setRoutePaths([]);
    setVrpResult(null);

    const vrpJobs = places.slice(0, 30).map((p: any, i: number) => {
      const jobTemplate = jobs[i % jobs.length];
      return {
        id: i + 1, 
        location: [Number(p.LNG), Number(p.LAT)], 
        service: 300,
        skills: [Number(jobTemplate?.SKILLS) || 1],
      };
    });
    const vrpVehicles = vehicles.map((v, i) => ({
      id: i + 1, 
      profile: v.profile || 'driving-car', 
      start: [v.startLng, v.startLat], 
      end: [v.endLng, v.endLat],
      capacity: [Number(v.capacity)],
      skills: [(i % 3) + 1],
    }));
    console.log('[VRP] vehicles state:', vehicles);
    console.log('[VRP] vrpVehicles:', JSON.stringify(vrpVehicles));
    console.log('[VRP] vrpJobs count:', vrpJobs.length);

    const vrpChallenge = { jobs: vrpJobs, vehicles: vrpVehicles };
    const rows = await sfQuery(`SELECT * FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON('${JSON.stringify(vrpChallenge).replace(/'/g, "''")}')))`, 'OPENROUTESERVICE_APP', 'CORE');
    console.log('[VRP] Received', rows.length, 'rows from OPTIMIZATION');
    if (rows.length > 0) {
      setVrpResult(rows[0]);
      const paths: any[] = [];
      for (const row of rows) {
        if (row.GEOJSON) {
          try {
            const geojson = typeof row.GEOJSON === 'string' ? JSON.parse(row.GEOJSON) : row.GEOJSON;
            paths.push({ vehicleIdx: (row.VEHICLE || 1) - 1, geojson });
          } catch (e) {
            console.error('[VRP] Failed to parse GEOJSON:', e);
          }
        }
      }
      console.log('[VRP] Parsed', paths.length, 'route geometries');
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
            <button onClick={() => setVehicles(prev => [...prev, { id: prev.length + 1, profile: 'driving-car', startLng: centerCoords?.[0] || center.lng, startLat: centerCoords?.[1] || center.lat, endLng: centerCoords?.[0] || center.lng, endLat: centerCoords?.[1] || center.lat, capacity: 10 }])} style={{ fontSize: 11, padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', cursor: 'pointer' }}>+ Add</button>
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

      <div ref={mapContainerRef} style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
        {(loading || solving) && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>{solving ? 'Solving VRP...' : 'Loading...'}</div>}
        {mapDims && <DeckGL width={mapDims.width} height={mapDims.height} viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} getTooltip={getTooltip} style={{ position: 'absolute', top: '0', left: '0', width: `${mapDims.width}px`, height: `${mapDims.height}px` }} />}
      </div>
    </div>
  );
}
