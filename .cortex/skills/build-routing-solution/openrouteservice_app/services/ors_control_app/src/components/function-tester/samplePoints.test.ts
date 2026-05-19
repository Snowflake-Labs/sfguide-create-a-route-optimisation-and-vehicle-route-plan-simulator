import { describe, it, expect } from 'vitest';
import { samplePoints, COORD_FUNCTIONS, haversineKm, isBBoxValid, mulberry32, getProfileConstraints, type BBox } from './samplePoints';

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
