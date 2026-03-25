import { useMemo, useState, useCallback } from 'react';
import { ScatterplotLayer, PathLayer, IconLayer } from '@deck.gl/layers';
import { GeoJsonLayer } from '@deck.gl/layers';
import MapView from '../../shared/MapView';
import MetricCard from '../../shared/MetricCard';
import { useSfQuery, useSnowflake } from '../../hooks/useSnowflake';
import { useRegion } from '../../hooks/useRegion';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

const ROUTE_COLORS: [number, number, number, number][] = [
  [41, 181, 232, 200], [255, 107, 53, 200], [34, 197, 94, 200],
  [234, 179, 8, 200], [168, 85, 247, 200], [236, 72, 153, 200],
];

interface VehicleConfig {
  profile: string;
  startHour: number;
  endHour: number;
  capacity: number;
  skills: number[];
}

export default function RouteOptimization({ sourceDb, sourceSchema, config }: Props) {
  const { regionName, center, zoom } = useRegion();
  const [searchText, setSearchText] = useState('');
  const [centerCoords, setCenterCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [radius, setRadius] = useState(20);
  const [selectedIndustry, setSelectedIndustry] = useState<string | null>(null);
  const [vehicles, setVehicles] = useState<VehicleConfig[]>([
    { profile: 'driving-car', startHour: 8, endHour: 18, capacity: 100, skills: [1] },
    { profile: 'driving-car', startHour: 8, endHour: 18, capacity: 100, skills: [1] },
    { profile: 'driving-car', startHour: 9, endHour: 17, capacity: 80, skills: [2] },
  ]);
  const [isoMinutes, setIsoMinutes] = useState(30);
  const [catchmentGeoJson, setCatchmentGeoJson] = useState<any>(null);
  const [vrpResult, setVrpResult] = useState<any>(null);
  const [routePaths, setRoutePaths] = useState<any[]>([]);
  const [solving, setSolving] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [showVehicles, setShowVehicles] = useState(false);
  const { query } = useSnowflake();

  const profiles = config?.ors?.profiles || ['driving-car', 'driving-hgv', 'cycling-electric'];

  const { data: industries } = useSfQuery(
    `SELECT INDUSTRY, PA, PB, PC FROM LOOKUP WHERE REGION = '${regionName}'`, sourceDb, sourceSchema, [regionName]);

  const placesQuery = centerCoords
    ? `SELECT NAME, CATEGORY, ST_X(GEOMETRY) AS LNG, ST_Y(GEOMETRY) AS LAT
       FROM PLACES WHERE REGION = '${regionName}' AND ST_DWITHIN(GEOMETRY, ST_MAKEPOINT(${centerCoords.lng}, ${centerCoords.lat}), ${radius * 1000})
       ${selectedIndustry ? `AND ARRAY_CONTAINS('${industries.find((i: any) => i.INDUSTRY === selectedIndustry)?.PA || ''}'::VARIANT, ALTERNATE)` : ''}
       LIMIT 200`
    : `SELECT NAME, CATEGORY, ST_X(GEOMETRY) AS LNG, ST_Y(GEOMETRY) AS LAT FROM PLACES WHERE REGION = '${regionName}' LIMIT 200`;

  const { data: places, loading: placesLoading } = useSfQuery(placesQuery, sourceDb, sourceSchema, [centerCoords, radius, selectedIndustry, regionName]);

  const { data: jobTemplates } = useSfQuery(
    `SELECT ID, SLOT_START, SLOT_END, SKILLS, PRODUCT, STATUS FROM JOB_TEMPLATE WHERE STATUS = 'active' AND REGION = '${regionName}' LIMIT 30`, sourceDb, sourceSchema, [regionName]);

  const geocodePlace = useCallback(async () => {
    if (!searchText.trim()) return;
    setGeocoding(true);
    try {
      const r = await query(
        `SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-sonnet-4-5',
          'Give me the latitude and longitude which centers the following place: ${searchText.replace(/'/g, "''")}. Return ONLY three comma-separated values: LATITUDE,LONGITUDE,ZOOM_LEVEL. Nothing else.') AS RESULT`);
      const parts = String(r[0]?.RESULT || '').trim().split(',').map((s: string) => parseFloat(s.trim()));
      if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        setCenterCoords({ lat: parts[0], lng: parts[1] });
      }
    } catch { /* ignore */ }
    setGeocoding(false);
  }, [searchText, query]);

  const previewCatchment = useCallback(async () => {
    if (!centerCoords) return;
    try {
      const r = await query(
        `SELECT GEOJSON AS GEO FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.ISOCHRONES_GEO(
          '${vehicles[0]?.profile || 'driving-car'}', ${centerCoords.lng}::FLOAT, ${centerCoords.lat}::FLOAT, ${isoMinutes}::INT))`,
        { database: 'OPENROUTESERVICE_NATIVE_APP', schema: 'CORE' });
      if (r[0]?.GEO) setCatchmentGeoJson(JSON.parse(r[0].GEO));
    } catch { /* ignore */ }
  }, [centerCoords, vehicles, isoMinutes, query]);

  const solveVRP = useCallback(async () => {
    if (!centerCoords || !places.length) return;
    setSolving(true);
    setVrpResult(null);
    setRoutePaths([]);
    try {
      const customerPlaces = places.slice(0, 50);
      const jobs = customerPlaces.map((p: any, i: number) => {
        const tmpl = jobTemplates[i % Math.max(jobTemplates.length, 1)] || { SLOT_START: 28800, SLOT_END: 64800, SKILLS: 1 };
        return {
          id: i + 1,
          location: [Number(p.LNG), Number(p.LAT)],
          service: 300,
          time_windows: [[Number(tmpl.SLOT_START), Number(tmpl.SLOT_END)]],
          skills: [Number(tmpl.SKILLS)],
        };
      });

      const vehArray = vehicles.map((v, i) => ({
        id: i + 1,
        profile: v.profile,
        start: [centerCoords.lng, centerCoords.lat],
        end: [centerCoords.lng, centerCoords.lat],
        capacity: [v.capacity],
        skills: v.skills,
        time_window: [v.startHour * 3600, v.endHour * 3600],
      }));

      const jobsJson = JSON.stringify(jobs).replace(/'/g, "''");
      const vehJson = JSON.stringify(vehArray).replace(/'/g, "''");

      const result = await query(
        `SELECT * FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.OPTIMIZATION(
          PARSE_JSON('${jobsJson}'), PARSE_JSON('${vehJson}')))`,
        { database: 'OPENROUTESERVICE_NATIVE_APP', schema: 'CORE' });

      if (result[0]) {
        const summary = result[0];
        setVrpResult(summary);

        const routes: any[] = [];
        if (summary.ROUTES) {
          const parsedRoutes = typeof summary.ROUTES === 'string' ? JSON.parse(summary.ROUTES) : summary.ROUTES;
          for (let ri = 0; ri < Math.min(parsedRoutes.length, 6); ri++) {
            const route = parsedRoutes[ri];
            if (route.steps && route.steps.length > 1) {
              const coords = route.steps.filter((s: any) => s.location).map((s: any) => s.location);
              if (coords.length > 1) {
                try {
                  const dirResult = await query(
                    `SELECT GEOJSON FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS_GEO(
                      '${route.vehicle_profile || vehicles[ri]?.profile || 'driving-car'}',
                      PARSE_JSON('${JSON.stringify({ coordinates: coords }).replace(/'/g, "''")}')::VARIANT))`,
                    { database: 'OPENROUTESERVICE_NATIVE_APP', schema: 'CORE' });
                  if (dirResult[0]?.GEOJSON) {
                    const geo = typeof dirResult[0].GEOJSON === 'string' ? JSON.parse(dirResult[0].GEOJSON) : dirResult[0].GEOJSON;
                    routes.push({ id: ri, path: geo.coordinates || coords, color: ROUTE_COLORS[ri % ROUTE_COLORS.length], stops: coords.length });
                  } else {
                    routes.push({ id: ri, path: coords, color: ROUTE_COLORS[ri % ROUTE_COLORS.length], stops: coords.length });
                  }
                } catch {
                  routes.push({ id: ri, path: coords, color: ROUTE_COLORS[ri % ROUTE_COLORS.length], stops: coords.length });
                }
              }
            }
          }
        }
        setRoutePaths(routes);
      }
    } catch (err) { console.error('VRP solve failed:', err); }
    setSolving(false);
  }, [centerCoords, places, vehicles, jobTemplates, query]);

  const layers = useMemo(() => {
    const l: any[] = [];

    if (catchmentGeoJson && !routePaths.length) {
      l.push(new GeoJsonLayer({
        id: 'catchment',
        data: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: catchmentGeoJson, properties: {} }] },
        filled: true, stroked: true,
        getFillColor: [41, 181, 232, 30], getLineColor: [41, 181, 232, 150], getLineWidth: 2, lineWidthMinPixels: 1,
      }));
    }

    if (routePaths.length) {
      routePaths.forEach(rp => {
        l.push(new PathLayer({
          id: `route-${rp.id}`, data: [{ path: rp.path }],
          getPath: (d: any) => d.path, getColor: rp.color, getWidth: 4, widthMinPixels: 2,
        }));
      });
    }

    if (places.length) {
      l.push(new ScatterplotLayer({
        id: 'places', data: places, pickable: true,
        getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)],
        getFillColor: [41, 181, 232, 140], getRadius: 50, radiusMinPixels: 3,
      }));
    }

    if (centerCoords) {
      l.push(new ScatterplotLayer({
        id: 'depot', data: [centerCoords], pickable: true,
        getPosition: (d: any) => [d.lng, d.lat],
        getFillColor: [255, 107, 53, 255], getLineColor: [255, 255, 255, 255],
        getRadius: 150, radiusMinPixels: 10, stroked: true, lineWidthMinPixels: 3,
      }));
    }

    return l;
  }, [places, routePaths, catchmentGeoJson, centerCoords]);

  const viewState = useMemo(() => {
    if (centerCoords) return { longitude: centerCoords.lng, latitude: centerCoords.lat, zoom: 12 };
    if (places.length) {
      const lngs = places.map((p: any) => Number(p.LNG));
      const lats = places.map((p: any) => Number(p.LAT));
      return { longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2, latitude: (Math.min(...lats) + Math.max(...lats)) / 2, zoom: 10 };
    }
    const ors = config?.ors?.bounds?.center;
    if (ors?.lng && ors?.lat) return { longitude: ors.lng, latitude: ors.lat, zoom: 10 };
    return { longitude: center.lng, latitude: center.lat, zoom };
  }, [centerCoords, places, config]);

  const updateVehicle = (idx: number, field: keyof VehicleConfig, value: any) => {
    setVehicles(prev => prev.map((v, i) => i === idx ? { ...v, [field]: value } : v));
  };

  return (
    <div className="page-full">
      <div className="page-sidebar-panel" style={{ overflowY: 'auto' }}>
        <h2>Route Optimization</h2>

        <div className="form-group">
          <label>Search Location</label>
          <div style={{ display: 'flex', gap: 4 }}>
            <input type="text" className="form-select" style={{ flex: 1 }} placeholder="e.g. San Francisco"
              value={searchText} onChange={e => setSearchText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && geocodePlace()} />
            <button onClick={geocodePlace} disabled={geocoding}
              style={{ padding: '4px 10px', background: '#29B5E8', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}>
              {geocoding ? '...' : 'Go'}
            </button>
          </div>
        </div>

        <div className="form-group" style={{ marginTop: 8 }}>
          <label>Radius ({radius} km)</label>
          <input type="range" min={1} max={100} value={radius} onChange={e => setRadius(Number(e.target.value))} style={{ width: '100%' }} />
        </div>

        {industries.length > 0 && (
          <div className="form-group" style={{ marginTop: 8 }}>
            <label>Industry</label>
            <select className="form-select" value={selectedIndustry || ''} onChange={e => setSelectedIndustry(e.target.value || null)}>
              <option value="">All Industries</option>
              {industries.map((ind: any) => <option key={ind.INDUSTRY} value={ind.INDUSTRY}>{ind.INDUSTRY}</option>)}
            </select>
          </div>
        )}

        <div className="metric-grid-vertical" style={{ marginTop: 12 }}>
          <MetricCard label="Places" value={placesLoading ? '...' : places.length} />
          <MetricCard label="Job Templates" value={jobTemplates.length} />
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ fontSize: 13 }}>Vehicles ({vehicles.length})</h3>
            <button onClick={() => setShowVehicles(!showVehicles)}
              style={{ fontSize: 10, background: 'none', border: '1px solid #E1E4E8', borderRadius: 4, padding: '2px 6px', cursor: 'pointer', color: '#6E7681' }}>
              {showVehicles ? 'Hide' : 'Configure'}
            </button>
          </div>
          {showVehicles && vehicles.map((v, i) => (
            <div key={i} style={{ marginTop: 8, padding: 8, background: 'rgba(41,181,232,0.04)', borderRadius: 6, borderLeft: `3px solid rgba(${ROUTE_COLORS[i % ROUTE_COLORS.length].join(',')})` }}>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Vehicle {i + 1}</div>
              <div className="form-group">
                <label style={{ fontSize: 10 }}>Profile</label>
                <select className="form-select" value={v.profile} onChange={e => updateVehicle(i, 'profile', e.target.value)}>
                  {profiles.map((p: string) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <div className="form-group" style={{ flex: 1 }}>
                  <label style={{ fontSize: 10 }}>Start ({v.startHour}:00)</label>
                  <input type="range" min={0} max={23} value={v.startHour} onChange={e => updateVehicle(i, 'startHour', Number(e.target.value))} style={{ width: '100%' }} />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label style={{ fontSize: 10 }}>End ({v.endHour}:00)</label>
                  <input type="range" min={1} max={24} value={v.endHour} onChange={e => updateVehicle(i, 'endHour', Number(e.target.value))} style={{ width: '100%' }} />
                </div>
              </div>
            </div>
          ))}
        </div>

        {centerCoords && (
          <div style={{ marginTop: 12, padding: 8, background: 'rgba(41,181,232,0.06)', borderRadius: 8 }}>
            <div className="form-group">
              <label>Catchment Preview ({isoMinutes} min)</label>
              <input type="range" min={5} max={60} step={5} value={isoMinutes} onChange={e => setIsoMinutes(Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <button onClick={previewCatchment}
              style={{ marginTop: 6, width: '100%', padding: '6px 12px', background: 'transparent', color: '#29B5E8', border: '1px solid #29B5E8', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}>
              Preview Catchment
            </button>
            <button onClick={solveVRP} disabled={solving}
              style={{ marginTop: 6, width: '100%', padding: '8px 12px', background: '#29B5E8', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
              {solving ? 'Solving...' : 'Optimize Routes'}
            </button>
          </div>
        )}

        {vrpResult && (
          <div style={{ marginTop: 12 }}>
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>Solution</h3>
            <div className="metric-grid-vertical">
              <MetricCard label="Routes" value={routePaths.length} />
              <MetricCard label="Total Stops" value={routePaths.reduce((s, r) => s + r.stops, 0)} />
            </div>
            {routePaths.map((rp, i) => (
              <div key={rp.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: `rgba(${rp.color.join(',')})` }} />
                <span style={{ fontSize: 11, color: '#6E7681' }}>Vehicle {rp.id + 1}: {rp.stops} stops</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <MapView layers={layers} initialViewState={viewState} />
    </div>
  );
}
