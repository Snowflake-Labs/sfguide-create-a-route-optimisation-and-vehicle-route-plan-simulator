// Regression test for components/function-tester/samplePoints.ts - the
// separation-band guarantee on the Function Tester's coordinate sampler.
//
// Run with: npx tsx verify_sample_points.mts   (from fleet_tools/user)
//
// It lives here rather than under fleet_admin_app/ui for the same reason as
// verify_shift_overrun.mts: this package already carries tsx as a devDependency,
// while the admin app UI does not. samplePoints.ts is dependency-free pure
// TypeScript, so a relative import works.
//
// WHAT THIS PROTECTS
//
// A DIRECTIONS call in the UnitedStatesOfAmerica region was generated as
//   DIRECTIONS('driving-hgv', [-156.47031, 20.88982], [-116.19779, 43.91467])
// which is Maui, Hawaii to Boise, Idaho: ~3,400 km apart with no road between
// them. ORS searched the whole US graph, SPCS ingress cut the connection at 90s
// and returned a plain-text 'upstream request timeout', and the unguarded
// r.json() in the gateway turned that into
//   Error: Unexpected token 'u', "upstream r"... is not valid JSON
//
// The sampler asks for 2-15 km for a driving profile, so that pair should have
// been impossible. Two things let it through:
//
//  1. The coordinate pool was 50 POIs drawn region-wide. Measured on the real
//     region (9,892 POIs): the pool spans 8,165 km and only 73% of POIs have
//     ANY neighbour in the 2-15 km ring. So the ring filter matched nothing.
//  2. samplePointNear then fell through to "nearest pool points" with NO
//     distance ceiling, and the nearest pool POI to one on Maui was in Boise.
//     sampleWithSeparation returned that pair without re-checking the band.
//
// The fix is in two layers, and this file exercises the sampler layer: a hard
// ceiling on the fallback (FALLBACK_MAX_MULTIPLE x maxKm) plus a checked final
// attempt, so a pool that cannot satisfy the band produces a HINT rather than a
// silently out-of-band pair. The pool layer (H3-anchored pool) is in
// app/api/sample-poi-points/route.ts and is verified against live data.
//
// Distances here are computed with a REAL haversine, deliberately NOT the
// flat-earth approximation inside samplePoints.ts. Reusing the module's own
// haversineKm would make an error in it invisible - the assertion would agree
// with the bug.
import { samplePoints, getProfileBand, type BBox } from '../../fleet_admin_app/ui/src/components/function-tester/samplePoints';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

// Real haversine, independent of samplePoints.ts.
const R_KM = 6371.0088;
function haversineKm(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bboxOf(points: [number, number][], padDeg = 0.5): BBox {
  const lons = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  return {
    min_lon: Math.min(...lons) - padDeg,
    max_lon: Math.max(...lons) + padDeg,
    min_lat: Math.min(...lats) - padDeg,
    max_lat: Math.max(...lats) + padDeg,
  };
}

// ---------------------------------------------------------------------------
// Fixtures. All coordinates are real rows from
// SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT for UnitedStatesOfAmerica.
// ---------------------------------------------------------------------------

// The observed failing pair.
const MAUI: [number, number] = [-156.47031, 20.88982];
const BOISE: [number, number] = [-116.19779, 43.91467];

// A region-wide pool: the shape that produced the defect. These are genuinely in
// the region's POI table and genuinely on different landmasses - Kauai and
// Maui (Hawaii), Unalaska / Nome / Bethel (Alaska), and Idaho.
const REGION_WIDE_POOL: [number, number][] = [
  MAUI,
  BOISE,
  [-166.55377, 53.88426],
  [-166.53722, 53.88891],
  [-166.51115, 53.91154],
  [-165.40982, 64.50063],
  [-162.60332, 66.89115],
  [-161.84044, 60.78333],
  [-161.76113, 60.79556],
  [-159.59017, 21.90886],
  [-159.52585, 21.92582],
  [-159.37666, 21.97096],
  [-159.36814, 21.97979],
  [-159.36211, 21.9592],
];

// A real anchored pool: every POI inside one H3 res-5 cell in Idaho, which is
// what /api/sample-poi-points now returns for a driving profile.
const ANCHORED_POOL: [number, number][] = [
  [-114.30202716, 43.5022447],
  [-114.256444, 43.454556],
  [-114.30620479, 43.51358767],
  [-114.271289, 43.4234134],
  [-114.264341379, 43.472907379],
  [-114.2617445, 43.4644302],
  [-114.30599436, 43.511031],
  [-114.257195, 43.457179],
  [-114.30704, 43.511409],
];

const PROFILES = ['driving-hgv', 'driving-car', 'cycling-regular', 'foot-walking'];
const PAIR_FUNCTIONS = ['DIRECTIONS', 'MATCH', 'MATCH_PATH'];
const MULTI_FUNCTIONS = ['MATRIX', 'MATRIX_TABULAR'];
const TRIALS = 200;

// The ceiling the sampler applies to its nearest-neighbour fallback. Kept in
// sync with FALLBACK_MAX_MULTIPLE in samplePoints.ts.
const FALLBACK_MAX_MULTIPLE = 2;

// ---------------------------------------------------------------------------
// GROUP 1: the observed pair can never be produced again.
//
// The pool deliberately CONTAINS both Maui and Boise, so nothing here is true by
// construction - the sampler has to actively decline to pair them.
// ---------------------------------------------------------------------------
{
  const bbox = bboxOf(REGION_WIDE_POOL);
  let worstKm = 0;
  let sawObservedPair = false;

  for (const profile of PROFILES) {
    const band = getProfileBand(profile);
    const ceilingKm = band.maxKm * FALLBACK_MAX_MULTIPLE;
    for (let seed = 0; seed < TRIALS; seed++) {
      for (const fnName of PAIR_FUNCTIONS) {
        const out = samplePoints({ fnName, bbox, profile, seed, roadPoints: REGION_WIDE_POOL });
        if (!out) continue;
        const [a, b] = out.points;
        if (!a || !b) continue;
        const d = haversineKm(a, b);
        worstKm = Math.max(worstKm, d);
        const isObserved =
          (haversineKm(a, MAUI) < 0.001 && haversineKm(b, BOISE) < 0.001)
          || (haversineKm(a, BOISE) < 0.001 && haversineKm(b, MAUI) < 0.001);
        if (isObserved) sawObservedPair = true;
        check(
          `${fnName}/${profile}/seed${seed}: pair within fallback ceiling`,
          d <= ceilingKm + 0.001,
          `separation ${d.toFixed(1)} km exceeds ceiling ${ceilingKm} km`,
        );
        // The invariant that was actually broken: a pair may miss the band, but
        // it must never miss it SILENTLY. The old code returned a 3,400 km pair
        // either unreported or under a hint that blamed the region's size.
        const relaxedOk = d >= band.minKm * 0.5 && d <= band.maxKm;
        check(
          `${fnName}/${profile}/seed${seed}: out-of-band pair carries a hint`,
          relaxedOk || !!out.hint,
          `separation ${d.toFixed(2)} km outside [${(band.minKm * 0.5).toFixed(2)}, ${band.maxKm}] km with no hint`,
        );
      }
    }
  }

  check('region-wide pool never reproduces the observed Maui/Boise pair', !sawObservedPair);
  console.log(`  region-wide pool: worst separation ${worstKm.toFixed(2)} km across ${TRIALS} seeds x ${PROFILES.length} profiles`);
}

// ---------------------------------------------------------------------------
// GROUP 2: a real anchored pool produces in-band pairs.
// ---------------------------------------------------------------------------
{
  const bbox = bboxOf(ANCHORED_POOL, 0.15);
  const profile = 'driving-hgv';
  const band = getProfileBand(profile);
  let inBand = 0;
  let total = 0;
  let worstKm = 0;

  for (let seed = 0; seed < TRIALS; seed++) {
    const out = samplePoints({ fnName: 'DIRECTIONS', bbox, profile, seed, roadPoints: ANCHORED_POOL });
    if (!out) continue;
    const [a, b] = out.points;
    if (!a || !b) continue;
    total++;
    const d = haversineKm(a, b);
    worstKm = Math.max(worstKm, d);
    if (d >= band.minKm && d <= band.maxKm) inBand++;
    // Even when the exact band is missed, the pair must stay local. This is the
    // property that keeps ORS from searching a continent.
    check(`anchored/seed${seed}: pair stays local`, d <= band.maxKm * FALLBACK_MAX_MULTIPLE + 0.001,
          `separation ${d.toFixed(2)} km`);
    check(`anchored/seed${seed}: both points are real pool points`,
          ANCHORED_POOL.some((p) => haversineKm(p, a) < 0.001)
          && ANCHORED_POOL.some((p) => haversineKm(p, b) < 0.001));
  }

  check('anchored pool yields a usable pair every time', total === TRIALS, `${total} of ${TRIALS}`);
  check('anchored pool is mostly in-band', inBand / total >= 0.9,
        `${inBand}/${total} in [${band.minKm}, ${band.maxKm}] km`);
  console.log(`  anchored pool: ${inBand}/${total} in-band, worst separation ${worstKm.toFixed(2)} km`);
}

// ---------------------------------------------------------------------------
// GROUP 3: multi-point functions get the count they asked for.
//
// samplePointNear can now return null, so a naive fix would silently emit a
// 2-point MATRIX. The requested cardinality is part of the contract.
// ---------------------------------------------------------------------------
{
  const expected: Record<string, number> = { MATRIX: 3, MATRIX_TABULAR: 4 };
  let violatedSeen = 0;
  for (const [bbox, pool, label] of [
    [bboxOf(REGION_WIDE_POOL), REGION_WIDE_POOL, 'region-wide'],
    [bboxOf(ANCHORED_POOL, 0.15), ANCHORED_POOL, 'anchored'],
  ] as [BBox, [number, number][], string][]) {
    for (const fnName of MULTI_FUNCTIONS) {
      for (let seed = 0; seed < 25; seed++) {
        const out = samplePoints({ fnName, bbox, profile: 'driving-car', seed, roadPoints: pool });
        check(`${fnName}/${label}/seed${seed}: returns ${expected[fnName]} points`,
              !!out && out.points.length === expected[fnName],
              `got ${out?.points.length}`);
        if (!out) continue;
        // Same no-silent-violation invariant, across every pair in the set.
        const band = getProfileBand('driving-car');
        let worst = 0;
        let violated = false;
        for (let i = 0; i < out.points.length; i++) {
          for (let j = i + 1; j < out.points.length; j++) {
            const d = haversineKm(out.points[i], out.points[j]);
            worst = Math.max(worst, d);
            if (d < band.minKm * 0.5 || d > band.maxKm) violated = true;
          }
        }
        check(`${fnName}/${label}/seed${seed}: violation is reported`, !violated || !!out.hint,
              `worst pair ${worst.toFixed(2)} km with no hint`);
        // And reported ACCURATELY. The pre-fix hint blamed the region's size for
        // what was really pool sparsity, which is what sent the first diagnosis
        // of this bug to the wrong place. A hint with the wrong cause is not a
        // report, so 'some hint exists' is too weak an assertion to rely on.
        if (violated) {
          violatedSeen++;
          check(`${fnName}/${label}/seed${seed}: hint names pool sparsity`,
                /sparse/i.test(out.hint || ''),
                `hint was ${JSON.stringify(out.hint)} for a worst pair of ${worst.toFixed(2)} km`);
        }
        check(`${fnName}/${label}/seed${seed}: all points stay local`,
              worst <= band.maxKm * FALLBACK_MAX_MULTIPLE + 0.001,
              `worst pair ${worst.toFixed(2)} km`);
      }
    }
  }
  // Guard against the sparsity assertion above passing vacuously: if no trial
  // ever violates the band, it asserts nothing and would not notice the check
  // being removed.
  check('band violations are actually exercised', violatedSeen > 0,
        `${violatedSeen} violating trials seen`);
  console.log(`  multi-point: ${violatedSeen} trials exercised the out-of-band reporting path`);
}

// ---------------------------------------------------------------------------
// GROUP 4: OPTIMIZATION stays local too (depot + 10 jobs).
// ---------------------------------------------------------------------------
{
  const bbox = bboxOf(REGION_WIDE_POOL);
  for (let seed = 0; seed < 25; seed++) {
    const out = samplePoints({ fnName: 'OPTIMIZATION', bbox, profile: 'driving-car', seed, roadPoints: REGION_WIDE_POOL });
    check(`OPTIMIZATION/seed${seed}: returns depot + 10 jobs`, !!out && out.points.length === 11,
          `got ${out?.points.length}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
