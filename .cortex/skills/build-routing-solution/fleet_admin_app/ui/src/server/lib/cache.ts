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

export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}
