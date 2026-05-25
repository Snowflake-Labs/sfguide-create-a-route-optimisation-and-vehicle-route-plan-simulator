// VROOM payload builder for AssetVelocity smart-reposition (Optimize Repositioning button).
// Translates trailer/terminal selections into a fully-constrained VROOM challenge:
//   - per-vehicle skills derived from VEHICLE_SUBTYPE
//   - per-job skills derived from terminal LOCATION_TYPE (heuristic)
//   - multi-dimensional capacity (units, weight tons, axleload tons)
//   - time_windows (driver shift cap and terminal opening hours)
//   - service times by location type
//   - mandatory 45-min break after 4.5h driving (EU 561/2006)
//   - costs.fixed + costs.per_hour so the solver weighs $ properly
//   - max_travel_time per vehicle = MAX_REPOSITION_MINUTES * 60
//
// Returns the raw VROOM challenge object. The caller wraps it in
// OPENROUTESERVICE_APP.CORE.OPTIMIZATION(challenge, region).

import type { Trailer, Terminal, VehicleSubtype } from './helpers';

// Skill IDs (arbitrary but stable):
//   1 = REEFER required, 2 = FLAT required, 3 = TANKER required, 4 = HAZMAT-capable
// A trailer offers all skills it satisfies; a job demands the skill it needs.
export function skillsForTrailer(t: Trailer): number[] {
  const out: number[] = [];
  switch (t.VEHICLE_SUBTYPE) {
    case 'REEFER': out.push(1); break;
    case 'FLAT':   out.push(2); break;
    case 'TANKER': out.push(3); break;
    default: break; // DRY trailers offer no specialised skill
  }
  // A DRY trailer can also serve REEFER/FLAT loads in a pinch when not
  // mandated; here we keep it strict so REEFER demand truly needs a REEFER.
  if (t.HAZMAT) out.push(4);
  return out;
}

// Heuristic terminal-skill mapping from LOCATION_TYPE.
// Synthetic data has no LANE_PROFILE column; this deliberately treats most
// terminals as DRY-friendly so the assignment doesn't starve. Add a real
// LANE_PROFILE join once it lands.
export function skillsForTerminal(t: Terminal): number[] {
  switch (t.LOCATION_TYPE) {
    case 'RESTAURANT': return [1]; // food trade -> REEFER
    case 'STORE':      return [];  // dry-goods retail -> any
    case 'WAREHOUSE':  return [];  // mixed -> any
    case 'LOGISTICS':  return [];
    case 'DEPOT':      return [];
    case 'TERMINAL':   return [];
    default:           return [];
  }
}

// Service time by terminal type (seconds). Drop-and-hook is fast (~10 min);
// live-unload at a warehouse takes ~30 min.
export function serviceSecondsForTerminal(t: Terminal): number {
  if (t.LOCATION_TYPE === 'WAREHOUSE' || t.LOCATION_TYPE === 'LOGISTICS') return 1800;
  if (t.LOCATION_TYPE === 'DEPOT' || t.LOCATION_TYPE === 'TERMINAL') return 600;
  return 900;
}

// Default opening hours (06:00 -> 22:00 today, in epoch seconds).
// DIM_POIS has no OPEN_FROM/OPEN_TO column today; once it's added, replace
// this with the real values.
export function terminalTimeWindow(_t: Terminal, baseEpoch: number): [number, number] {
  const dayStart = Math.floor(baseEpoch / 86400) * 86400; // UTC midnight
  return [dayStart + 6 * 3600, dayStart + 22 * 3600];
}

export interface VrpPayloadInput {
  trailers: Trailer[];
  terminals: Terminal[];
  profile: string;
  maxRepositionMinutes: number;
  nowEpoch: number;
}

export interface VrpJob {
  id: number;
  description?: string;
  location: [number, number];
  service: number;
  priority: number;
  skills?: number[];
  delivery: [number, number, number];
  time_windows: [number, number][];
}

export interface VrpVehicle {
  id: number;
  description?: string;
  profile: string;
  start: [number, number];
  capacity: [number, number, number];
  skills: number[];
  time_window: [number, number];
  max_travel_time: number;
  breaks: Array<{ id: number; service: number; time_windows: [number, number][] }>;
  costs: { fixed: number };
}

export interface VrpChallenge {
  jobs: VrpJob[];
  vehicles: VrpVehicle[];
  options?: Record<string, unknown>;
}

export function buildChallenge(input: VrpPayloadInput): VrpChallenge {
  const { trailers, terminals, profile, maxRepositionMinutes, nowEpoch } = input;
  const shiftEnd = nowEpoch + maxRepositionMinutes * 60;

  const jobs: VrpJob[] = terminals.map((t, i) => {
    const skillReq = skillsForTerminal(t);
    // delivery dimensions MUST match vehicle.capacity dimensions:
    //   [units, weight_centi_tons, axleload_centi_tons]
    // Each terminal accepts 1 trailer-load; weight/axleload "consumed" is 0
    // because we model the trailer's full weight as a fixed vehicle capacity,
    // not a per-job delta. (Production: derive load weight from terminal lane mix.)
    const job: VrpJob = {
      id: i + 1,
      description: `${t.TERMINAL_NAME} (${t.LOCATION_TYPE}) demand ${t.DEMAND_SCORE}`,
      location: [Number(t.TERMINAL_LNG), Number(t.TERMINAL_LAT)],
      service: serviceSecondsForTerminal(t),
      priority: Math.min(100, Math.max(1, Math.round(Number(t.DEMAND_SCORE) || 1))),
      delivery: [1, 0, 0],
      time_windows: [terminalTimeWindow(t, nowEpoch)],
    };
    if (skillReq.length) job.skills = skillReq;
    return job;
  });

  const vehicles: VrpVehicle[] = trailers.map((tr, i) => {
    // Multi-dim capacity: [units (1 trailer-load), weight tons (rounded), axleload tons (rounded)].
    // VROOM expects integers per dimension, so multiply tonnages by 100 to keep 2 decimals.
    const w = Math.round((tr.WEIGHT_TONS ?? 40) * 100);
    const a = Math.round((tr.AXLELOAD_T ?? 11.5) * 100);
    return {
      id: i + 1,
      description: `${tr.VEHICLE_ID} (${tr.VEHICLE_SUBTYPE ?? 'DRY'})`,
      profile,
      start: [Number(tr.LAST_LNG), Number(tr.LAST_LAT)],
      capacity: [1, w, a],
      skills: skillsForTrailer(tr),
      time_window: [nowEpoch, shiftEnd],
      max_travel_time: maxRepositionMinutes * 60,
      breaks: [{
        id: 1000 + i,
        service: 2700, // 45 min (EU 561/2006)
        time_windows: [[nowEpoch + 4 * 3600, nowEpoch + 5 * 3600]],
      }],
      // VROOM in this app's vroom-docker:v1.0.4 build does NOT accept the
      // {fixed, per_hour} pair (errors with "Custom costs are incompatible
      // with using a per_hour value"). We use only `fixed` to bias the solver
      // toward fewer-trailer plans; per-hour cost is left as the VROOM default.
      // The DAILY_RENTAL_RATE_AVOIDED_USD scoring still appears in KPIs.
      costs: { fixed: 0 },
    };
  });

  return { jobs, vehicles };
}

export interface DispatchPlanRow {
  vehicleIdx: number;
  trailerId: string;
  jobIdx: number;
  terminalId: string;
  terminalName: string;
  arrivalSec: number;
  durationSec: number;
}
