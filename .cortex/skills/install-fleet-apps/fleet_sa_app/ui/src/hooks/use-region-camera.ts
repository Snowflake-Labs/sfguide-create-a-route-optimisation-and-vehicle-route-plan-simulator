'use client';

// Region camera extents: the bounding box of every registered region, so a map
// can frame the ACTIVE region the instant the context dropdown changes, without
// waiting for that region's layer data to arrive (and without falling back to
// world zoom when a view has no rows for the region at all).
//
// Why the bbox and not REGION_REGISTRY.ZOOM_LEVEL: ZOOM_LEVEL is seeded to 11
// for every region including continent-sized ones (Europe), so using it frames
// a country at city zoom. Deriving the zoom from the bbox via fitBoundsToData
// is correct at any region size.
//
// Why REGION_REGISTRY and not the ORS REGION_CATALOG boundary: the registry
// bbox already tracks the baked boundary envelope (verified equal per region),
// is a single small table, and carries no dependency on a routing service that
// may be suspended - a camera hint must never be able to fail that way.
//
// The query is issued at most ONCE per browser session and shared by every map
// instance via a module-level promise, so N maps cost one round trip.

import { useEffect, useState } from 'react';

export type RegionBounds = [number, number][];

interface RegionRow {
  region_name?: string;
  bbox_min_lon?: number | string | null;
  bbox_min_lat?: number | string | null;
  bbox_max_lon?: number | string | null;
  bbox_max_lat?: number | string | null;
}

const REGION_SQL =
  'SELECT REGION_NAME AS region_name, ' +
  'BBOX_MIN_LON AS bbox_min_lon, BBOX_MIN_LAT AS bbox_min_lat, ' +
  'BBOX_MAX_LON AS bbox_max_lon, BBOX_MAX_LAT AS bbox_max_lat ' +
  'FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY';

let cache: Promise<Map<string, RegionBounds>> | null = null;

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function loadRegionBounds(): Promise<Map<string, RegionBounds>> {
  const out = new Map<string, RegionBounds>();
  try {
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: REGION_SQL }),
    });
    if (!res.ok) return out;
    const body = (await res.json()) as { rows?: RegionRow[] };
    for (const r of body.rows ?? []) {
      const name = r.region_name;
      const minLon = num(r.bbox_min_lon);
      const minLat = num(r.bbox_min_lat);
      const maxLon = num(r.bbox_max_lon);
      const maxLat = num(r.bbox_max_lat);
      if (!name || minLon === null || minLat === null || maxLon === null || maxLat === null) continue;
      out.set(name.toUpperCase(), [
        [minLon, minLat],
        [maxLon, maxLat],
      ]);
    }
  } catch {
    /* non-fatal: maps keep their existing data-driven fit */
  }
  return out;
}

/**
 * Bounding-box corners for `region`, or null while unknown. Safe to call from
 * every map area - the underlying query is cached process-wide.
 */
export function useRegionCamera(region?: string | null): RegionBounds | null {
  const [bounds, setBounds] = useState<Map<string, RegionBounds> | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!cache) cache = loadRegionBounds();
    void cache.then((m) => {
      if (!cancelled) setBounds(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!region || !bounds) return null;
  return bounds.get(String(region).toUpperCase()) ?? null;
}
