// ----------------------------------------------------------------------------
// engine/fleet.ts — fleet construction (Phase 2 split out of engine.ts).
//
// Pure synchronous function: takes a GenerationConfig + POIs + an RNG and
// returns a FleetMember[]. No IO, no diagnostics, no Snowflake — easy to
// unit-test in isolation. Optionally tags a configurable share of vehicles
// as "ghost trailers" that sit idle at their home POI for several days,
// replicating the non-moving-trailer pattern observed in real telemetry.
// ----------------------------------------------------------------------------
import {
  GenerationConfig, rngInt, rngFloat, resolveVehicleType,
} from '../profiles.js';
import type { POI, FleetMember } from './types.js';

export function buildFleet(config: GenerationConfig, pois: POI[], rng: () => number): FleetMember[] {
  const fleet: FleetMember[] = [];
  const { num_vehicles } = config.fleet;
  const profiles = Object.entries(config.driver_profiles);
  const homePois = pois.filter(p =>
    config.mode === 'food_delivery' ? p.location_type === 'RESTAURANT' :
    config.mode === 'trucking' ? p.location_type === 'WAREHOUSE' :
    true
  );
  if (homePois.length === 0) homePois.push(...pois.slice(0, Math.min(10, pois.length)));

  const vt = resolveVehicleType(config);

  for (let i = 0; i < num_vehicles; i++) {
    let profileType = 'COMPLIANT';
    let profileCfg = profiles[0][1];
    const r = rng();
    let cumulative = 0;
    for (const [name, cfg] of profiles) {
      cumulative += cfg.proportion;
      if (r < cumulative) { profileType = name; profileCfg = cfg; break; }
    }

    const shiftIdx = i % config.shifts.length;
    const shift = config.shifts[shiftIdx];
    const home = homePois[i % homePois.length];
    const baseSpeed = vt === 'ebike' ? rngFloat(rng, 15, 22)
      : vt === 'hgv' ? rngFloat(rng, 60, 85)
      : rngFloat(rng, 30, 55);

    fleet.push({
      vehicle_id: `V-${config.ors_profile.slice(0, 3).toUpperCase()}-${i.toString().padStart(5, '0')}`,
      driver_id: `DRV-${i.toString().padStart(5, '0')}`,
      home_poi: home,
      shift_start: shift.start,
      shift_end: shift.end,
      profile_type: profileType,
      detour_prob: profileCfg.detour_probability,
      speeding_prob: profileCfg.speeding_probability,
      hos_violation_prob: profileCfg.hos_violation_probability || 0,
      speed_variance: profileCfg.speed_variance,
      base_speed_kmh: baseSpeed,
      vehicle_type: vt,
      battery_pct: vt === 'ebike' ? 100 : -1,
    });
  }

  // Tag a configurable share of the fleet as "ghost" - they will sit idle at
  // their home POI for several days, replicating the non-moving-trailer pattern.
  //
  // Ghost selection is STRATIFIED by spatial bin so that for large regions
  // (e.g. UsCalifornia) ghosts spread across the whole region instead of
  // concentrating in whatever sub-area happens to dominate the POI catalog
  // (typically the densest metro). Without this stratification a region the
  // size of California with 30 vehicles produces ~3 ghosts that all cluster
  // in a single metro because the home_poi distribution is itself clustered.
  //
  // Each spatial bin gets `bin_size * probability` ghosts (stochastic rounding),
  // so the total expected ghost count is preserved while every populated bin
  // has a fair chance of contributing.
  const ghostCfg = config.ghost_trailer;
  if (ghostCfg && ghostCfg.probability > 0) {
    const BIN_DEG = 0.5;
    const bins = new Map<string, FleetMember[]>();
    for (const m of fleet) {
      const key = `${Math.floor(m.home_poi.lat / BIN_DEG)}|${Math.floor(m.home_poi.lng / BIN_DEG)}`;
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
  return fleet;
}
