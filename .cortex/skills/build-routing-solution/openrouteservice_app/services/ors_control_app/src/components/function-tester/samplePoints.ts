export interface BBox {
  min_lat: number;
  max_lat: number;
  min_lon: number;
  max_lon: number;
}

export interface SamplePointsInput {
  fnName: string;
  bbox: BBox;
  profile: string;
  seed?: number;
  roadPoints?: [number, number][];
}

export interface SampledPoints {
  points: [number, number][];
  hint?: string;
}

interface ProfileConstraints {
  minKm: number;
  maxKm: number;
}

const DEG_TO_KM_LAT = 111.32;

function degToKmLon(lat: number): number {
  return 111.32 * Math.cos((lat * Math.PI) / 180);
}

function haversineKm(a: [number, number], b: [number, number]): number {
  const midLat = (a[1] + b[1]) / 2;
  const dLat = (b[1] - a[1]) * DEG_TO_KM_LAT;
  const dLon = (b[0] - a[0]) * degToKmLon(midLat);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getProfileConstraints(profile: string, maxSpan: number): ProfileConstraints {
  if (profile.startsWith('driving')) {
    return { minKm: 2, maxKm: Math.min(15, maxSpan) };
  }
  if (profile.startsWith('cycling')) {
    return { minKm: 1, maxKm: Math.min(8, maxSpan) };
  }
  return { minKm: 0.3, maxKm: Math.min(3, maxSpan) };
}

function isBBoxValid(bbox: BBox): boolean {
  if (!bbox) return false;
  if (bbox.min_lat == null || bbox.max_lat == null || bbox.min_lon == null || bbox.max_lon == null) return false;
  if (bbox.min_lat === 0 && bbox.max_lat === 0 && bbox.min_lon === 0 && bbox.max_lon === 0) return false;
  return true;
}

const MIN_EDGE_MARGIN = 0.05;

function randomPointInBBox(bbox: BBox, rand: () => number, shrink = 0): [number, number] {
  const latRange = bbox.max_lat - bbox.min_lat;
  const lonRange = bbox.max_lon - bbox.min_lon;
  const margin = Math.max(shrink, MIN_EDGE_MARGIN);
  const lat = bbox.min_lat + latRange * margin + rand() * latRange * (1 - 2 * margin);
  const lon = bbox.min_lon + lonRange * margin + rand() * lonRange * (1 - 2 * margin);
  return [+lon.toFixed(5), +lat.toFixed(5)];
}

function pickFromRoad(roadPoints: [number, number][], rand: () => number): [number, number] {
  const idx = Math.floor(rand() * roadPoints.length);
  const p = roadPoints[idx];
  return [+p[0].toFixed(5), +p[1].toFixed(5)];
}

function sampleOne(bbox: BBox, rand: () => number, roadPoints?: [number, number][], shrink = 0): [number, number] {
  if (roadPoints && roadPoints.length > 0) {
    return pickFromRoad(roadPoints, rand);
  }
  return randomPointInBBox(bbox, rand, shrink);
}

function meetsSepConstraints(points: [number, number][], minKm: number, maxKm: number): boolean {
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = haversineKm(points[i], points[j]);
      if (d < minKm || d > maxKm) return false;
    }
  }
  return true;
}

function samplePointNear(anchor: [number, number], minKm: number, maxKm: number, bbox: BBox, rand: () => number, roadPoints?: [number, number][]): [number, number] {
  if (roadPoints && roadPoints.length > 0) {
    const candidates = roadPoints.filter(rp => {
      const d = haversineKm(anchor, rp);
      return d >= minKm && d <= maxKm;
    });
    if (candidates.length > 0) {
      const idx = Math.floor(rand() * candidates.length);
      return [+candidates[idx][0].toFixed(5), +candidates[idx][1].toFixed(5)];
    }
    // No road point in the target distance ring. On continent-scale regions the seeded
    // road points are spread by tile (~degrees apart), so target ranges of a few km will
    // never match. Fall back to the nearest road points to the anchor — keeps both ends
    // on real roads (avoids angular offsets into ocean/wilderness) and stays geographically
    // local instead of coast-to-coast.
    const sorted = roadPoints
      .map(rp => ({ rp, d: haversineKm(anchor, rp) }))
      .filter(x => x.d > 0.01)
      .sort((a, b) => a.d - b.d);
    if (sorted.length > 0) {
      const pool = sorted.slice(0, Math.min(5, sorted.length));
      const choice = pool[Math.floor(rand() * pool.length)];
      return [+choice.rp[0].toFixed(5), +choice.rp[1].toFixed(5)];
    }
  }
  const midLat = (bbox.min_lat + bbox.max_lat) / 2;
  const targetKm = minKm + rand() * (maxKm - minKm);
  const angle = rand() * 2 * Math.PI;
  const dLat = (targetKm * Math.cos(angle)) / DEG_TO_KM_LAT;
  const dLon = (targetKm * Math.sin(angle)) / degToKmLon(midLat);
  let lat = anchor[1] + dLat;
  let lon = anchor[0] + dLon;
  const latRange = bbox.max_lat - bbox.min_lat;
  const lonRange = bbox.max_lon - bbox.min_lon;
  lat = Math.max(bbox.min_lat + latRange * MIN_EDGE_MARGIN, Math.min(bbox.max_lat - latRange * MIN_EDGE_MARGIN, lat));
  lon = Math.max(bbox.min_lon + lonRange * MIN_EDGE_MARGIN, Math.min(bbox.max_lon - lonRange * MIN_EDGE_MARGIN, lon));
  return [+lon.toFixed(5), +lat.toFixed(5)];
}

function sampleWithSeparation(
  count: number,
  bbox: BBox,
  constraints: ProfileConstraints,
  rand: () => number,
  roadPoints?: [number, number][],
  shrink = 0,
): { points: [number, number][]; hint?: string } {
  for (let attempt = 0; attempt < 5; attempt++) {
    const first = sampleOne(bbox, rand, roadPoints, shrink);
    const pts: [number, number][] = [first];
    for (let i = 1; i < count; i++) {
      pts.push(samplePointNear(first, constraints.minKm, constraints.maxKm, bbox, rand, roadPoints));
    }
    if (meetsSepConstraints(pts, constraints.minKm, constraints.maxKm)) {
      return { points: pts };
    }
  }
  const first = sampleOne(bbox, rand, roadPoints, shrink);
  const pts: [number, number][] = [first];
  for (let i = 1; i < count; i++) {
    pts.push(samplePointNear(first, constraints.minKm * 0.5, constraints.maxKm, bbox, rand, roadPoints));
  }
  return { points: pts, hint: 'Region is small — using reduced sample distances.' };
}

function sampleDirections(bbox: BBox, constraints: ProfileConstraints, rand: () => number, roadPoints?: [number, number][]): { points: [number, number][]; hint?: string } {
  return sampleWithSeparation(2, bbox, constraints, rand, roadPoints);
}

function sampleIsochrones(bbox: BBox, rand: () => number, roadPoints?: [number, number][]): { points: [number, number][]; hint?: string } {
  const pt = sampleOne(bbox, rand, roadPoints, 0.15);
  return { points: [pt] };
}

function sampleMatrix(bbox: BBox, constraints: ProfileConstraints, rand: () => number, roadPoints?: [number, number][]): { points: [number, number][]; hint?: string } {
  return sampleWithSeparation(3, bbox, constraints, rand, roadPoints);
}

function sampleMatrixTabular(bbox: BBox, constraints: ProfileConstraints, rand: () => number, roadPoints?: [number, number][]): { points: [number, number][]; hint?: string } {
  return sampleWithSeparation(4, bbox, constraints, rand, roadPoints);
}

function sampleOptimization(bbox: BBox, constraints: ProfileConstraints, rand: () => number, roadPoints?: [number, number][]): { points: [number, number][]; hint?: string } {
  const latEdgeKm = 1;
  const lonEdgeKm = 1;
  const latRange = bbox.max_lat - bbox.min_lat;
  const lonRange = bbox.max_lon - bbox.min_lon;
  const midLat = (bbox.min_lat + bbox.max_lat) / 2;
  const latMargin = Math.min(latEdgeKm / DEG_TO_KM_LAT / latRange, 0.3);
  const lonMargin = Math.min(lonEdgeKm / degToKmLon(midLat) / lonRange, 0.3);
  const margin = Math.max(latMargin, lonMargin);

  const depot = sampleOne(bbox, rand, roadPoints, margin);

  // Continent-scale regions: the road-point seed is spread by tile (~degrees apart), so
  // randomly picking jobs from the full set produces a depot in NYC and jobs across the USA.
  // Keep the route plan locally meaningful by drawing all jobs from the road points nearest
  // to the depot. This still gives a varied but routable plan.
  if (roadPoints && roadPoints.length >= 5) {
    const sorted = roadPoints
      .map(rp => ({ rp, d: haversineKm(depot, rp) }))
      .filter(x => x.d > 0.01)
      .sort((a, b) => a.d - b.d)
      .slice(0, Math.min(roadPoints.length - 1, 12));
    if (sorted.length >= 4) {
      const shuffled = [...sorted].sort(() => rand() - 0.5).slice(0, 4);
      const jobs = shuffled.map(x => [+x.rp[0].toFixed(5), +x.rp[1].toFixed(5)] as [number, number]);
      return { points: [depot, ...jobs] };
    }
  }

  const jobs: [number, number][] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    jobs.length = 0;
    for (let i = 0; i < 4; i++) {
      jobs.push(sampleOne(bbox, rand, roadPoints));
    }
    const allWithinMax = jobs.every(j => haversineKm(depot, j) <= constraints.maxKm);
    if (allWithinMax) {
      return { points: [depot, ...jobs] };
    }
  }
  return { points: [depot, ...jobs], hint: 'Region is small — using reduced sample distances.' };
}

export function samplePoints(input: SamplePointsInput): SampledPoints | null {
  const { fnName, bbox, profile, seed, roadPoints } = input;

  if (!isBBoxValid(bbox)) return null;

  const rand = mulberry32(seed ?? Date.now());
  const bboxWidthKm = (bbox.max_lon - bbox.min_lon) * degToKmLon((bbox.min_lat + bbox.max_lat) / 2);
  const bboxHeightKm = (bbox.max_lat - bbox.min_lat) * DEG_TO_KM_LAT;
  const maxSpan = Math.min(bboxWidthKm, bboxHeightKm) * 0.6;
  const constraints = getProfileConstraints(profile, maxSpan);

  switch (fnName) {
    case 'DIRECTIONS':
      return sampleDirections(bbox, constraints, rand, roadPoints);
    case 'ISOCHRONES':
      return sampleIsochrones(bbox, rand, roadPoints);
    case 'MATRIX':
      return sampleMatrix(bbox, constraints, rand, roadPoints);
    case 'MATRIX_TABULAR':
      return sampleMatrixTabular(bbox, constraints, rand, roadPoints);
    case 'OPTIMIZATION':
      return sampleOptimization(bbox, constraints, rand, roadPoints);
    default:
      return null;
  }
}

export const COORD_FUNCTIONS = ['DIRECTIONS', 'ISOCHRONES', 'MATRIX', 'MATRIX_TABULAR', 'OPTIMIZATION'];

export { haversineKm, isBBoxValid, mulberry32, getProfileConstraints };
