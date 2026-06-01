// VROOM payload builder for AssetVelocity smart-reposition (Optimize Repositioning button).
// All capacity/cost/break/profile semantics are driven by the VEHICLE_CLASS_PROFILE row
// for CONFIG.VEHICLE_TYPE so the page works for any class (bicycle, ebike, foot,
// motorcycle, car, van, hgv, truck) without code changes.
//
// Returns the raw VROOM challenge object. The caller wraps it in
// OPENROUTESERVICE_APP.CORE.OPTIMIZATION(challenge, region).

import type { Trailer, Terminal, VehicleClass } from './helpers';
import { safeText } from './helpers';

// Skill IDs (arbitrary but stable):
//   1 = REEFER required, 2 = FLAT required, 3 = TANKER required, 4 = HAZMAT-capable
// Only emitted when the active class is a trucking class (ENFORCE_BREAK = true).
// For couriers/cars/ebikes there is no subtype, so no skill is emitted on either
// side and assignment is purely geographic / time-window driven.
export function skillsForTrailer(t: Trailer, klass: VehicleClass | null): number[] {
  if (!klass?.ENFORCE_BREAK) return [];
  const out: number[] = [];
  switch (t.VEHICLE_SUBTYPE) {
    case 'REEFER': out.push(1); break;
    case 'FLAT':   out.push(2); break;
    case 'TANKER': out.push(3); break;
    default: break;
  }
  if (t.HAZMAT) out.push(4);
  return out;
}

// Heuristic terminal-skill mapping. RESTAURANT -> REEFER is a trucking-only
// heuristic (chilled food trade), so disable it for non-trucking classes
// otherwise an ebike fleet can never serve a RESTAURANT terminal.
export function skillsForTerminal(t: Terminal, klass: VehicleClass | null): number[] {
  if (!klass?.ENFORCE_BREAK) return [];
  switch (t.LOCATION_TYPE) {
    case 'RESTAURANT': return [1];
    case 'STORE':      return [];
    case 'WAREHOUSE':  return [];
    case 'LOGISTICS':  return [];
    case 'DEPOT':      return [];
    case 'TERMINAL':   return [];
    default:           return [];
  }
}

// Service time per terminal scales with class. Trucking drop-and-hook is
// 10-30 min; courier/car stops are ~5 min.
export function serviceSecondsForTerminal(t: Terminal, klass: VehicleClass | null): number {
  if (klass?.ENFORCE_BREAK) {
    if (t.LOCATION_TYPE === 'WAREHOUSE' || t.LOCATION_TYPE === 'LOGISTICS') return 1800;
    if (t.LOCATION_TYPE === 'DEPOT' || t.LOCATION_TYPE === 'TERMINAL') return 600;
    return 900;
  }
  return 300;
}

// Local-day window 06:00-22:00. If the current time is already past close,
// roll forward to tomorrow's window so the solver always has a feasible day
// (otherwise VROOM silently returns routes:[] and the page shows 0 results).
export function terminalTimeWindow(_t: Terminal, baseEpoch: number): [number, number] {
  const offsetSec = new Date().getTimezoneOffset() * -60; // local - UTC, in seconds
  const localMidnight = Math.floor((baseEpoch + offsetSec) / 86400) * 86400 - offsetSec;
  let open  = localMidnight + 6 * 3600;
  let close = localMidnight + 22 * 3600;
  if (baseEpoch >= close) {
    open  += 86400;
    close += 86400;
  }
  return [open, close];
}

export interface VrpPayloadInput {
  trailers: Trailer[];
  terminals: Terminal[];
  profile: string;
  vehicleClass: VehicleClass | null;
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
  const { trailers, terminals, profile, vehicleClass, maxRepositionMinutes, nowEpoch } = input;
  // If terminals are closed for the rest of today, roll the shift to tomorrow's
  // 06:00 local so the vehicle window aligns with the (rolled-forward) terminal
  // windows. Otherwise the solver gets vehicle [now, now+cap] but every job's
  // window is in the future -> all unassigned -> 0 routes.
  const tomorrowOpen = terminals.length
    ? terminalTimeWindow(terminals[0], nowEpoch)[0]
    : nowEpoch;
  const shiftStart = Math.max(nowEpoch, tomorrowOpen);
  const shiftEnd = shiftStart + maxRepositionMinutes * 60;
  const enforceBreak = !!vehicleClass?.ENFORCE_BREAK;
  const maxStops = Math.max(1, terminals.length);
  // Per-vehicle capacity dim 1 = total kg the class can carry on the shift,
  // dim 2 = max single-shipment kg (informational; jobs deliver dim2=0).
  // Falls back to HGV-scale defaults if the class row is missing.
  const payloadKg = Math.max(1, Math.round(vehicleClass?.PAYLOAD_KG_TYP ?? 24000));
  const payloadMaxKg = Math.max(payloadKg, Math.round(vehicleClass?.PAYLOAD_KG_MAX ?? 26000));
  const shipmentKg = Math.max(1, Math.round(vehicleClass?.SHIPMENT_KG_MIN ?? 1));

  const jobs: VrpJob[] = terminals.map((t, i) => {
    const skillReq = skillsForTerminal(t, vehicleClass);
    const job: VrpJob = {
      id: i + 1,
      description: `${safeText(t.TERMINAL_NAME)} (${t.LOCATION_TYPE}) demand ${t.DEMAND_SCORE}`,
      location: [Number(t.TERMINAL_LNG), Number(t.TERMINAL_LAT)],
      service: serviceSecondsForTerminal(t, vehicleClass),
      priority: Math.min(100, Math.max(1, Math.round(Number(t.DEMAND_SCORE) || 1))),
      // delivery: [units consumed, payload_kg consumed, payload_max_kg consumed]
      // Each stop consumes 1 of `maxStops` units. Per-stop kg consumption is
      // intentionally tiny so the per-vehicle payload dim acts as a soft cap
      // on total stops, not a hard "drop after one delivery" constraint.
      delivery: [1, shipmentKg, 0],
      time_windows: [terminalTimeWindow(t, nowEpoch)],
    };
    if (skillReq.length) job.skills = skillReq;
    return job;
  });

  const vehicles: VrpVehicle[] = trailers.map((tr, i) => ({
    id: i + 1,
    description: `${safeText(tr.VEHICLE_ID, 32)} (${vehicleClass?.LABEL_NOUN ?? tr.VEHICLE_SUBTYPE ?? 'unit'})`,
    profile,
    start: [Number(tr.LAST_LNG), Number(tr.LAST_LAT)],
    // capacity: [stop slots, total payload kg, max-shipment kg]
    capacity: [maxStops, payloadKg, payloadMaxKg],
    skills: skillsForTrailer(tr, vehicleClass),
    time_window: [shiftStart, shiftEnd],
    max_travel_time: maxRepositionMinutes * 60,
    // EU 561/2006 mandatory 45-min break after 4.5h driving applies to HGVs
    // only. VEHICLE_CLASS_PROFILE.ENFORCE_BREAK is the canonical flag.
    breaks: enforceBreak ? [{
      id: 1000 + i,
      service: 2700,
      time_windows: [[shiftStart + 4 * 3600, shiftStart + 5 * 3600]],
    }] : [],
    // VROOM in this app's vroom-docker:v1.0.4 build does NOT accept the
    // {fixed, per_hour} pair (errors with "Custom costs are incompatible
    // with using a per_hour value"). We use only `fixed` to bias the solver
    // toward fewer-vehicle plans; per-hour cost is left as the VROOM default.
    costs: { fixed: 0 },
  }));

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
