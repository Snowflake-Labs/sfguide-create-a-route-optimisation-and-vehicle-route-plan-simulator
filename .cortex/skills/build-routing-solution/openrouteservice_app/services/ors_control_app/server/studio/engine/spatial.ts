// ----------------------------------------------------------------------------
// engine/spatial.ts - region-agnostic spatial-bin stratification helpers.
//
// Used by buildFleet (Layer 1: home_poi assignment) and pickDestination
// (Layer 2: destination pool) to spread synthetic data across the entire
// region polygon instead of inheriting Overture Maps' POI density bias
// (which heavily concentrates HGV/warehouse POIs in metros like the Ruhr,
// Bay Area, Ile-de-France, etc.).
//
// Bin size auto-derives from REGION_CATALOG.BOUNDARY_AREA_KM2 so a single
// code path serves all 5,194 regions in the catalog with no per-region
// branches.
// ----------------------------------------------------------------------------
import type { POI } from './types.js';

// Adaptive bin size based on region area. Aims for ~10-30 populated bins
// regardless of region scale (city → continent).
//
//   <    5,000 km^2  →  0.05 deg  (~5 km)   - cities, BBBike rectangles
//   <   50,000 km^2  →  0.15 deg  (~15 km)  - small states, Switzerland
//   <  250,000 km^2  →  0.3  deg  (~30 km)  - UK, Germany, mid US states
//   < 1,000,000 km^2  →  0.5  deg  (~55 km)  - California, France, Spain
//   >= 1,000,000 km^2 →  1.0  deg  (~110 km) - continental USA, EU
export function binDegForArea(areaKm2: number | null | undefined): number {
  if (areaKm2 == null || !Number.isFinite(areaKm2) || areaKm2 <= 0) return 0.3;
  if (areaKm2 < 5_000) return 0.05;
  if (areaKm2 < 50_000) return 0.15;
  if (areaKm2 < 250_000) return 0.3;
  if (areaKm2 < 1_000_000) return 0.5;
  return 1.0;
}

// Approximate bbox area in km^2 (latitude correction). Used as a fallback when
// REGION_CATALOG.BOUNDARY_AREA_KM2 is null (e.g. brand-new user-added region).
export function bboxAreaKm2(bbox: { min_lat: number; max_lat: number; min_lng: number; max_lng: number }): number {
  const latKm = (bbox.max_lat - bbox.min_lat) * 111.32;
  const meanLat = (bbox.min_lat + bbox.max_lat) / 2;
  const lngKm = (bbox.max_lng - bbox.min_lng) * 111.32 * Math.cos(meanLat * Math.PI / 180);
  return Math.max(0, latKm * lngKm);
}

export function binKey(lat: number, lng: number, binDeg: number): string {
  return `${Math.floor(lat / binDeg)}|${Math.floor(lng / binDeg)}`;
}

// Group POIs into spatial bins of size binDeg degrees. Returns Map<key, POI[]>.
// Region-agnostic - works identically for any region in REGION_CATALOG.
export function binPoisByLatLng(pois: POI[], binDeg: number): Map<string, POI[]> {
  const bins = new Map<string, POI[]>();
  for (const p of pois) {
    const key = binKey(p.lat, p.lng, binDeg);
    const list = bins.get(key);
    if (list) list.push(p);
    else bins.set(key, [p]);
  }
  return bins;
}

// Diagnostic helper for jobs.ts log output. Returns:
//   populated_bins  - number of bins with >= 1 POI/vehicle/point
//   top_bin_share   - max(count) / sum(count). < 0.25 is the validation goal.
//   median_per_bin  - median count per bin (interquartile if needed later).
export function spreadStats(items: { lat: number; lng: number }[], binDeg: number): {
  populated_bins: number;
  top_bin_share: number;
  median_per_bin: number;
} {
  if (items.length === 0) return { populated_bins: 0, top_bin_share: 0, median_per_bin: 0 };
  const counts = new Map<string, number>();
  for (const p of items) {
    const k = binKey(p.lat, p.lng, binDeg);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const arr = [...counts.values()].sort((a, b) => a - b);
  const total = arr.reduce((s, n) => s + n, 0);
  const top = arr[arr.length - 1];
  const mid = arr.length % 2 === 0
    ? (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2
    : arr[Math.floor(arr.length / 2)];
  return {
    populated_bins: arr.length,
    top_bin_share: total > 0 ? top / total : 0,
    median_per_bin: mid,
  };
}

// Pick a POI uniformly across populated spatial bins (round-robin over bin
// keys for fairness) and then uniformly within the chosen bin. When `min_bins`
// is not met (e.g. tiny regions like a single bbbike rectangle), falls back to
// uniform-over-pool to preserve current behavior. `index` is used by the
// fleet builder to do round-robin home assignment; pass a random integer for
// destination picking.
export function pickStratifiedPoi(
  bins: Map<string, POI[]>,
  index: number,
  rng: () => number,
  minBins: number,
): POI | null {
  if (bins.size === 0) return null;
  if (bins.size < minBins) {
    // Fall back to uniform-over-all-POIs (preserves current behaviour for
    // small regions where stratification would produce single-bin runs).
    const flat: POI[] = [];
    for (const arr of bins.values()) flat.push(...arr);
    if (flat.length === 0) return null;
    return flat[Math.floor(rng() * flat.length)];
  }
  const keys = [...bins.keys()];
  const key = keys[((index % keys.length) + keys.length) % keys.length];
  const list = bins.get(key)!;
  return list[Math.floor(rng() * list.length)];
}
