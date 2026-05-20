import { WebMercatorViewport } from '@deck.gl/core';

export type LngLat = [number, number];
export type Bounds = [[number, number], [number, number]];

export interface ViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch?: number;
  bearing?: number;
}

export interface Padding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export const DEFAULT_PADDING: Padding = { top: 40, bottom: 40, left: 40, right: 40 };
export const DEFAULT_MIN_ZOOM = 2;
export const DEFAULT_MAX_ZOOM = 16;
export const SINGLE_POINT_ZOOM = 14;

function isFiniteNum(n: any): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function isValidLngLat(c: any): c is LngLat {
  return Array.isArray(c) && c.length >= 2 && isFiniteNum(c[0]) && isFiniteNum(c[1]);
}

export function coordsFromPoints<T>(
  rows: T[] | null | undefined,
  getXY: (row: T) => [number, number] | { lng?: number; lat?: number; longitude?: number; latitude?: number } | null | undefined
): LngLat[] {
  if (!rows || !rows.length) return [];
  const out: LngLat[] = [];
  for (const r of rows) {
    const v = getXY(r);
    if (!v) continue;
    if (Array.isArray(v)) {
      if (isValidLngLat(v)) out.push([v[0], v[1]]);
    } else {
      const lng = (v as any).lng ?? (v as any).longitude;
      const lat = (v as any).lat ?? (v as any).latitude;
      if (isFiniteNum(lng) && isFiniteNum(lat)) out.push([lng, lat]);
    }
  }
  return out;
}

export function coordsFromPaths(paths: any): LngLat[] {
  if (!paths) return [];
  const out: LngLat[] = [];
  const arr = Array.isArray(paths) ? paths : [paths];
  for (const p of arr) {
    if (!p) continue;
    const path = Array.isArray(p) ? p : (p.path || p.coordinates);
    if (!Array.isArray(path)) continue;
    for (const pt of path) {
      if (isValidLngLat(pt)) out.push([pt[0], pt[1]]);
    }
  }
  return out;
}

function walkGeometry(geom: any, out: LngLat[]): void {
  if (!geom) return;
  const t = geom.type;
  const c = geom.coordinates;
  if (!t || !c) return;
  switch (t) {
    case 'Point':
      if (isValidLngLat(c)) out.push([c[0], c[1]]);
      break;
    case 'MultiPoint':
    case 'LineString':
      for (const pt of c) if (isValidLngLat(pt)) out.push([pt[0], pt[1]]);
      break;
    case 'MultiLineString':
    case 'Polygon':
      for (const ring of c) for (const pt of ring) if (isValidLngLat(pt)) out.push([pt[0], pt[1]]);
      break;
    case 'MultiPolygon':
      for (const poly of c) for (const ring of poly) for (const pt of ring) if (isValidLngLat(pt)) out.push([pt[0], pt[1]]);
      break;
    case 'GeometryCollection':
      if (Array.isArray(geom.geometries)) for (const g of geom.geometries) walkGeometry(g, out);
      break;
  }
}

export function coordsFromGeoJSON(input: any): LngLat[] {
  if (!input) return [];
  const out: LngLat[] = [];
  let value = input;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  const handle = (v: any) => {
    if (!v) return;
    if (v.type === 'FeatureCollection' && Array.isArray(v.features)) {
      for (const f of v.features) handle(f);
    } else if (v.type === 'Feature') {
      walkGeometry(v.geometry, out);
    } else if (v.type) {
      walkGeometry(v, out);
    } else if (Array.isArray(v)) {
      for (const item of v) handle(item);
    }
  };
  handle(value);
  return out;
}

export function boundsOf(coords: LngLat[] | null | undefined): Bounds | null {
  if (!coords || !coords.length) return null;
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const c of coords) {
    if (!isValidLngLat(c)) continue;
    if (c[0] < minLng) minLng = c[0];
    if (c[0] > maxLng) maxLng = c[0];
    if (c[1] < minLat) minLat = c[1];
    if (c[1] > maxLat) maxLat = c[1];
  }
  if (!isFiniteNum(minLng) || !isFiniteNum(minLat) || !isFiniteNum(maxLng) || !isFiniteNum(maxLat)) return null;
  return [[minLng, minLat], [maxLng, maxLat]];
}

export interface FitOptions {
  width: number;
  height: number;
  coords?: LngLat[] | null;
  bounds?: Bounds | null;
  padding?: Padding | number;
  minZoom?: number;
  maxZoom?: number;
  fallback?: ViewState;
}

function clampZoom(z: number, minZoom: number, maxZoom: number): number {
  if (!isFiniteNum(z)) return minZoom;
  return Math.max(minZoom, Math.min(maxZoom, z));
}

function normalizePadding(p: Padding | number | undefined): Padding {
  if (p == null) return DEFAULT_PADDING;
  if (typeof p === 'number') return { top: p, bottom: p, left: p, right: p };
  return p;
}

export function fitBoundsToData(opts: FitOptions): ViewState | null {
  const {
    width,
    height,
    coords,
    bounds: providedBounds,
    fallback = null,
    minZoom = DEFAULT_MIN_ZOOM,
    maxZoom = DEFAULT_MAX_ZOOM,
  } = opts;
  const padding = normalizePadding(opts.padding);

  if (!isFiniteNum(width) || !isFiniteNum(height) || width <= 0 || height <= 0) {
    return fallback;
  }

  const bounds = providedBounds ?? boundsOf(coords ?? []);
  if (!bounds) return fallback;

  const [[minLng, minLat], [maxLng, maxLat]] = bounds;
  const dLng = Math.abs(maxLng - minLng);
  const dLat = Math.abs(maxLat - minLat);

  if (dLng < 1e-9 && dLat < 1e-9) {
    return {
      longitude: minLng,
      latitude: minLat,
      zoom: clampZoom(SINGLE_POINT_ZOOM, minZoom, maxZoom),
      pitch: fallback?.pitch ?? 0,
      bearing: fallback?.bearing ?? 0,
    };
  }

  try {
    const vp = new WebMercatorViewport({ width, height });
    const fitted = vp.fitBounds(bounds as any, { padding: padding as any });
    return {
      longitude: fitted.longitude,
      latitude: fitted.latitude,
      zoom: clampZoom(fitted.zoom, minZoom, maxZoom),
      pitch: fallback?.pitch ?? 0,
      bearing: fallback?.bearing ?? 0,
    };
  } catch {
    return fallback;
  }
}

export function coordsSignature(coords: LngLat[] | null | undefined): string {
  if (!coords || !coords.length) return 'empty';
  const b = boundsOf(coords);
  if (!b) return 'empty';
  const [[a1, a2], [b1, b2]] = b;
  return `${coords.length}|${a1.toFixed(6)},${a2.toFixed(6)},${b1.toFixed(6)},${b2.toFixed(6)}`;
}
