import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer, ScatterplotLayer, BitmapLayer, PathLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { samplePoints, COORD_FUNCTIONS, type BBox, type SampledPoints } from './samplePoints';

export interface RegionOption {
  region: string;
  display_name?: string;
  isDefault?: boolean;
  bbox?: { min_lat: number; max_lat: number; min_lon: number; max_lon: number };
  // Boundary GeoJSON parsed from REGION_CATALOG.BOUNDARY (via /api/regions).
  // When present, samplePoints uses rejection sampling against the polygon
  // instead of bbox - dramatically reduces ORS PointNotFound for water-bordered
  // regions and shows the real region shape on the map.
  boundaryGeoJson?: any | null;
}

export const CARTO_LIGHT = '/api/tiles/{z}/{x}/{y}';

export const OPTIMIZATION_PALETTE: [number, number, number, number][] = [
  [59, 130, 246, 230],
  [16, 185, 129, 230],
  [244, 114, 182, 230],
];

export function cartoBasemap() {
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

export const PROFILE_LABELS: Record<string, string> = {
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

export const FUNCTIONS = [
  { name: 'DIRECTIONS', sig: '(method, start, end [, region]) → TABLE' },
  { name: 'ISOCHRONES', sig: '(method, lon, lat, range [, region]) → TABLE' },
  { name: 'OPTIMIZATION', sig: '(jobs, vehicles [, matrices, region]) → TABLE' },
  { name: 'MATRIX', sig: '(method, locations [, region])' },
  { name: 'MATRIX_TABULAR', sig: '(method, origin, destinations [, region])' },
  { name: 'ORS_STATUS', sig: '([region])' },
  { name: 'CHECK_HEALTH', sig: '() → BOOLEAN' },
  { name: 'LIST_REGIONS', sig: '() → VARCHAR' },
];

export function bboxCenter(bbox: RegionOption['bbox']): [number, number] {
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

export function offsetPoint(center: [number, number], dlat: number, dlon: number): [number, number] {
  return [+(center[0] + dlon).toFixed(4), +(center[1] + dlat).toFixed(4)];
}

export function isoRangeFor(profile: string): number {
  // ISOCHRONES range parameter is in MINUTES (gateway multiplies by 60 internally).
  // ORS engine max is ~60 minutes for time-based isochrones.
  if (profile.startsWith('driving')) return 15;
  if (profile.startsWith('cycling')) return 20;
  return 30;
}

export function isProvisionedRegion(r: RegionOption | null): boolean {
  return !!(r && r.region);
}

export function generateSql(fnName: string, region: RegionOption | null, profile: string = 'driving-car', db: string = '', sampledPoints?: SampledPoints | null): string {
  const bbox = region?.bbox;
  const rg = region?.region ? `'${region.region}'` : 'NULL::VARCHAR';
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
      return `SELECT * FROM TABLE(${p}.ISOCHRONES('${profile}', ${isoPoint![0]}::FLOAT, ${isoPoint![1]}::FLOAT, ${isoRangeFor(profile)}, ${rg}))`;
    case 'MATRIX':
      return `SELECT ${p}.MATRIX('${profile}', PARSE_JSON('[[${start![0]},${start![1]}],[${end![0]},${end![1]}],[${dest2![0]},${dest2![1]}]]'), ${rg})`;
    case 'MATRIX_TABULAR':
      return `SELECT ${p}.MATRIX_TABULAR('${profile}', ARRAY_CONSTRUCT(${start![0]}, ${start![1]}), ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(${end![0]}, ${end![1]}), ARRAY_CONSTRUCT(${dest2![0]}, ${dest2![1]})), ${rg})`;
    case 'OPTIMIZATION': {
      const hasSampled = !!(sampledPoints && sampledPoints.points.length >= 2);
      const rawJobs = hasSampled ? sampledPoints!.points.slice(1) : [job1!, job2!];
      const jobs: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        jobs.push(rawJobs[i] || rawJobs[rawJobs.length - 1] || depot!);
      }
      const jobEntries = jobs.map((j, i) =>
        `    OBJECT_CONSTRUCT('id', ${i + 1}, 'location', ARRAY_CONSTRUCT(${j[0]}, ${j[1]}))`
      ).join(',\n');
      const numVehicles = 3;
      const maxTasks = Math.ceil(jobs.length / numVehicles);
      const vehicleEntries = [1, 2, 3].map(vid =>
        `    OBJECT_CONSTRUCT('id', ${vid}, 'start', ARRAY_CONSTRUCT(${depot![0]}, ${depot![1]}), 'end', ARRAY_CONSTRUCT(${depot![0]}, ${depot![1]}), 'max_tasks', ${maxTasks})`
      ).join(',\n');
      return `SELECT * FROM TABLE(${p}.OPTIMIZATION(\n  ARRAY_CONSTRUCT(\n${jobEntries}\n  ),\n  ARRAY_CONSTRUCT(\n${vehicleEntries}\n  ),\n  [], ${rg}\n))`;
    }
    default:
      return '';
  }
}

export function tryParseJson(val: any): any {
  if (typeof val === 'object' && val !== null) return val;
  if (typeof val !== 'string') return null;
  try { return JSON.parse(val); } catch { return null; }
}

export function decodePolyline(encoded: string): [number, number][] {
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

export interface GeoData {
  geojson: any | null;
  points: [number, number][];
  center: [number, number] | null;
  zoom: number;
}

export function extractGeoData(result: any): GeoData {
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

export function parseMatrixResult(result: any): { sources: any[]; destinations: any[]; durations: number[][]; distances: number[][] } | null {
  const raw = result?.[0] ? Object.values(result[0])[0] : null;
  if (!raw) return null;
  const parsed = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
  if (!parsed?.durations && !parsed?.distances) return null;
  return { sources: parsed.sources || [], destinations: parsed.destinations || [], durations: parsed.durations || [], distances: parsed.distances || [] };
}

export interface OptimizationStop {
  position: [number, number];
  type: string;
  jobId?: number;
  order: number;
}
export interface OptimizationVehicle {
  vehicleId: number;
  path: [number, number][];
  stops: OptimizationStop[];
}
export interface OptimizationParsed {
  vehicles: OptimizationVehicle[];
  depot: [number, number] | null;
}

export function parseOptimizationResult(result: any): OptimizationParsed | null {
  if (!result || !Array.isArray(result) || result.length === 0) return null;
  const vehicles: OptimizationVehicle[] = [];
  let depot: [number, number] | null = null;
  for (const row of result) {
    const vehicleId = typeof row.VEHICLE === 'number' ? row.VEHICLE : (typeof row.vehicle === 'number' ? row.vehicle : vehicles.length + 1);
    let path: [number, number][] = [];
    const geo = tryParseJson(row.GEOJSON ?? row.geojson ?? row.GEO ?? row.geo);
    if (geo?.coordinates && Array.isArray(geo.coordinates)) {
      path = geo.coordinates as [number, number][];
    } else if (geo?.geometry?.coordinates) {
      path = geo.geometry.coordinates as [number, number][];
    }
    if (path.length === 0) {
      const resp = tryParseJson(row.RESPONSE ?? row.response);
      if (resp?.routes?.[0]?.geometry) {
        const g = resp.routes[0].geometry;
        if (typeof g === 'string') {
          path = decodePolyline(g);
        } else if (Array.isArray(g)) {
          path = g as [number, number][];
        }
      } else if (resp?.geometry) {
        const g = resp.geometry;
        if (typeof g === 'string') {
          path = decodePolyline(g);
        } else if (Array.isArray(g)) {
          path = g as [number, number][];
        }
      }
    }
    const stepsRaw = row.STEPS ?? row.steps;
    const stepsArr: any[] = Array.isArray(stepsRaw) ? stepsRaw : (() => { const p = tryParseJson(stepsRaw); return Array.isArray(p) ? p : []; })();
    const stops: OptimizationStop[] = [];
    stepsArr.forEach((step: any, idx: number) => {
      const loc = step.location;
      if (!Array.isArray(loc) || loc.length < 2) return;
      const position: [number, number] = [loc[0], loc[1]];
      if (step.type === 'start' || step.type === 'end') {
        if (!depot) depot = position;
        return;
      }
      stops.push({ position, type: step.type, jobId: step.job ?? step.id, order: idx });
    });
    vehicles.push({ vehicleId, path, stops });
  }
  if (vehicles.length === 0) return null;
  return { vehicles, depot };
}

export function travelTimeColor(t: number, maxT: number): [number, number, number, number] {
  const ratio = Math.min(t / maxT, 1);
  const r = Math.round(34 + (239 - 34) * ratio);
  const g = Math.round(197 - (197 - 68) * ratio);
  const b = Math.round(94 - (94 - 68) * ratio);
  return [r, g, b, 230];
}

export function parseIsochroneOrigin(sql: string): [number, number] | null {
  const m = sql.match(/ISOCHRONES\s*\(\s*'[^']+'\s*,\s*(-?\d+(?:\.\d+)?)\s*::\s*FLOAT\s*,\s*(-?\d+(?:\.\d+)?)\s*::\s*FLOAT/i);
  if (!m) return null;
  const lon = parseFloat(m[1]);
  const lat = parseFloat(m[2]);
  if (!isFinite(lon) || !isFinite(lat)) return null;
  return [lon, lat];
}
