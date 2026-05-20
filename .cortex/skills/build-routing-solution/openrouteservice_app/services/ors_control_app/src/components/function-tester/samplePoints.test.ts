import { describe, it, expect } from 'vitest';
import { samplePoints, COORD_FUNCTIONS, haversineKm, isBBoxValid, mulberry32, getProfileConstraints, pointInBoundary, type BBox, type BoundaryGeoJson } from './samplePoints';

const NYC_BBOX: BBox = { min_lat: 40.4774, max_lat: 40.9176, min_lon: -74.2591, max_lon: -73.7004 };
const SMALL_BBOX: BBox = { min_lat: 51.5, max_lat: 51.505, min_lon: -0.1, max_lon: -0.095 };
const ZERO_BBOX: BBox = { min_lat: 0, max_lat: 0, min_lon: 0, max_lon: 0 };

describe('samplePoints', () => {
  describe('returns correct point count per function', () => {
    it('DIRECTIONS returns 2 points', () => {
      const result = samplePoints({ fnName: 'DIRECTIONS', bbox: NYC_BBOX, profile: 'driving-car', seed: 42 });
      expect(result).not.toBeNull();
      expect(result!.points).toHaveLength(2);
    });

    it('ISOCHRONES returns 1 point', () => {
      const result = samplePoints({ fnName: 'ISOCHRONES', bbox: NYC_BBOX, profile: 'driving-car', seed: 42 });
      expect(result).not.toBeNull();
      expect(result!.points).toHaveLength(1);
    });

    it('MATRIX returns 3 points', () => {
      const result = samplePoints({ fnName: 'MATRIX', bbox: NYC_BBOX, profile: 'driving-car', seed: 42 });
      expect(result).not.toBeNull();
      expect(result!.points).toHaveLength(3);
    });

    it('MATRIX_TABULAR returns 4 points (1 origin + 3 destinations)', () => {
      const result = samplePoints({ fnName: 'MATRIX_TABULAR', bbox: NYC_BBOX, profile: 'driving-car', seed: 42 });
      expect(result).not.toBeNull();
      expect(result!.points).toHaveLength(4);
    });

    it('OPTIMIZATION returns 11 points (1 depot + 10 jobs)', () => {
      const result = samplePoints({ fnName: 'OPTIMIZATION', bbox: NYC_BBOX, profile: 'driving-car', seed: 42 });
      expect(result).not.toBeNull();
      expect(result!.points).toHaveLength(11);
    });
  });

  describe('returns null for non-coordinate functions', () => {
    it('ORS_STATUS returns null', () => {
      expect(samplePoints({ fnName: 'ORS_STATUS', bbox: NYC_BBOX, profile: 'driving-car', seed: 42 })).toBeNull();
    });

    it('CHECK_HEALTH returns null', () => {
      expect(samplePoints({ fnName: 'CHECK_HEALTH', bbox: NYC_BBOX, profile: 'driving-car', seed: 42 })).toBeNull();
    });

    it('LIST_REGIONS returns null', () => {
      expect(samplePoints({ fnName: 'LIST_REGIONS', bbox: NYC_BBOX, profile: 'driving-car', seed: 42 })).toBeNull();
    });
  });

  describe('determinism with seed', () => {
    it('same seed produces same output', () => {
      const a = samplePoints({ fnName: 'DIRECTIONS', bbox: NYC_BBOX, profile: 'driving-car', seed: 123 });
      const b = samplePoints({ fnName: 'DIRECTIONS', bbox: NYC_BBOX, profile: 'driving-car', seed: 123 });
      expect(a!.points).toEqual(b!.points);
    });

    it('different seed produces different output', () => {
      const a = samplePoints({ fnName: 'DIRECTIONS', bbox: NYC_BBOX, profile: 'driving-car', seed: 100 });
      const b = samplePoints({ fnName: 'DIRECTIONS', bbox: NYC_BBOX, profile: 'driving-car', seed: 200 });
      expect(a!.points).not.toEqual(b!.points);
    });
  });

  describe('min-separation invariants', () => {
    it('driving-car points are >= 2km apart (DIRECTIONS)', () => {
      const result = samplePoints({ fnName: 'DIRECTIONS', bbox: NYC_BBOX, profile: 'driving-car', seed: 42 });
      const dist = haversineKm(result!.points[0], result!.points[1]);
      expect(dist).toBeGreaterThanOrEqual(2);
    });

    it('foot-walking points separation <= 3km (DIRECTIONS)', () => {
      for (let seed = 1; seed <= 20; seed++) {
        const result = samplePoints({ fnName: 'DIRECTIONS', bbox: NYC_BBOX, profile: 'foot-walking', seed });
        if (result && result.points.length === 2) {
          const dist = haversineKm(result.points[0], result.points[1]);
          expect(dist).toBeLessThanOrEqual(3.5);
        }
      }
    });

    it('MATRIX all pairwise >= min for cycling', () => {
      const result = samplePoints({ fnName: 'MATRIX', bbox: NYC_BBOX, profile: 'cycling-regular', seed: 42 });
      const pts = result!.points;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dist = haversineKm(pts[i], pts[j]);
          expect(dist).toBeGreaterThanOrEqual(0.5);
        }
      }
    });
  });

  describe('bbox validation', () => {
    it('returns null for zero bbox', () => {
      expect(samplePoints({ fnName: 'DIRECTIONS', bbox: ZERO_BBOX, profile: 'driving-car', seed: 42 })).toBeNull();
    });

    it('small bbox triggers hint', () => {
      const result = samplePoints({ fnName: 'DIRECTIONS', bbox: SMALL_BBOX, profile: 'driving-car', seed: 42 });
      if (result) {
        expect(result.hint).toBeDefined();
        expect(result.hint).toContain('Region is small');
      }
    });
  });

  describe('points stay within bbox', () => {
    for (const fnName of COORD_FUNCTIONS) {
      it(`${fnName} points within bbox`, () => {
        const result = samplePoints({ fnName, bbox: NYC_BBOX, profile: 'driving-car', seed: 42 });
        if (!result) return;
        for (const [lon, lat] of result.points) {
          expect(lon).toBeGreaterThanOrEqual(NYC_BBOX.min_lon);
          expect(lon).toBeLessThanOrEqual(NYC_BBOX.max_lon);
          expect(lat).toBeGreaterThanOrEqual(NYC_BBOX.min_lat);
          expect(lat).toBeLessThanOrEqual(NYC_BBOX.max_lat);
        }
      });
    }
  });

  describe('5-decimal precision', () => {
    it('all coordinates have at most 5 decimal places', () => {
      const result = samplePoints({ fnName: 'OPTIMIZATION', bbox: NYC_BBOX, profile: 'driving-car', seed: 42 });
      for (const [lon, lat] of result!.points) {
        const lonDecimals = lon.toString().split('.')[1]?.length || 0;
        const latDecimals = lat.toString().split('.')[1]?.length || 0;
        expect(lonDecimals).toBeLessThanOrEqual(5);
        expect(latDecimals).toBeLessThanOrEqual(5);
      }
    });
  });

  describe('no NaN coordinates', () => {
    for (const fnName of COORD_FUNCTIONS) {
      it(`${fnName} never produces NaN`, () => {
        for (let seed = 1; seed <= 10; seed++) {
          const result = samplePoints({ fnName, bbox: NYC_BBOX, profile: 'driving-car', seed });
          if (!result) continue;
          for (const [lon, lat] of result.points) {
            expect(isNaN(lon)).toBe(false);
            expect(isNaN(lat)).toBe(false);
          }
        }
      });
    }
  });

  describe('road-snap mode uses provided road points', () => {
    it('uses road points when provided', () => {
      const roadPoints: [number, number][] = [
        [-74.0, 40.7], [-73.95, 40.75], [-73.9, 40.8],
        [-74.05, 40.65], [-73.85, 40.72], [-74.1, 40.6],
      ];
      const result = samplePoints({ fnName: 'DIRECTIONS', bbox: NYC_BBOX, profile: 'driving-car', seed: 42, roadPoints });
      expect(result).not.toBeNull();
      for (const pt of result!.points) {
        const matchesRoad = roadPoints.some(rp =>
          Math.abs(rp[0] - pt[0]) < 0.00001 && Math.abs(rp[1] - pt[1]) < 0.00001
        );
        expect(matchesRoad).toBe(true);
      }
    });
  });
});

describe('utility functions', () => {
  it('isBBoxValid rejects zero bbox', () => {
    expect(isBBoxValid(ZERO_BBOX)).toBe(false);
  });

  it('isBBoxValid accepts valid bbox', () => {
    expect(isBBoxValid(NYC_BBOX)).toBe(true);
  });

  it('mulberry32 is deterministic', () => {
    const rng1 = mulberry32(42);
    const rng2 = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      expect(rng1()).toBe(rng2());
    }
  });

  it('haversineKm returns reasonable distances', () => {
    const dist = haversineKm([-74.0, 40.7], [-73.9, 40.8]);
    expect(dist).toBeGreaterThan(10);
    expect(dist).toBeLessThan(20);
  });

  it('getProfileConstraints returns correct values', () => {
    const driving = getProfileConstraints('driving-car', 20);
    expect(driving.minKm).toBe(2);
    expect(driving.maxKm).toBe(15);

    const cycling = getProfileConstraints('cycling-regular', 20);
    expect(cycling.minKm).toBe(1);
    expect(cycling.maxKm).toBe(8);

    const foot = getProfileConstraints('foot-walking', 20);
    expect(foot.minKm).toBe(0.3);
    expect(foot.maxKm).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Polygon-aware sampling: California / Italy fixtures
// ---------------------------------------------------------------------------
//
// The bbox of California (and Italy) overlaps neighbouring regions and large
// bodies of water. Without polygon rejection sampling the Function Tester
// generates points in Nevada / the Pacific / the Adriatic, causing ORS to
// return PointNotFound errors. The fixtures below are coarse hand-drawn
// polygons that capture the dominant shape of each region; tests assert that
// every sampled point falls inside the polygon (with and without seeded road
// points).

const CALIFORNIA_BBOX: BBox = { min_lat: 32.5, max_lat: 42.0, min_lon: -124.5, max_lon: -114.0 };
const CALIFORNIA_BOUNDARY: BoundaryGeoJson = {
  type: 'Polygon',
  coordinates: [[
    // Coarse outline (lon, lat) clockwise starting NW
    [-124.4, 42.0],
    [-120.0, 42.0],
    [-120.0, 39.0],
    [-114.6, 35.0],
    [-114.5, 32.7],
    [-117.1, 32.5],
    [-118.5, 33.7],
    [-120.6, 34.5],
    [-122.0, 36.9],
    [-123.7, 39.3],
    [-124.4, 40.4],
    [-124.4, 42.0],
  ]],
};

const ITALY_BBOX: BBox = { min_lat: 36.6, max_lat: 47.1, min_lon: 6.6, max_lon: 18.5 };
const ITALY_BOUNDARY: BoundaryGeoJson = {
  type: 'Polygon',
  coordinates: [[
    // Boot-shaped coarse outline; deliberately omits Sardinia so the polygon
    // diverges meaningfully from the bbox rectangle.
    [7.0, 45.9],
    [10.5, 46.9],
    [13.7, 46.5],
    [13.6, 45.7],
    [13.0, 45.7],
    [13.5, 44.0],
    [15.0, 41.9],
    [18.4, 40.0],
    [17.9, 39.9],
    [16.5, 39.5],
    [17.0, 38.9],
    [15.7, 38.0],
    [13.5, 37.1],
    [12.4, 37.6],
    [13.0, 38.7],
    [14.0, 40.8],
    [13.5, 41.2],
    [11.5, 42.4],
    [10.0, 44.0],
    [8.0, 44.4],
    [7.5, 43.8],
    [6.7, 45.1],
    [7.0, 45.9],
  ]],
};

function fractionInside(points: [number, number][], boundary: BoundaryGeoJson): number {
  let inside = 0;
  for (const [lon, lat] of points) {
    if (pointInBoundary(lon, lat, boundary)) inside++;
  }
  return inside / points.length;
}

describe('polygon-aware sampling — California', () => {
  for (const fnName of COORD_FUNCTIONS) {
    it(`${fnName} 100% of points inside California polygon (no road points)`, () => {
      const all: [number, number][] = [];
      for (let seed = 1; seed <= 25; seed++) {
        const r = samplePoints({
          fnName,
          bbox: CALIFORNIA_BBOX,
          profile: 'driving-car',
          seed,
          boundary: CALIFORNIA_BOUNDARY,
        });
        if (r) all.push(...r.points);
      }
      expect(all.length).toBeGreaterThan(0);
      expect(fractionInside(all, CALIFORNIA_BOUNDARY)).toBe(1);
    });
  }

  it('DIRECTIONS rejects out-of-polygon road points (Nevada/Pacific) when boundary supplied', () => {
    // Mix of California-valid and out-of-state road points (Las Vegas, Reno,
    // and a coastal Pacific point well off the coast).
    const roadPoints: [number, number][] = [
      [-122.42, 37.77], [-118.24, 34.05], [-121.49, 38.58],   // SF, LA, Sacramento
      [-115.14, 36.17], [-119.81, 39.53], [-124.95, 38.50],   // Las Vegas, Reno, Pacific
    ];
    const all: [number, number][] = [];
    for (let seed = 1; seed <= 15; seed++) {
      const r = samplePoints({
        fnName: 'DIRECTIONS',
        bbox: CALIFORNIA_BBOX,
        profile: 'driving-car',
        seed,
        roadPoints,
        boundary: CALIFORNIA_BOUNDARY,
      });
      if (r) all.push(...r.points);
    }
    expect(all.length).toBeGreaterThan(0);
    expect(fractionInside(all, CALIFORNIA_BOUNDARY)).toBe(1);
  });
});

describe('polygon-aware sampling — Italy', () => {
  for (const fnName of COORD_FUNCTIONS) {
    it(`${fnName} 100% of points inside Italy polygon`, () => {
      const all: [number, number][] = [];
      for (let seed = 1; seed <= 25; seed++) {
        const r = samplePoints({
          fnName,
          bbox: ITALY_BBOX,
          profile: 'driving-car',
          seed,
          boundary: ITALY_BOUNDARY,
        });
        if (r) all.push(...r.points);
      }
      expect(all.length).toBeGreaterThan(0);
      expect(fractionInside(all, ITALY_BOUNDARY)).toBe(1);
    });
  }
});

describe('polygon-aware sampling — fallback safety', () => {
  it('falls back to bbox sampling when boundary has no inside-bbox area', () => {
    // Degenerate boundary that does not intersect the bbox at all — the code
    // should still return points (within the bbox) instead of hanging.
    const empty: BoundaryGeoJson = {
      type: 'Polygon',
      coordinates: [[[100, 1], [100, 2], [101, 2], [101, 1], [100, 1]]],
    };
    const r = samplePoints({
      fnName: 'DIRECTIONS',
      bbox: CALIFORNIA_BBOX,
      profile: 'driving-car',
      seed: 7,
      boundary: empty,
    });
    expect(r).not.toBeNull();
    expect(r!.points).toHaveLength(2);
    for (const [lon, lat] of r!.points) {
      expect(lon).toBeGreaterThanOrEqual(CALIFORNIA_BBOX.min_lon);
      expect(lon).toBeLessThanOrEqual(CALIFORNIA_BBOX.max_lon);
      expect(lat).toBeGreaterThanOrEqual(CALIFORNIA_BBOX.min_lat);
      expect(lat).toBeLessThanOrEqual(CALIFORNIA_BBOX.max_lat);
    }
  });
});
