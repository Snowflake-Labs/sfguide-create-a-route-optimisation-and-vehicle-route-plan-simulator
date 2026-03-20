import { useState, useCallback, useEffect, useMemo } from 'react';
import Map from 'react-map-gl/maplibre';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer, ScatterplotLayer } from '@deck.gl/layers';
import 'maplibre-gl/dist/maplibre-gl.css';

interface CityOption {
  region: string;
  display_name?: string;
  isDefault?: boolean;
  bbox?: { min_lat: number; max_lat: number; min_lon: number; max_lon: number };
}

const BASEMAP: any = {
  version: 8,
  sources: {
    'carto-light': {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
        'https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
      ],
      tileSize: 256,
      attribution: '&copy; OpenStreetMap &copy; CARTO',
    },
  },
  layers: [
    { id: 'carto-light-layer', type: 'raster', source: 'carto-light', minzoom: 0, maxzoom: 22 },
  ],
};

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

function fnSuffix(city: CityOption | null, baseName: string): string {
  if (!city || city.isDefault || city.region === 'default') return baseName;
  return `${baseName}_${city.region.toUpperCase()}`;
}

function generateSql(fnName: string, city: CityOption | null): string {
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
      return `SELECT CORE.ORS_STATUS()`;
    case 'CHECK_HEALTH':
      return `SELECT CORE.CHECK_HEALTH()`;
    case 'DIRECTIONS':
      return `SELECT CORE.${name}('driving-car', ARRAY_CONSTRUCT(${start[0]}, ${start[1]}), ARRAY_CONSTRUCT(${end[0]}, ${end[1]}))`;
    case 'DIRECTIONS_GEO':
      return `SELECT * FROM TABLE(CORE.${name}('driving-car', ARRAY_CONSTRUCT(${start[0]}, ${start[1]}), ARRAY_CONSTRUCT(${end[0]}, ${end[1]})))`;
    case 'ISOCHRONES':
      return `SELECT CORE.${name}('driving-car', ${center[0]}::FLOAT, ${center[1]}::FLOAT, 10)`;
    case 'ISOCHRONES_GEO':
      return `SELECT * FROM TABLE(CORE.${name}('driving-car', ${center[0]}::FLOAT, ${center[1]}::FLOAT, 10))`;
    case 'MATRIX':
      return `SELECT CORE.${name}('driving-car', PARSE_JSON('[[${start[0]},${start[1]}],[${end[0]},${end[1]}]]'))`;
    case 'MATRIX_TABULAR':
      return `SELECT CORE.${name}('driving-car', ARRAY_CONSTRUCT(${start[0]}, ${start[1]}), ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(${end[0]}, ${end[1]}), ARRAY_CONSTRUCT(${dest2[0]}, ${dest2[1]})))`;
    case 'OPTIMIZATION':
      return `SELECT CORE.${name}(\n  ARRAY_CONSTRUCT(\n    OBJECT_CONSTRUCT('id', 1, 'location', ARRAY_CONSTRUCT(${job1[0]}, ${job1[1]})),\n    OBJECT_CONSTRUCT('id', 2, 'location', ARRAY_CONSTRUCT(${job2[0]}, ${job2[1]}))\n  ),\n  ARRAY_CONSTRUCT(\n    OBJECT_CONSTRUCT('id', 1, 'start', ARRAY_CONSTRUCT(${depot[0]}, ${depot[1]}), 'end', ARRAY_CONSTRUCT(${depot[0]}, ${depot[1]}))\n  )\n)`;
    case 'OPTIMIZATION_GEO':
      return `SELECT * FROM TABLE(CORE.${name}(\n  ARRAY_CONSTRUCT(\n    OBJECT_CONSTRUCT('id', 1, 'location', ARRAY_CONSTRUCT(${job1[0]}, ${job1[1]})),\n    OBJECT_CONSTRUCT('id', 2, 'location', ARRAY_CONSTRUCT(${job2[0]}, ${job2[1]}))\n  ),\n  ARRAY_CONSTRUCT(\n    OBJECT_CONSTRUCT('id', 1, 'start', ARRAY_CONSTRUCT(${depot[0]}, ${depot[1]}), 'end', ARRAY_CONSTRUCT(${depot[0]}, ${depot[1]}))\n  )\n))`;
    default:
      return '';
  }
}

function tryParseJson(val: any): any {
  if (typeof val === 'object' && val !== null) return val;
  if (typeof val !== 'string') return null;
  try { return JSON.parse(val); } catch { return null; }
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

interface GeoData {
  geojson: any | null;
  points: [number, number][];
  center: [number, number] | null;
  zoom: number;
}

function extractGeoData(result: any): GeoData {
  const features: any[] = [];
  const points: [number, number][] = [];
  if (!result || !Array.isArray(result)) return { geojson: null, points: [], center: null, zoom: 12 };

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
      }

      if (parsed.routes && Array.isArray(parsed.routes)) {
        for (const route of parsed.routes) {
          if (route.geometry) {
            const decoded = decodePolyline(route.geometry);
            if (decoded.length > 0) {
              features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: decoded }, properties: { distance: route.summary?.distance, duration: route.summary?.duration } });
            }
          }
        }
      }

      if (parsed.steps && Array.isArray(parsed.steps)) {
        for (const step of parsed.steps) {
          if (step.geometry) {
            const decoded = decodePolyline(step.geometry);
            if (decoded.length > 0) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: decoded }, properties: {} });
          }
        }
      }

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

  if (features.length === 0 && points.length === 0) return { geojson: null, points: [], center: null, zoom: 12 };

  const allCoords: [number, number][] = [...points];
  for (const f of features) {
    const geom = f.geometry;
    if (!geom) continue;
    if (geom.type === 'Point') allCoords.push(geom.coordinates);
    else if (geom.type === 'LineString') allCoords.push(...geom.coordinates);
    else if (geom.type === 'MultiLineString') geom.coordinates.forEach((l: any) => allCoords.push(...l));
    else if (geom.type === 'Polygon') allCoords.push(...geom.coordinates[0]);
    else if (geom.type === 'MultiPolygon') geom.coordinates.forEach((p: any) => allCoords.push(...p[0]));
  }

  let center: [number, number] | null = null;
  let zoom = 12;
  if (allCoords.length > 0) {
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lon, lat] of allCoords) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    center = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
    const dLon = maxLon - minLon;
    const dLat = maxLat - minLat;
    const span = Math.max(dLon, dLat);
    if (span > 1) zoom = 8;
    else if (span > 0.5) zoom = 9;
    else if (span > 0.1) zoom = 11;
    else if (span > 0.02) zoom = 13;
    else zoom = 14;
  }

  const geojson = features.length > 0 ? { type: 'FeatureCollection', features } : null;
  return { geojson, points, center, zoom };
}

function ResultMap({ result, fnName }: { result: any; fnName: string }) {
  const geo = useMemo(() => extractGeoData(result), [result]);
  const [viewState, setViewState] = useState({ longitude: -122.4194, latitude: 37.7749, zoom: 12, pitch: 0, bearing: 0 });

  useEffect(() => {
    if (geo.center) {
      setViewState((prev) => ({ ...prev, longitude: geo.center![0], latitude: geo.center![1], zoom: geo.zoom }));
    }
  }, [geo]);

  const geojsonLayer = useMemo(() => {
    if (!geo.geojson) return null;
    return new GeoJsonLayer({
      id: 'result-geojson',
      data: geo.geojson,
      pickable: true,
      stroked: true,
      filled: true,
      extruded: false,
      lineWidthMinPixels: 3,
      getLineColor: [255, 107, 53, 220],
      getFillColor: [255, 107, 53, 60],
      getLineWidth: 3,
      pointRadiusMinPixels: 6,
      getPointRadius: 80,
      pointType: 'circle',
    });
  }, [geo.geojson]);

  const startEndLayer = useMemo(() => {
    if (!geo.geojson) return null;
    const markers: { position: [number, number]; color: [number, number, number, number]; label: string }[] = [];
    for (const f of geo.geojson.features) {
      const geom = f.geometry;
      if (geom?.type === 'LineString' && geom.coordinates.length > 1) {
        markers.push({ position: geom.coordinates[0], color: [48, 209, 88, 255], label: 'Start' });
        markers.push({ position: geom.coordinates[geom.coordinates.length - 1], color: [255, 59, 48, 255], label: 'End' });
      }
    }
    if (markers.length === 0) return null;
    return new ScatterplotLayer({
      id: 'start-end-markers',
      data: markers,
      pickable: true,
      getPosition: (d: any) => d.position,
      getFillColor: (d: any) => d.color,
      getLineColor: [255, 255, 255, 200],
      getRadius: 80,
      radiusMinPixels: 7,
      radiusMaxPixels: 12,
      stroked: true,
      lineWidthMinPixels: 2,
    });
  }, [geo.geojson]);

  const pointsLayer = useMemo(() => {
    if (geo.points.length === 0) return null;
    return new ScatterplotLayer({
      id: 'matrix-points',
      data: geo.points.map((p) => ({ position: p })),
      pickable: true,
      getPosition: (d: any) => d.position,
      getFillColor: [255, 149, 0, 220],
      getLineColor: [255, 255, 255, 200],
      getRadius: 80,
      radiusMinPixels: 6,
      radiusMaxPixels: 10,
      stroked: true,
      lineWidthMinPixels: 2,
    });
  }, [geo.points]);

  const layers = useMemo(() => [geojsonLayer, startEndLayer, pointsLayer].filter(Boolean), [geojsonLayer, startEndLayer, pointsLayer]);

  if (!geo.geojson && geo.points.length === 0) return null;

  const getTooltip = ({ object, layer }: any) => {
    if (!object) return null;
    if (layer?.id === 'start-end-markers') {
      return { text: object.label, style: { background: '#14141f', color: '#e8e8f0', fontSize: '12px', padding: '4px 8px', borderRadius: '4px' } };
    }
    if (layer?.id === 'result-geojson' && object.properties) {
      const props = object.properties;
      const parts: string[] = [];
      if (props.distance) parts.push(`Distance: ${(props.distance / 1000).toFixed(1)} km`);
      if (props.duration) parts.push(`Duration: ${(props.duration / 60).toFixed(1)} min`);
      if (props.value) parts.push(`Range: ${props.value} min`);
      if (parts.length === 0) return null;
      return { text: parts.join('\n'), style: { background: '#14141f', color: '#e8e8f0', fontSize: '12px', padding: '6px 10px', borderRadius: '4px', whiteSpace: 'pre-line' } };
    }
    return null;
  };

  return (
    <div style={{ marginTop: 16 }}>
      <h3>Map</h3>
      <div style={{ height: 450, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative' }}>
        <DeckGL
          viewState={viewState}
          onViewStateChange={({ viewState: vs }: any) => setViewState(vs)}
          controller={true}
          layers={layers}
          getTooltip={getTooltip}
        >
          <Map mapStyle={BASEMAP} />
        </DeckGL>
      </div>
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
