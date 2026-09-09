// ----------------------------------------------------------------------------
// engine/fleet.ts - fleet construction (Phase 2 split out of engine.ts).
//
// Pure synchronous function: takes a GenerationConfig + POIs + an RNG and
// returns a FleetMember[]. No IO, no diagnostics, no Snowflake - easy to
// unit-test in isolation. Optionally tags a configurable share of vehicles
// as "ghost trailers" that sit idle at their home POI for several days,
// replicating the non-moving-trailer pattern observed in real telemetry.
//
// Region-agnostic spatial stratification (Layer 1):
// home_poi assignment is round-robin over spatial BINS (not over POIs), so
// every populated bin gets ~num_vehicles / num_bins vehicles regardless of
// how many POIs the bin holds. Without this, the natural Overture density
// gradient pushes most vehicles into one metro for any large region.
// ----------------------------------------------------------------------------
import {
  GenerationConfig, rngInt, rngFloat, resolveVehicleType,
} from '../profiles';
import type { POI, FleetMember } from './types';
import {
  binPoisByLatLng, binDegForArea, bboxAreaKm2,
} from './spatial';
import { vehicleProfileFor, SubtypeShare } from '../vehicle-profile-catalog';

// Stable FNV-1a hash so VEHICLE_SUBTYPE / HAZMAT assignment is reproducible per
// vehicle_id (mirrors the legacy HASH(VEHICLE_ID) bucketing) and independent of
// the run RNG.
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Pick a subtype from the catalog distribution by HASH bucket. Returns null when
// the mode has no subtype distribution (car / ebike) - no vehicle-type branch.
function pickSubtype(dist: SubtypeShare[] | null | undefined, vehicleId: string): string | null {
  if (!dist || dist.length === 0) return null;
  const bucket = hashStr(`${vehicleId}|sub`) % 100;
  let cum = 0;
  for (const s of dist) { cum += s.pct; if (bucket < cum) return s.subtype; }
  return dist[dist.length - 1].subtype;
}

// Golden-ratio conjugate: generates a low-discrepancy sequence over [0,1).
const GOLDEN_CONJUGATE = 0.6180339887498949;

/**
 * Pick a shift index for vehicle `i`, honouring each shift's declared
 * `proportion`.
 *
 * Why this is not `i % shifts.length`: it used to be, which silently made
 * `proportion` DEAD CONFIG in every preset. The e-bike preset declares
 * 0.3 / 0.5 / 0.2 and got 34 / 33 / 33 instead, and because shift width is what
 * determines how long a duty day is, the whole fleet's hours distribution was an
 * artifact of the vehicle count rather than of the configured shift mix.
 *
 * Two properties are deliberate:
 *
 * 1. It consumes NO RNG. Drawing a weighted random shift here (the obvious fix,
 *    mirroring the driver_profiles loop below) would pull one extra value from
 *    the seeded stream per vehicle and shift every downstream random decision -
 *    home POI, base speed, ghost selection, and every trip in the run - so a
 *    "fix the shift mix" change would silently regenerate unrelated data.
 *
 * 2. It uses a golden-ratio low-discrepancy sequence rather than contiguous
 *    blocks, so shift assignment stays interleaved across the index space. Home
 *    POI is also assigned by index (round-robin over spatial bins), so blocking
 *    shifts contiguously would correlate shift with geography and put, say,
 *    every night-shift vehicle in the same part of the region.
 *
 * Falls back to the historical round-robin when no usable proportions are
 * declared, so a preset that omits them is unchanged.
 */
function pickShiftIndex(shifts: { proportion?: number }[], i: number): number {
  if (shifts.length <= 1) return 0;
  const weights = shifts.map(s => (Number.isFinite(s.proportion) && (s.proportion ?? 0) > 0 ? s.proportion! : 0));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return i % shifts.length; // no proportions declared
  const frac = (i * GOLDEN_CONJUGATE) % 1;
  let cum = 0;
  for (let k = 0; k < weights.length; k++) {
    cum += weights[k] / total;
    if (frac < cum) return k;
  }
  return weights.length - 1;
}

export interface BuildFleetDiagnostics {
  bin_deg: number;
  populated_home_bins: number;
  vehicles_per_bin_p50: number;
  vehicles_per_bin_p95: number;
  stratification_used: boolean;
  total_home_pois: number;
}

export interface BuildFleetResult {
  fleet: FleetMember[];
  diagnostics: BuildFleetDiagnostics;
}

function effectiveBinDeg(config: GenerationConfig): number {
  const ss = config.spatial_spread;
  if (ss && ss.bin_deg && Number.isFinite(ss.bin_deg) && ss.bin_deg > 0) return ss.bin_deg;
  const area = config.region_area_km2 ?? bboxAreaKm2(config.bbox);
  return binDegForArea(area);
}

export function buildFleet(config: GenerationConfig, pois: POI[], rng: () => number): FleetMember[] {
  return buildFleetWithDiagnostics(config, pois, rng).fleet;
}

export function buildFleetWithDiagnostics(
  config: GenerationConfig,
  pois: POI[],
  rng: () => number,
): BuildFleetResult {
  const fleet: FleetMember[] = [];
  const { num_vehicles } = config.fleet;
  const profiles = Object.entries(config.driver_profiles);
  // Home-base POIs by declarative location types (config-driven, mode-agnostic).
  // Empty/unset => any POI. Replaces the former mode==='urban_ebike'/'regional_hgv' branch.
  const homeTypes = config.home_location_types;
  const homePois = (homeTypes && homeTypes.length)
    ? pois.filter(p => homeTypes.includes(p.location_type))
    : pois.slice();
  if (homePois.length === 0) homePois.push(...pois.slice(0, Math.min(10, pois.length)));

  const vt = resolveVehicleType(config);
  // Per-mode asset attributes come from the catalog row - looked up ONCE, never
  // branched on vehicle type. Modes absent from the catalog fall back to nulls.
  const assetRow = vehicleProfileFor(vt);

  // ---------------------------------------------------------------------
  // Layer 1: stratified home POI assignment (region-agnostic).
  // ---------------------------------------------------------------------
  const ssEnabled = config.spatial_spread?.enabled !== false; // default ON
  const minBins = config.spatial_spread?.min_bins_required ?? 3;
  const binDeg = effectiveBinDeg(config);
  const homeBins = ssEnabled ? binPoisByLatLng(homePois, binDeg) : new Map<string, POI[]>();
  const useStratification = ssEnabled && homeBins.size >= minBins;
  // Stable bin order so round-robin is deterministic across runs with the
  // same seed: sort by key (lat_bin|lng_bin) which is naturally lexicographic.
  const sortedBinKeys = useStratification
    ? [...homeBins.keys()].sort()
    : [];
  const vehiclesPerBin = new Map<string, number>();

  for (let i = 0; i < num_vehicles; i++) {
    let profileType = 'COMPLIANT';
    let profileCfg = profiles[0][1];
    const r = rng();
    let cumulative = 0;
    for (const [name, cfg] of profiles) {
      cumulative += cfg.proportion;
      if (r < cumulative) { profileType = name; profileCfg = cfg; break; }
    }

    const shiftIdx = pickShiftIndex(config.shifts, i);
    const shift = config.shifts[shiftIdx];

    let home: POI;
    if (useStratification) {
      // Round-robin over BINS (not POIs) so every populated bin gets ~equal
      // share of vehicles. Within a bin, pick uniformly. Region-agnostic.
      const key = sortedBinKeys[i % sortedBinKeys.length];
      const list = homeBins.get(key)!;
      home = list[Math.floor(rng() * list.length)];
      vehiclesPerBin.set(key, (vehiclesPerBin.get(key) || 0) + 1);
    } else {
      // Fallback: original round-robin over POIs (small regions / spatial
      // spread disabled). Preserves backwards-compatible behaviour.
      home = homePois[i % homePois.length];
    }
    // Base speed range is a declarative profile knob (config.base_speed_kmh),
    // not a per-vehicle-type code branch.
    const spd = config.base_speed_kmh;
    const baseSpeed = spd ? rngFloat(rng, spd.min, spd.max) : rngFloat(rng, 30, 55);

    const vehicleId = `V-${config.ors_profile.slice(0, 3).toUpperCase()}-${i.toString().padStart(5, '0')}`;
    const subtype = pickSubtype(assetRow?.subtypeDist, vehicleId);
    const hazmat = subtype === 'TANKER'
      && (hashStr(`${vehicleId}|hz`) % 100) / 100 < (assetRow?.hazmatProb ?? 0);

    fleet.push({
      vehicle_id: vehicleId,
      driver_id: `DRV-${i.toString().padStart(5, '0')}`,
      home_poi: home,
      shift_start: shift.start,
      shift_end: shift.end,
      profile_type: profileType,
      detour_prob: profileCfg.detour_probability,
      speeding_prob: profileCfg.speeding_probability,
      speeding_ratio: assetRow?.speedingRatio ?? 1.08,
      hos_violation_prob: profileCfg.hos_violation_probability || 0,
      speed_variance: profileCfg.speed_variance,
      base_speed_kmh: baseSpeed,
      vehicle_type: vt,
      battery_pct: config.battery ? 100 : -1,
      weight_tons: assetRow?.weightTons ?? null,
      height_m: assetRow?.heightM ?? null,
      length_m: assetRow?.lengthM ?? null,
      width_m: assetRow?.widthM ?? null,
      axleload_t: assetRow?.axleloadT ?? null,
      hazmat,
      vehicle_subtype: subtype,
    });
  }

  // Tag a configurable share of the fleet as "ghost" - they will sit idle at
  // their home POI for several days, replicating the non-moving-trailer pattern.
  //
  // Ghost selection is STRATIFIED by spatial bin so that for large regions
  // (e.g. UsCalifornia) ghosts spread across the whole region instead of
  // concentrating in whatever sub-area happens to dominate the POI catalog
  // (typically the densest metro). With Layer-1 stratification above, the
  // home_poi distribution is now already even, so this acts as a redundant
  // safeguard for cases where stratification was bypassed.
  //
  // Each spatial bin gets `bin_size * probability` ghosts (stochastic rounding),
  // so the total expected ghost count is preserved while every populated bin
  // has a fair chance of contributing.
  const ghostCfg = config.ghost_trailer;
  if (ghostCfg && ghostCfg.probability > 0) {
    const GHOST_BIN_DEG = 0.5;
    const bins = new Map<string, FleetMember[]>();
    for (const m of fleet) {
      const key = `${Math.floor(m.home_poi.lat / GHOST_BIN_DEG)}|${Math.floor(m.home_poi.lng / GHOST_BIN_DEG)}`;
      const list = bins.get(key);
      if (list) list.push(m);
      else bins.set(key, [m]);
    }
    for (const members of bins.values()) {
      const expected = members.length * ghostCfg.probability;
      const baseCount = Math.floor(expected);
      const ghostCount = baseCount + (rng() < (expected - baseCount) ? 1 : 0);
      if (ghostCount === 0) continue;
      const shuffled = members.slice().sort(() => rng() - 0.5);
      const n = Math.min(ghostCount, shuffled.length);
      for (let i = 0; i < n; i++) {
        const startDay = rngInt(rng, ghostCfg.start_day_min, ghostCfg.start_day_max);
        const duration = rngInt(rng, ghostCfg.duration_days_min, ghostCfg.duration_days_max);
        shuffled[i].ghost_start_day = startDay;
        shuffled[i].ghost_end_day = startDay + duration - 1;
      }
    }
  }

  // Diagnostics for jobs.ts log emission.
  const counts = [...vehiclesPerBin.values()].sort((a, b) => a - b);
  const p50 = counts.length === 0 ? 0
    : counts.length % 2 === 0 ? (counts[counts.length / 2 - 1] + counts[counts.length / 2]) / 2
    : counts[Math.floor(counts.length / 2)];
  const p95 = counts.length === 0 ? 0 : counts[Math.min(counts.length - 1, Math.floor(counts.length * 0.95))];

  return {
    fleet,
    diagnostics: {
      bin_deg: binDeg,
      populated_home_bins: useStratification ? homeBins.size : 0,
      vehicles_per_bin_p50: p50,
      vehicles_per_bin_p95: p95,
      stratification_used: useStratification,
      total_home_pois: homePois.length,
    },
  };
}
