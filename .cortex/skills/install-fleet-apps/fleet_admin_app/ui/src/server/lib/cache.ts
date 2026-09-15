// In-memory caches and small utility formatters used across route handlers.

const ROAD_POINTS_CACHE_TTL_MS = 5 * 60 * 1000;
const ROAD_POINTS_CACHE_MAX = 64;
const roadPointsCache = new Map<string, { ts: number; points: [number, number][] }>();

export function roadPointsCacheKey(
  minLat: number,
  maxLat: number,
  minLon: number,
  maxLon: number,
  profile: string,
): string {
  const r = (n: number) => n.toFixed(4);
  return `${r(minLat)}|${r(maxLat)}|${r(minLon)}|${r(maxLon)}|${profile}`;
}

export function roadPointsCacheGet(key: string): [number, number][] | null {
  const hit = roadPointsCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > ROAD_POINTS_CACHE_TTL_MS) {
    roadPointsCache.delete(key);
    return null;
  }
  return hit.points;
}

export function roadPointsCacheSet(key: string, points: [number, number][]): void {
  if (roadPointsCache.size >= ROAD_POINTS_CACHE_MAX) {
    const oldest = [...roadPointsCache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 16);
    for (const [k] of oldest) roadPointsCache.delete(k);
  }
  roadPointsCache.set(key, { ts: Date.now(), points });
}

// Land anchors per region, for the Function Tester road-point pool.
//
// Why a separate, longer-lived cache: the pool query must prefilter Overture
// SEGMENT on a SMALL bbox to prune partitions. A region bbox cannot do that -
// the US bbox is -180..180 by 15.9..73, so the old query scanned the planet and
// returned 41 points on 8-degree tiles, none of which are within the 15 km
// driving separation cap. Instead we draw a handful of land anchors ONCE per
// region and expand each into one small cell.
//
// Anchors depend only on the region polygon, not on profile or reshuffle, so
// they must NOT share the per-pool TTL: recomputing them per reshuffle would add
// a query per shuffle for no benefit. Region polygons only change when a region
// is re-provisioned, hence the long TTL.
const ANCHOR_CACHE_TTL_MS = 60 * 60 * 1000;
const ANCHOR_CACHE_MAX = 32;

export interface LandAnchor {
  lon: number;
  lat: number;
  cell: string;
  min_lon: number;
  max_lon: number;
  min_lat: number;
  max_lat: number;
}

const anchorCache = new Map<string, { ts: number; anchors: LandAnchor[] }>();

export function anchorCacheKey(region: string, boundarySource: string): string {
  return `${region}|${boundarySource}`;
}

export function anchorCacheGet(key: string): LandAnchor[] | null {
  const hit = anchorCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > ANCHOR_CACHE_TTL_MS) {
    anchorCache.delete(key);
    return null;
  }
  return hit.anchors;
}

export function anchorCacheSet(key: string, anchors: LandAnchor[]): void {
  if (anchorCache.size >= ANCHOR_CACHE_MAX) {
    const oldest = [...anchorCache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 8);
    for (const [k] of oldest) anchorCache.delete(k);
  }
  anchorCache.set(key, { ts: Date.now(), anchors });
}

export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}
