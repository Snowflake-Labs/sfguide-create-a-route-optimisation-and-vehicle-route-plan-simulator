// Pure geometry helpers: coordinate extraction, bounds and change signatures.
//
// Split out of map-fit.ts so that reading geometry does not require a viewport.
// The two concerns are genuinely separate - nothing here needs to know how big
// the canvas is - and the split has a practical consequence: these helpers are
// now testable and reusable without loading @deck.gl/core, which under tsx pulls
// @luma.gl/shadertools through a path that resolves to its TypeScript source and
// fails to load at all. verify_map_spec.mts asserts against this module for that
// reason.
//
// Only runtime dependency: h3-js.

import { cellToBoundary, isValidCell } from 'h3-js';

export type LngLat = [number, number];
export type Bounds = [[number, number], [number, number]];

/**
 * Ceiling on a fit inset, as a share of the smaller viewport dimension. Lives
 * here with clampFitPadding so both are testable without a viewport.
 *
 * DEFAULT_PADDING is a flat 40px on each side because chrome drawn over the
 * canvas is a fixed size - a card border does not grow with the card. But on a
 * short canvas two 40px insets exceed the viewport, and measured against
 * deck.gl 9.2 that is not a cosmetic problem:
 *
 *   600x60,  pad 40 -> fitBounds THROWS (@math.gl/web-mercator assertion)
 *   600x90,  pad 40 -> zoom 1.145 for a 2-degree box (near-world)
 *   600x90,  pad 18 -> zoom 3.578
 *
 * The throw matters most. fitBoundsToData catches it and returns `fallback`, and
 * MapView deliberately passes no fallback (see map-view.tsx:229), so the camera
 * silently never fits - the same class of failure that comment is about. Inline
 * chat maps are the realistic case: they render into a far shorter box than a
 * dashboard area.
 */
export const MAX_PADDING_FRACTION = 0.2;

export interface Padding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export const DEFAULT_PADDING: Padding = { top: 40, bottom: 40, left: 40, right: 40 };

/**
 * Holds each inset under MAX_PADDING_FRACTION of the smaller dimension, so a
 * short canvas still fits its data instead of squeezing it into a band, or
 * failing to fit at all.
 */
export function clampFitPadding(p: Padding, width: number, height: number): Padding {
  const ceiling = Math.floor(Math.min(width, height) * MAX_PADDING_FRACTION);
  const clamp = (v: number) => Math.max(0, Math.min(isFiniteNum(v) ? v : 0, ceiling));
  return { top: clamp(p.top), bottom: clamp(p.bottom), left: clamp(p.left), right: clamp(p.right) };
}

/** Exported for map-fit, which shares the same notion of a usable number. */
export function isFiniteNum(n: any): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Coordinates come from arbitrary SQL results, so a column can hold nulls,
 * strings, or out-of-range numbers that would poison the bounds. Anything
 * unusable is skipped rather than clamped: clamping keeps a bad row in the
 * extent and drags the camera to a pole or the antimeridian, whereas skipping
 * lets the good rows frame themselves.
 *
 * The range test is deliberately part of validity rather than a separate pass,
 * so every extractor and boundsOf agree on what a coordinate is. No fleet
 * region crosses the antimeridian, so we never need a bound that continues
 * past +180.
 */
function isValidLngLat(c: any): c is LngLat {
  return (
    Array.isArray(c) &&
    c.length >= 2 &&
    isFiniteNum(c[0]) &&
    isFiniteNum(c[1]) &&
    c[0] >= -180 &&
    c[0] <= 180 &&
    c[1] >= -90 &&
    c[1] <= 90
  );
}

/** Range-checked scalar form of isValidLngLat, for lng/lat read as two values. */
function isInRange(lng: any, lat: any): boolean {
  return (
    isFiniteNum(lng) && isFiniteNum(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90
  );
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
      if (isInRange(lng, lat)) out.push([lng, lat]);
    }
  }
  return out;
}

/**
 * Vertices of one H3 cell as [lng, lat] pairs, or empty when the cell is not a
 * usable index.
 *
 * Validated with isValidCell rather than the previous `length < 15` heuristic.
 * That heuristic was not wrong so much as vacuous: every valid H3 index is 15
 * hex characters at every resolution (measured res 0, 1, 5, 9, 15), so it
 * rejected no valid cell and admitted any malformed 15-character string. Those
 * then reached cellToBoundary, which does throw for them, so the per-row
 * try/catch swallowed one exception per bad cell - correct output by way of
 * exception-driven control flow, at 9ms per 2000 bad cells versus 0ms for the
 * check. Validating says what is meant and keeps the catch for genuine surprises.
 *
 * The boundary is used rather than the centre so a single-cell map has real
 * span: a centre gives zero span, which the degenerate-bounds path then frames
 * at SINGLE_POINT_ZOOM, showing a fraction of a low-resolution hexagon.
 */
export function coordsFromH3Cell(cell: unknown): LngLat[] {
  if (typeof cell !== 'string' || !isValidCell(cell)) return [];
  const out: LngLat[] = [];
  try {
    for (const v of cellToBoundary(cell)) {
      // h3-js returns [lat, lng]; every consumer here is [lng, lat].
      if (isInRange(v[1], v[0])) out.push([v[1], v[0]]);
    }
  } catch {
    return [];
  }
  return out;
}

/**
 * Recursively pushes every [lng, lat] pair out of a nested GeoJSON coordinate
 * array. Every GeoJSON coordinate container bottoms out in coordinate pairs, so
 * recursing until a pair of numbers appears covers Point through MultiPolygon
 * uniformly - no per-geometry-type switch, and nothing to miss when a new type
 * turns up.
 *
 * Exported because the layer compiler needs the identical walk for its
 * already-parsed features: two independently written walkers is how the fit path
 * and the compile path drift apart on which coordinates count.
 */
export function pushCoordPairs(c: any, out: LngLat[]): void {
  if (!Array.isArray(c)) return;
  if (typeof c[0] === 'number' && typeof c[1] === 'number') {
    if (isInRange(c[0], c[1])) out.push([c[0], c[1]]);
    return;
  }
  for (const inner of c) pushCoordPairs(inner, out);
}

export function coordsFromH3Cells<T>(
  rows: T[] | null | undefined,
  getCell: (row: T) => string | null | undefined,
  opts: { sample?: number } = {}
): LngLat[] {
  if (!rows || !rows.length) return [];
  const out: LngLat[] = [];
  const sample = opts.sample ?? 2000;
  const stride = sample > 0 && rows.length > sample ? Math.ceil(rows.length / sample) : 1;
  for (let i = 0; i < rows.length; i += stride) {
    for (const c of coordsFromH3Cell(getCell(rows[i]))) out.push(c);
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

// The per-type switch this replaced enumerated Point through MultiPolygon by
// hand; the recursive walker covers all of them, so only GeometryCollection
// (which nests geometries rather than coordinates) needs its own branch.
function walkGeometry(geom: any, out: LngLat[]): void {
  if (!geom) return;
  if (geom.type === 'GeometryCollection') {
    if (Array.isArray(geom.geometries)) for (const g of geom.geometries) walkGeometry(g, out);
    return;
  }
  pushCoordPairs(geom.coordinates, out);
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

export function coordsSignature(coords: LngLat[] | null | undefined): string {
  if (!coords || !coords.length) return 'empty';
  const b = boundsOf(coords);
  if (!b) return 'empty';
  const [[a1, a2], [b1, b2]] = b;
  return `${coords.length}|${a1.toFixed(6)},${a2.toFixed(6)},${b1.toFixed(6)},${b2.toFixed(6)}`;
}
