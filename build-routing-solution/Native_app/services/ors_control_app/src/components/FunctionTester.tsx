import { useState, useCallback, useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface CityOption {
  region: string;
  display_name?: string;
  isDefault?: boolean;
  bbox?: { min_lat: number; max_lat: number; min_lon: number; max_lon: number };
}

const FUNCTIONS = [
  { name: 'DIRECTIONS', sig: '(method, start, end)' },
  { name: 'DIRECTIONS_GEO', sig: '(method, start, end) → TABLE' },
  { name: 'ISOCHRONES', sig: '(method, lon, lat, range)' },
  { name: 'ISOCHRONES_GEO', sig: '(method, lon, lat, range) → TABLE' },
  { name: 'OPTIMIZATION', sig: '(jobs, vehicles)' },
  { name: 'OPTIMIZATION_GEO', sig: '(jobs, vehicles) → TABLE' },
  { name: 'MATRIX', sig: '(method, locations)' },
  { name: 'MATRIX_TABULAR', sig: '(method, origin, destinations)' },
  { name: 'ORS_STATUS', sig: '()' },
  { name: 'CHECK_HEALTH', sig: '() → BOOLEAN' },
];

function bboxCenter(bbox: CityOption['bbox']): [number, number] {
  if (!bbox) return [-122.4194, 37.7749];
  return [
    +((bbox.min_lon + bbox.max_lon) / 2).toFixed(4),
    +((bbox.min_lat + bbox.max_lat) / 2).toFixed(4),
  ];
}

function offsetPoint(center: [number, number], dlat: number, dlon: number): [number, number] {
  return [+(center[0] + dlon).toFixed(4), +(center[1] + dlat).toFixed(4)];
}

function fnPrefix(city: CityOption | null): string {
  if (!city || city.isDefault || city.region === 'default') return 'CORE';
  return 'CORE';
}

function fnSuffix(city: CityOption | null, baseName: string): string {
  if (!city || city.isDefault || city.region === 'default') return baseName;
  return `${baseName}_${city.region.toUpperCase()}`;
}

function generateSql(fnName: string, city: CityOption | null): string {
  const prefix = fnPrefix(city);
  const bbox = city?.bbox;
  const center = bboxCenter(bbox);
  const start = offsetPoint(center, -0.005, -0.005);
  const end = offsetPoint(center, 0.005, 0.005);
  const job1 = offsetPoint(center, -0.003, -0.003);
  const job2 = offsetPoint(center, 0.004, 0.004);
  const depot = offsetPoint(center, -0.008, 0.002);
  const dest2 = offsetPoint(center, 0.008, -0.003);

  const name = fnSuffix(city, fnName);

  switch (fnName) {
    case 'ORS_STATUS':
      return `SELECT ${prefix}.ORS_STATUS()`;
    case 'CHECK_HEALTH':
      return `SELECT ${prefix}.CHECK_HEALTH()`;
    case 'DIRECTIONS':
      return `SELECT ${prefix}.${name}('driving-car', ARRAY_CONSTRUCT(${start[0]}, ${start[1]}), ARRAY_CONSTRUCT(${end[0]}, ${end[1]}))`;
    case 'DIRECTIONS_GEO':
      return `SELECT * FROM TABLE(${prefix}.${name}('driving-car', ARRAY_CONSTRUCT(${start[0]}, ${start[1]}), ARRAY_CONSTRUCT(${end[0]}, ${end[1]})))`;
    case 'ISOCHRONES':
      return `SELECT ${prefix}.${name}('driving-car', ${center[0]}::FLOAT, ${center[1]}::FLOAT, 10)`;
    case 'ISOCHRONES_GEO':
      return `SELECT * FROM TABLE(${prefix}.${name}('driving-car', ${center[0]}::FLOAT, ${center[1]}::FLOAT, 10))`;
    case 'MATRIX':
      return `SELECT ${prefix}.${name}('driving-car', PARSE_JSON('[[${start[0]},${start[1]}],[${end[0]},${end[1]}]]'))`;
    case 'MATRIX_TABULAR':
      return `SELECT ${prefix}.${name}('driving-car', ARRAY_CONSTRUCT(${start[0]}, ${start[1]}), ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(${end[0]}, ${end[1]}), ARRAY_CONSTRUCT(${dest2[0]}, ${dest2[1]})))`;
    case 'OPTIMIZATION':
      return `SELECT ${prefix}.${name}(\n  ARRAY_CONSTRUCT(\n    OBJECT_CONSTRUCT('id', 1, 'location', ARRAY_CONSTRUCT(${job1[0]}, ${job1[1]})),\n    OBJECT_CONSTRUCT('id', 2, 'location', ARRAY_CONSTRUCT(${job2[0]}, ${job2[1]}))\n  ),\n  ARRAY_CONSTRUCT(\n    OBJECT_CONSTRUCT('id', 1, 'start', ARRAY_CONSTRUCT(${depot[0]}, ${depot[1]}), 'end', ARRAY_CONSTRUCT(${depot[0]}, ${depot[1]}))\n  )\n)`;
    case 'OPTIMIZATION_GEO':
      return `SELECT * FROM TABLE(${prefix}.${name}(\n  ARRAY_CONSTRUCT(\n    OBJECT_CONSTRUCT('id', 1, 'location', ARRAY_CONSTRUCT(${job1[0]}, ${job1[1]})),\n    OBJECT_CONSTRUCT('id', 2, 'location', ARRAY_CONSTRUCT(${job2[0]}, ${job2[1]}))\n  ),\n  ARRAY_CONSTRUCT(\n    OBJECT_CONSTRUCT('id', 1, 'start', ARRAY_CONSTRUCT(${depot[0]}, ${depot[1]}), 'end', ARRAY_CONSTRUCT(${depot[0]}, ${depot[1]}))\n  )\n))`;
    default:
      return '';
  }
}

function tryParseJson(val: any): any {
  if (typeof val === 'object' && val !== null) return val;
  if (typeof val !== 'string') return null;
  try { return JSON.parse(val); } catch { return null; }
}

function extractGeoJson(result: any): any[] {
  const features: any[] = [];
  if (!result || !Array.isArray(result)) return features;

  for (const row of result) {
    for (const [key, val] of Object.entries(row)) {
      const parsed = tryParseJson(val);
      if (!parsed) continue;

      if (key.toUpperCase() === 'GEOJSON' || key.toUpperCase() === 'GEO') {
        if (parsed.type === 'Feature') features.push(parsed);
        else if (parsed.type === 'FeatureCollection') features.push(...(parsed.features || []));
        else if (parsed.coordinates) features.push({ type: 'Feature', geometry: parsed, properties: {} });
        continue;
      }

      if (parsed.type === 'FeatureCollection' && parsed.features) {
        features.push(...parsed.features);
      } else if (parsed.type === 'Feature') {
        features.push(parsed);
      } else if (parsed.features && Array.isArray(parsed.features)) {
        features.push(...parsed.features);
      } else if (parsed.routes && Array.isArray(parsed.routes)) {
        for (const route of parsed.routes) {
          if (route.geometry) {
            const decoded = decodePolyline(route.geometry);
            if (decoded.length > 0) {
              features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: decoded }, properties: { distance: route.summary?.distance, duration: route.summary?.duration } });
            }
          }
        }
      } else if (parsed.steps && Array.isArray(parsed.steps)) {
        for (const step of parsed.steps) {
          if (step.geometry) {
            const decoded = decodePolyline(step.geometry);
            if (decoded.length > 0) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: decoded }, properties: {} });
          }
        }
      }
    }
  }
  return features;
}

function decodePolyline(encoded: string): [number, number][] {
  if (typeof encoded !== 'string') return [];
  const coords: [number, number][] = [];
  let index = 0, lat = 0, lng = 0;
  try {
    while (index < encoded.length) {
      let b, shift = 0, result = 0;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : (result >> 1);
      coords.push([lng / 1e5, lat / 1e5]);
    }
  } catch {}
  return coords;
}

function extractPoints(result: any): [number, number][] {
  const points: [number, number][] = [];
  if (!result || !Array.isArray(result)) return points;
  for (const row of result) {
    for (const val of Object.values(row)) {
      const parsed = tryParseJson(val);
      if (!parsed) continue;
      if (parsed.sources) {
        for (const s of parsed.sources) {
          if (s.location) points.push(s.location as [number, number]);
        }
      }
      if (parsed.destinations) {
        for (const d of parsed.destinations) {
          if (d.location) points.push(d.location as [number, number]);
        }
      }
    }
  }
  return points;
}

function ResultMap({ result, fnName }: { result: any; fnName: string }) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!mapRef.current) return;

    const features = extractGeoJson(result);
    const points = extractPoints(result);
    const hasGeo = features.length > 0 || points.length > 0;
    if (!hasGeo) return;

    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
    }

    const map = L.map(mapRef.current, { zoomControl: true });
    mapInstanceRef.current = map;

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OSM &copy; CARTO',
    }).addTo(map);

    const group = L.featureGroup().addTo(map);

    for (const feature of features) {
      try {
        const geom = feature.geometry;
        if (!geom) continue;

        if (geom.type === 'Point') {
          L.circleMarker([geom.coordinates[1], geom.coordinates[0]], { radius: 6, color: '#FF6B35', fillColor: '#FF6B35', fillOpacity: 0.8 }).addTo(group);
        } else if (geom.type === 'LineString') {
          const latlngs = geom.coordinates.map((c: number[]) => [c[1], c[0]] as [number, number]);
          L.polyline(latlngs, { color: '#FF6B35', weight: 4, opacity: 0.9 }).addTo(group);
          if (latlngs.length > 0) {
            L.circleMarker(latlngs[0], { radius: 7, color: '#30D158', fillColor: '#30D158', fillOpacity: 1 }).addTo(group);
            L.circleMarker(latlngs[latlngs.length - 1], { radius: 7, color: '#FF3B30', fillColor: '#FF3B30', fillOpacity: 1 }).addTo(group);
          }
        } else if (geom.type === 'MultiLineString') {
          for (const line of geom.coordinates) {
            const latlngs = line.map((c: number[]) => [c[1], c[0]] as [number, number]);
            L.polyline(latlngs, { color: '#FF6B35', weight: 4, opacity: 0.9 }).addTo(group);
          }
        } else if (geom.type === 'Polygon') {
          const latlngs = geom.coordinates[0].map((c: number[]) => [c[1], c[0]] as [number, number]);
          L.polygon(latlngs, { color: '#FF6B35', fillColor: '#FF6B35', fillOpacity: 0.25, weight: 2 }).addTo(group);
        } else if (geom.type === 'MultiPolygon') {
          for (const poly of geom.coordinates) {
            const latlngs = poly[0].map((c: number[]) => [c[1], c[0]] as [number, number]);
            L.polygon(latlngs, { color: '#FF6B35', fillColor: '#FF6B35', fillOpacity: 0.25, weight: 2 }).addTo(group);
          }
        }
      } catch {}
    }

    for (const pt of points) {
      L.circleMarker([pt[1], pt[0]], { radius: 5, color: '#FF9500', fillColor: '#FF9500', fillOpacity: 0.8 }).addTo(group);
    }

    if (group.getLayers().length > 0) {
      map.fitBounds(group.getBounds().pad(0.15));
    }

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, [result, fnName]);

  const features = extractGeoJson(result);
  const points = extractPoints(result);
  if (features.length === 0 && points.length === 0) return null;

  return (
    <div style={{ marginTop: 16 }}>
      <h3>Map</h3>
      <div ref={mapRef} style={{ height: 400, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden' }} />
    </div>
  );
}

export default function FunctionTester() {
  const [cities, setCities] = useState<CityOption[]>([]);
  const [selectedCity, setSelectedCity] = useState<CityOption | null>(null);
  const [selectedFn, setSelectedFn] = useState('ORS_STATUS');
  const [sqlInput, setSqlInput] = useState('SELECT CORE.ORS_STATUS()');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/cities');
        const data = await r.json();
        const cityList: CityOption[] = data.cities || [];
        setCities(cityList);
        const def = cityList.find((c) => c.isDefault) || cityList[0];
        if (def) {
          setSelectedCity(def);
          setSqlInput(generateSql('ORS_STATUS', def));
        }
      } catch {}
    })();
  }, []);

  const onCityChange = useCallback((region: string) => {
    const city = cities.find((c) => c.region === region) || null;
    setSelectedCity(city);
    setSqlInput(generateSql(selectedFn, city));
  }, [cities, selectedFn]);

  const onFnChange = useCallback((fnName: string) => {
    setSelectedFn(fnName);
    setSqlInput(generateSql(fnName, selectedCity));
  }, [selectedCity]);

  const executeQuery = useCallback(async () => {
    setRunning(true);
    setResult(null);
    setError(null);
    const start = Date.now();
    try {
      const resp = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: sqlInput }),
      });
      const data = await resp.json();
      setDuration(Date.now() - start);
      if (data.error) setError(data.error);
      else setResult(data.result);
    } catch (err: any) {
      setDuration(Date.now() - start);
      setError(err.message);
    }
    setRunning(false);
  }, [sqlInput]);

  return (
    <div className="panel">
      <h2>Function Tester</h2>
      <p className="subtitle">Test ORS routing functions against any provisioned city</p>

      <h3>City</h3>
      <select
        className="select"
        value={selectedCity?.region || ''}
        onChange={(e) => onCityChange(e.target.value)}
      >
        {cities.length === 0 && <option value="">Loading cities...</option>}
        {cities.map((c) => (
          <option key={c.region} value={c.region}>
            {c.display_name || c.region}
            {c.isDefault ? '' : ` (${c.region})`}
          </option>
        ))}
      </select>

      <h3>Function</h3>
      <div className="fn-grid">
        {FUNCTIONS.map((fn) => (
          <button
            key={fn.name}
            className={`fn-card ${selectedFn === fn.name ? 'active' : ''}`}
            onClick={() => onFnChange(fn.name)}
          >
            <div className="fn-name">{fn.name}</div>
            <div className="fn-sig">{fn.sig}</div>
          </button>
        ))}
      </div>

      <h3>SQL Query</h3>
      <textarea
        className="sql-editor"
        value={sqlInput}
        onChange={(e) => setSqlInput(e.target.value)}
        rows={Math.max(3, sqlInput.split('\n').length)}
        spellCheck={false}
      />
      <div className="action-row">
        <button className="btn primary" onClick={executeQuery} disabled={running || !sqlInput.trim()}>
          {running ? 'Running...' : 'Execute'}
        </button>
        {duration !== null && <span className="duration">{duration}ms</span>}
      </div>

      {error && (
        <div className="error-banner">
          <strong>Error:</strong> {error}
        </div>
      )}

      {result !== null && (
        <div className="result-panel">
          <h3>Result</h3>
          <pre className="result-json">{typeof result === 'string' ? result : JSON.stringify(result, null, 2)}</pre>
        </div>
      )}

      {result !== null && <ResultMap result={result} fnName={selectedFn} />}
    </div>
  );
}
