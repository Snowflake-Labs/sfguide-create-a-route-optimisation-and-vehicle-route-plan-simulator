import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer, ScatterplotLayer, BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { samplePoints, COORD_FUNCTIONS, type BBox, type SampledPoints } from './function-tester/samplePoints';

interface RegionOption {
  region: string;
  display_name?: string;
  isDefault?: boolean;
  bbox?: { min_lat: number; max_lat: number; min_lon: number; max_lon: number };
}

const CARTO_LIGHT = '/api/tiles/{z}/{x}/{y}';

function cartoBasemap() {
  return new TileLayer({
    id: 'carto-basemap',
    data: CARTO_LIGHT,
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    renderSubLayers: (props: any) => {
      const { boundingBox } = props.tile;
      return new BitmapLayer(props, {
        data: undefined,
        image: props.data,
        bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]],
      });
    },
  });
}

const PROFILE_LABELS: Record<string, string> = {
  'driving-car': 'Car',
  'driving-hgv': 'Truck (HGV)',
  'cycling-regular': 'Cycling',
  'cycling-road': 'Cycling (Road)',
  'cycling-mountain': 'Cycling (Mountain)',
  'cycling-electric': 'Cycling (E-Bike)',
  'foot-walking': 'Walking',
  'foot-hiking': 'Hiking',
  'wheelchair': 'Wheelchair',
};

const FUNCTIONS = [
  { name: 'DIRECTIONS', sig: '(method, start, end [, region]) → TABLE' },
  { name: 'ISOCHRONES', sig: '(method, lon, lat, range [, region]) → TABLE' },
  { name: 'OPTIMIZATION', sig: '(jobs, vehicles [, matrices, region]) → TABLE' },
  { name: 'MATRIX', sig: '(method, locations [, region])' },
  { name: 'MATRIX_TABULAR', sig: '(method, origin, destinations [, region])' },
  { name: 'ORS_STATUS', sig: '([region])' },
  { name: 'CHECK_HEALTH', sig: '() → BOOLEAN' },
  { name: 'LIST_REGIONS', sig: '() → VARCHAR' },
];

function bboxCenter(bbox: RegionOption['bbox']): [number, number] {
  if (!bbox || bbox.min_lat == null || bbox.max_lat == null || bbox.min_lon == null || bbox.max_lon == null) {
    return [0, 0];
  }
  if (bbox.min_lat === 0 && bbox.max_lat === 0 && bbox.min_lon === 0 && bbox.max_lon === 0) {
    return [0, 0];
  }
  return [
    +((bbox.min_lon + bbox.max_lon) / 2).toFixed(4),
    +((bbox.min_lat + bbox.max_lat) / 2).toFixed(4),
  ];
}

function offsetPoint(center: [number, number], dlat: number, dlon: number): [number, number] {
  return [+(center[0] + dlon).toFixed(4), +(center[1] + dlat).toFixed(4)];
}

function isProvisionedRegion(r: RegionOption | null): boolean {
  return !!(r && !r.isDefault && r.region !== 'default');
}

function generateSql(fnName: string, region: RegionOption | null, profile: string = 'driving-car', db: string = '', sampledPoints?: SampledPoints | null): string {
  const bbox = region?.bbox;
  const rg = isProvisionedRegion(region) ? `'${region!.region}'` : 'NULL::VARCHAR';
  const p = db ? `${db}.CORE` : 'CORE';

  let start: [number, number], end: [number, number], job1: [number, number], job2: [number, number], depot: [number, number], dest2: [number, number];
  let isoPoint: [number, number];

  if (sampledPoints && sampledPoints.points.length > 0) {
    const pts = sampledPoints.points;
    switch (fnName) {
      case 'DIRECTIONS':
        start = pts[0];
        end = pts[1] || pts[0];
        break;
      case 'ISOCHRONES':
        isoPoint = pts[0];
        break;
      case 'MATRIX':
        start = pts[0];
        end = pts[1] || pts[0];
        dest2 = pts[2] || pts[0];
        break;
      case 'MATRIX_TABULAR':
        start = pts[0];
        end = pts[1] || pts[0];
        dest2 = pts[2] || pts[0];
        break;
      case 'OPTIMIZATION':
        depot = pts[0];
        job1 = pts[1] || pts[0];
        job2 = pts[2] || pts[0];
        break;
    }
  } else {
    const center = bboxCenter(bbox);
    start = offsetPoint(center, -0.005, -0.005);
    end = offsetPoint(center, 0.005, 0.005);
    job1 = offsetPoint(center, -0.003, -0.003);
    job2 = offsetPoint(center, 0.004, 0.004);
    depot = offsetPoint(center, -0.008, 0.002);
    dest2 = offsetPoint(center, 0.008, -0.003);
    isoPoint = center;
  }

  switch (fnName) {
    case 'LIST_REGIONS':
      return `CALL ${p}.LIST_REGIONS()`;
    case 'ORS_STATUS':
      return `SELECT ${p}.ORS_STATUS(${rg})`;
    case 'CHECK_HEALTH':
      return `SELECT ${p}.CHECK_HEALTH()`;
    case 'DIRECTIONS':
      return `SELECT * FROM TABLE(${p}.DIRECTIONS('${profile}', ARRAY_CONSTRUCT(${start![0]}, ${start![1]}), ARRAY_CONSTRUCT(${end![0]}, ${end![1]}), ${rg}))`;
    case 'ISOCHRONES':
      return `SELECT * FROM TABLE(${p}.ISOCHRONES('${profile}', ${isoPoint![0]}::FLOAT, ${isoPoint![1]}::FLOAT, 10, ${rg}))`;
    case 'MATRIX':
      return `SELECT ${p}.MATRIX('${profile}', PARSE_JSON('[[${start![0]},${start![1]}],[${end![0]},${end![1]}],[${dest2![0]},${dest2![1]}]]'), ${rg})`;
    case 'MATRIX_TABULAR':
      return `SELECT ${p}.MATRIX_TABULAR('${profile}', ARRAY_CONSTRUCT(${start![0]}, ${start![1]}), ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(${end![0]}, ${end![1]}), ARRAY_CONSTRUCT(${dest2![0]}, ${dest2![1]})), ${rg})`;
    case 'OPTIMIZATION': {
      const jobs = sampledPoints && sampledPoints.points.length >= 5
        ? sampledPoints.points.slice(1)
        : [job1!, job2!];
      const jobEntries = jobs.map((j, i) =>
        `    OBJECT_CONSTRUCT('id', ${i + 1}, 'location', ARRAY_CONSTRUCT(${j[0]}, ${j[1]}))`
      ).join(',\n');
      return `SELECT * FROM TABLE(${p}.OPTIMIZATION(\n  ARRAY_CONSTRUCT(\n${jobEntries}\n  ),\n  ARRAY_CONSTRUCT(\n    OBJECT_CONSTRUCT('id', 1, 'start', ARRAY_CONSTRUCT(${depot![0]}, ${depot![1]}), 'end', ARRAY_CONSTRUCT(${depot![0]}, ${depot![1]}))\n  ),\n  [], ${rg}\n))`;
    }
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

function parseMatrixResult(result: any): { sources: any[]; destinations: any[]; durations: number[][]; distances: number[][] } | null {
  const raw = result?.[0] ? Object.values(result[0])[0] : null;
  if (!raw) return null;
  const parsed = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
  if (!parsed?.durations && !parsed?.distances) return null;
  return { sources: parsed.sources || [], destinations: parsed.destinations || [], durations: parsed.durations || [], distances: parsed.distances || [] };
}

function travelTimeColor(t: number, maxT: number): [number, number, number, number] {
  const ratio = Math.min(t / maxT, 1);
  const r = Math.round(34 + (239 - 34) * ratio);
  const g = Math.round(197 - (197 - 68) * ratio);
  const b = Math.round(94 - (94 - 68) * ratio);
  return [r, g, b, 230];
}

function ResultMap({ result, fnName, regionCenter }: { result: any; fnName: string; regionCenter: [number, number] }) {
  const geo = useMemo(() => extractGeoData(result), [result]);
  const matrix = useMemo(() => (fnName === 'MATRIX' || fnName === 'MATRIX_TABULAR') ? parseMatrixResult(result) : null, [result, fnName]);
  const [viewState, setViewState] = useState({ longitude: regionCenter[0], latitude: regionCenter[1], zoom: 12, pitch: 0, bearing: 0 });

  useEffect(() => {
    if (matrix && matrix.sources.length > 0) {
      const allPts = [...matrix.sources, ...matrix.destinations].filter(p => p.location);
      if (allPts.length > 0) {
        const lons = allPts.map((p: any) => p.location[0]);
        const lats = allPts.map((p: any) => p.location[1]);
        setViewState(prev => ({ ...prev, longitude: (Math.min(...lons) + Math.max(...lons)) / 2, latitude: (Math.min(...lats) + Math.max(...lats)) / 2, zoom: 12 }));
      }
    } else if (geo.center) {
      setViewState((prev) => ({ ...prev, longitude: geo.center![0], latitude: geo.center![1], zoom: geo.zoom }));
    }
  }, [geo, matrix]);

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

  const matrixLayers = useMemo(() => {
    if (!matrix) return [];
    const layers: any[] = [];
    const allDurations = matrix.durations.flat();
    const maxT = Math.max(...allDurations, 1);
    const destData = matrix.destinations
      .map((d: any, i: number) => ({
        position: d.location as [number, number],
        name: d.name || `Dest ${i + 1}`,
        duration: matrix.durations[0]?.[i] ?? 0,
        distance: matrix.distances[0]?.[i] ?? 0,
      }))
      .filter((d: any) => d.position);
    layers.push(new ScatterplotLayer({
      id: 'matrix-destinations',
      data: destData,
      pickable: true,
      getPosition: (d: any) => d.position,
      getFillColor: (d: any) => travelTimeColor(d.duration, maxT),
      getLineColor: [255, 255, 255, 200],
      getRadius: 120,
      radiusMinPixels: 10,
      radiusMaxPixels: 18,
      stroked: true,
      lineWidthMinPixels: 2,
    }));
    const srcData = matrix.sources.filter((s: any) => s.location).map((s: any) => ({ position: s.location as [number, number], name: s.name || 'Origin' }));
    layers.push(new ScatterplotLayer({
      id: 'matrix-origins',
      data: srcData,
      pickable: true,
      getPosition: (d: any) => d.position,
      getFillColor: [245, 158, 11, 255],
      getLineColor: [255, 255, 255, 255],
      getRadius: 140,
      radiusMinPixels: 12,
      radiusMaxPixels: 20,
      stroked: true,
      lineWidthMinPixels: 3,
    }));
    return layers;
  }, [matrix]);

  const basemap = useMemo(() => cartoBasemap(), []);
  const layers = useMemo(() => matrix
    ? [basemap, ...matrixLayers]
    : [basemap, geojsonLayer, startEndLayer, pointsLayer].filter(Boolean),
    [basemap, matrix, matrixLayers, geojsonLayer, startEndLayer, pointsLayer]);

  const hasGeo = !!(geo.geojson || geo.points.length > 0 || matrix);

  const getTooltip = ({ object, layer }: any) => {
    if (!object) return null;
    if (layer?.id === 'matrix-origins') return { text: object.name, style: { background: '#14141f', color: '#e8e8f0', fontSize: '12px', padding: '4px 8px', borderRadius: '4px' } };
    if (layer?.id === 'matrix-destinations') {
      return { text: `${object.name}\n${(object.duration / 60).toFixed(1)} min · ${(object.distance / 1000).toFixed(2)} km`, style: { background: '#14141f', color: '#e8e8f0', fontSize: '12px', padding: '6px 10px', borderRadius: '4px', whiteSpace: 'pre-line' } };
    }
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
      {!hasGeo && <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 8px' }}>No spatial data to display. Run a geo function to see results on the map.</p>}
      {matrix && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 12, alignItems: 'center' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 12, borderRadius: '50%', background: 'rgb(245,158,11)', display: 'inline-block' }} /> Origin</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 12, borderRadius: '50%', background: 'rgb(34,197,94)', display: 'inline-block' }} /> Fast</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 12, borderRadius: '50%', background: 'rgb(239,68,68)', display: 'inline-block' }} /> Slow</span>
        </div>
      )}
      <div style={{ height: 450, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
        <DeckGL
          viewState={viewState}
          onViewStateChange={({ viewState: vs }: any) => setViewState(vs)}
          controller={true}
          layers={layers}
          getTooltip={getTooltip}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    </div>
  );
}

async function fetchRoadPoints(bbox: BBox, profile: string): Promise<[number, number][] | null> {
  try {
    const params = new URLSearchParams({
      min_lat: bbox.min_lat.toString(),
      max_lat: bbox.max_lat.toString(),
      min_lon: bbox.min_lon.toString(),
      max_lon: bbox.max_lon.toString(),
      limit: '50',
      profile,
    });
    const resp = await fetch(`/api/sample-road-points?${params}`);
    const data = await resp.json();
    if (data.ok && data.points?.length > 0) return data.points;
    return null;
  } catch {
    return null;
  }
}

export default function FunctionTester() {
  const [regions, setRegions] = useState<RegionOption[]>([]);
  const [selectedRegion, setSelectedRegion] = useState<RegionOption | null>(null);
  const [regionsLoading, setRegionsLoading] = useState(true);
  const [regionsError, setRegionsError] = useState<string | null>(null);
  const [selectedFn, setSelectedFn] = useState('ORS_STATUS');
  const [selectedProfile, setSelectedProfile] = useState('driving-car');
  const [availableProfiles, setAvailableProfiles] = useState<string[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [sfDatabase, setSfDatabase] = useState('');
  const [sqlInput, setSqlInput] = useState('SELECT CORE.ORS_STATUS()');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [roadPoints, setRoadPoints] = useState<[number, number][] | null>(null);
  const [overtureAvailable, setOvertureAvailable] = useState<boolean | null>(null);
  const [sampleHint, setSampleHint] = useState<string | null>(null);
  const userEditedRef = useRef(false);

  const regeneratePoints = useCallback((fnName: string, region: RegionOption | null, profile: string, db: string, roads?: [number, number][] | null) => {
    if (!COORD_FUNCTIONS.includes(fnName)) {
      setSampleHint(null);
      setSqlInput(generateSql(fnName, region, profile, db, null));
      return;
    }
    const bbox = region?.bbox;
    if (!bbox || (bbox.min_lat === 0 && bbox.max_lat === 0 && bbox.min_lon === 0 && bbox.max_lon === 0)) {
      setSampleHint(null);
      setSqlInput(generateSql(fnName, region, profile, db, null));
      return;
    }
    const sampled = samplePoints({ fnName, bbox, profile, roadPoints: roads || undefined });
    setSampleHint(sampled?.hint || null);
    setSqlInput(generateSql(fnName, region, profile, db, sampled));
    userEditedRef.current = false;
  }, []);

  useEffect(() => {
    (async () => {
      let db = '';
      try {
        const cr = await fetch('/api/config');
        const cfg = await cr.json();
        db = cfg.database || '';
        setSfDatabase(db);
      } catch {}

      let probeOvertureOk = false;
      try {
        const probeResp = await fetch('/api/diagnostics/probe');
        const probeData = await probeResp.json();
        probeOvertureOk = probeData.overtureTransportation?.ok === true;
        setOvertureAvailable(probeOvertureOk);
      } catch {
        setOvertureAvailable(false);
      }

      try {
        const r = await fetch('/api/regions/provisioned');
        const data = await r.json();
        if (data.error) setRegionsError(data.error);
        const regionList: RegionOption[] = data.regions || [];
        setRegions(regionList);
        const def = regionList.find((c) => c.isDefault) || regionList[0];
        if (def) {
          setSelectedRegion(def);
          let roads: [number, number][] | null = null;
          if (probeOvertureOk && def.bbox) {
            roads = await fetchRoadPoints(def.bbox, 'driving-car');
            setRoadPoints(roads);
          }
          setSqlInput(generateSql('ORS_STATUS', def, 'driving-car', db));
        }
      } catch (err: any) {
        setRegionsError(err.message || 'Failed to load regions');
      }
      setRegionsLoading(false);
    })();
  }, []);

  const fetchProfiles = useCallback(async (region: RegionOption | null) => {
    setProfilesLoading(true);
    try {
      const pfx = sfDatabase ? `${sfDatabase}.CORE` : 'CORE';
      const rg = isProvisionedRegion(region) ? `'${region!.region}'` : 'NULL::VARCHAR';
      const statusSql = `SELECT ${pfx}.ORS_STATUS(${rg})`;
      const resp = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: statusSql }),
      });
      const data = await resp.json();
      if (data.result?.[0]) {
        const raw = Object.values(data.result[0])[0];
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (parsed?.profiles && typeof parsed.profiles === 'object') {
          const names = Object.keys(parsed.profiles).filter((p: string) => parsed.profiles[p]?.encoder_name);
          if (names.length > 0) {
            setAvailableProfiles(names);
            if (!names.includes(selectedProfile)) {
              setSelectedProfile(names[0]);
              regeneratePoints(selectedFn, region, names[0], sfDatabase, roadPoints);
            }
            setProfilesLoading(false);
            return;
          }
        }
      }
    } catch {}
    setAvailableProfiles([]);
    setProfilesLoading(false);
  }, [selectedFn, selectedProfile, sfDatabase, roadPoints, regeneratePoints]);

  useEffect(() => {
    if (selectedRegion) fetchProfiles(selectedRegion);
  }, [selectedRegion]);

  const onRegionChange = useCallback(async (regionKey: string) => {
    const r = regions.find((c) => c.region === regionKey) || null;
    setSelectedRegion(r);
    userEditedRef.current = false;
    let roads: [number, number][] | null = null;
    if (overtureAvailable && r?.bbox) {
      roads = await fetchRoadPoints(r.bbox, selectedProfile);
      setRoadPoints(roads);
    }
    regeneratePoints(selectedFn, r, selectedProfile, sfDatabase, roads);
  }, [regions, selectedFn, selectedProfile, sfDatabase, overtureAvailable, regeneratePoints]);

  const onFnChange = useCallback((fnName: string) => {
    setSelectedFn(fnName);
    userEditedRef.current = false;
    regeneratePoints(fnName, selectedRegion, selectedProfile, sfDatabase, roadPoints);
  }, [selectedRegion, selectedProfile, sfDatabase, roadPoints, regeneratePoints]);

  const onProfileChange = useCallback(async (profile: string) => {
    setSelectedProfile(profile);
    userEditedRef.current = false;
    let roads: [number, number][] | null = roadPoints;
    if (overtureAvailable && selectedRegion?.bbox) {
      roads = await fetchRoadPoints(selectedRegion.bbox, profile);
      setRoadPoints(roads);
    }
    regeneratePoints(selectedFn, selectedRegion, profile, sfDatabase, roads);
  }, [selectedRegion, selectedFn, sfDatabase, roadPoints, overtureAvailable, regeneratePoints]);

  const handleReshuffle = useCallback(() => {
    userEditedRef.current = false;
    regeneratePoints(selectedFn, selectedRegion, selectedProfile, sfDatabase, roadPoints);
  }, [selectedFn, selectedRegion, selectedProfile, sfDatabase, roadPoints, regeneratePoints]);

  const handleSqlChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    userEditedRef.current = true;
    setSqlInput(e.target.value);
  }, []);

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
      <p className="subtitle">Test ORS routing functions against any provisioned region</p>

      <h3>Region</h3>
      <select
        className="select"
        value={selectedRegion?.region || ''}
        onChange={(e) => onRegionChange(e.target.value)}
      >
        {regionsLoading && <option value="">Loading regions...</option>}
        {!regionsLoading && regions.length === 0 && <option value="">No regions provisioned</option>}
        {regions.map((c) => (
          <option key={c.region} value={c.region}>
            {c.display_name || c.region}
            {c.isDefault ? '' : ` (${c.region})`}
          </option>
        ))}
      </select>
      {regionsError && (
        <p style={{ color: 'var(--error)', fontSize: 13, margin: '4px 0 0' }}>{regionsError}</p>
      )}
      {selectedRegion && (!selectedRegion.bbox || selectedRegion.bbox.min_lat == null) && (
        <p style={{ color: 'var(--warning, #f0ad4e)', fontSize: 13, margin: '4px 0 0' }}>
          Bounding box unavailable for this region. Coordinates in generated SQL may be incorrect.
        </p>
      )}

      <h3>Routing Profile</h3>
      <select
        className="select"
        value={selectedProfile}
        onChange={(e) => onProfileChange(e.target.value)}
        disabled={profilesLoading}
      >
        {profilesLoading && <option value="">Loading profiles...</option>}
        {!profilesLoading && availableProfiles.length === 0 && <option value="driving-car">driving-car</option>}
        {!profilesLoading && availableProfiles.map((p) => (
          <option key={p} value={p}>{PROFILE_LABELS[p] || p}</option>
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
        onChange={handleSqlChange}
        rows={Math.max(3, sqlInput.split('\n').length)}
        spellCheck={false}
      />
      {sampleHint && (
        <p style={{ color: 'var(--warning, #f0ad4e)', fontSize: 12, margin: '4px 0 0' }}>{sampleHint}</p>
      )}
      {overtureAvailable === false && COORD_FUNCTIONS.includes(selectedFn) && (
        <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '4px 0 0', fontStyle: 'italic' }}>
          Install Overture Maps Transportation for road-snapped sample points.
        </p>
      )}
      <div className="action-row">
        <button className="btn primary" onClick={executeQuery} disabled={running || !sqlInput.trim()}>
          {running ? 'Running...' : 'Execute'}
        </button>
        <button
          className="btn secondary"
          onClick={handleReshuffle}
          disabled={!COORD_FUNCTIONS.includes(selectedFn)}
          title="Generate new random sample points for this region and profile."
        >
          Reshuffle points
        </button>
        {duration !== null && <span className="duration">{duration}ms</span>}
      </div>

      {error && (
        <div className="error-banner">
          <strong>Error:</strong> {error}
        </div>
      )}

      {result !== null && <ResultMap result={result} fnName={selectedFn} regionCenter={bboxCenter(selectedRegion?.bbox)} />}

      {result !== null && (selectedFn === 'MATRIX' || selectedFn === 'MATRIX_TABULAR') && (() => {
        const raw = result?.[0] ? Object.values(result[0])[0] : null;
        const parsed = raw ? (typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw) : null;
        if (!parsed?.durations && !parsed?.distances) return null;
        const srcs: any[] = parsed.sources || [{ name: 'Origin' }];
        const dsts: any[] = parsed.destinations || [];
        const durations: number[][] = parsed.durations || [];
        const distances: number[][] = parsed.distances || [];
        const srcLabel = (s: any, i: number) => s.name || `[${s.location?.[0]?.toFixed(3)}, ${s.location?.[1]?.toFixed(3)}]` || `Origin ${i + 1}`;
        const dstLabel = (d: any, i: number) => d.name || `[${d.location?.[0]?.toFixed(3)}, ${d.location?.[1]?.toFixed(3)}]` || `Dest ${i + 1}`;
        const cellStyle = { padding: '6px 12px', border: '1px solid var(--border)', textAlign: 'right' as const };
        const headStyle = { padding: '6px 12px', background: 'var(--surface-alt)', border: '1px solid var(--border)', whiteSpace: 'nowrap' as const, fontWeight: 600 };
        return (
          <div className="result-panel" style={{ overflowX: 'auto' }}>
            <h3>Matrix Result</h3>
            {durations.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <h4 style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>Travel Time (minutes)</h4>
                <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr>
                    <th style={headStyle}>From \ To</th>
                    {dsts.map((d: any, i: number) => <th key={i} style={headStyle}>{dstLabel(d, i)}</th>)}
                  </tr></thead>
                  <tbody>{durations.map((row: number[], i: number) => (
                    <tr key={i}>
                      <td style={{ ...cellStyle, fontWeight: 600, textAlign: 'left' }}>{srcLabel(srcs[i], i)}</td>
                      {row.map((v: number, j: number) => <td key={j} style={cellStyle}>{(v / 60).toFixed(1)} min</td>)}
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            {distances.length > 0 && (
              <div>
                <h4 style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>Distance (km)</h4>
                <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr>
                    <th style={headStyle}>From \ To</th>
                    {dsts.map((d: any, i: number) => <th key={i} style={headStyle}>{dstLabel(d, i)}</th>)}
                  </tr></thead>
                  <tbody>{distances.map((row: number[], i: number) => (
                    <tr key={i}>
                      <td style={{ ...cellStyle, fontWeight: 600, textAlign: 'left' }}>{srcLabel(srcs[i], i)}</td>
                      {row.map((v: number, j: number) => <td key={j} style={cellStyle}>{(v / 1000).toFixed(2)} km</td>)}
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>
        );
      })()}

      {result !== null && selectedFn !== 'MATRIX' && selectedFn !== 'MATRIX_TABULAR' && (
        <div className="result-panel">
          <h3>Result</h3>
          <pre className="result-json">{typeof result === 'string' ? result : JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
      {result !== null && (selectedFn === 'MATRIX' || selectedFn === 'MATRIX_TABULAR') && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>Raw JSON</summary>
          <pre className="result-json" style={{ fontSize: 11 }}>{JSON.stringify(result, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
