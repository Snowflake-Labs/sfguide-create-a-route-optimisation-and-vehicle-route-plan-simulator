// ----------------------------------------------------------------------------
// engine/shift-overrun.ts - how far past a rostered shift end a vehicle may keep
// working when it still has assigned jobs left.
//
// Pure and dependency-free on purpose: the RNG draw is passed IN rather than a
// generator function being called here, so the whole policy is testable without
// running a generation (see fleet_tools/user/verify_shift_overrun.mts).
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// The trip loop used to hard-stop at shift end and silently DISCARD the
// remaining assigned jobs. That made daily capacity equal to shift width and
// nothing else. Measured on a 100-vehicle e-bike fleet: throughput was a flat
// ~3.5 jobs/hour across all three shifts, the 13h shift finished 0.5h EARLY
// because it exhausted its assignment, while the 5h and 6h shifts stopped dead
// at the wall having delivered only 18.8 and 22.3 jobs at the same rate.
//
// So weekly hours reduced to `shift_width x days_worked`, with hard ceilings of
// 35h / 42h / 91h. Two of three cohorts could not reach a 40-hour overtime
// threshold at ANY horizon, and `trips_per_day` behaved as an unreachable
// ceiling rather than a workload.
//
// That inverts the real causality. In a real fleet overtime IS the overrun:
// nobody is rostered 13 hours, they are rostered 8 and the route takes 10.
//
// ---------------------------------------------------------------------------
// TWO CAPS, DELIBERATELY DIFFERENT
// ---------------------------------------------------------------------------
// `breaks.max_daily_driving_hours` is an hours-of-service LEGAL cap and stays a
// hard break in the trip loop. The shift boundary is a ROSTER cap and is what
// this module softens. A driver may finish a late route; they may not drive
// beyond permitted hours. Exceeding the legal cap stays rare and is modelled
// separately as IS_HOS_VIOLATION.
//
// ---------------------------------------------------------------------------
// WORKLOAD-DRIVEN BY CONSTRUCTION
// ---------------------------------------------------------------------------
// This returns an ALLOWANCE, not an instruction. The trip loop still stops when
// it runs out of assigned jobs, so a shift that exhausts its assignment gains
// nothing from a non-zero allowance and only a capacity-bound shift accrues
// overtime. That is what makes the resulting overtime explainable: it happened
// because the vehicle was given more work than fits.
// ----------------------------------------------------------------------------
import type { GenerationConfig } from '../profiles';

export type ShiftOverrunConfig = NonNullable<GenerationConfig['shift_overrun']>;

export interface OverrunAllowanceInput {
  /** Rostered shift start hour, 0-23. */
  shiftStartHour: number;
  /** Rostered shift end hour, 0-23. May be LESS than start for a night shift. */
  shiftEndHour: number;
  /** DRIVER_PROFILE of the vehicle's driver (COMPLIANT / MILD / OUTLIER / ...). */
  driverProfile: string;
  /** The preset's shift_overrun block. Undefined => no overrun. */
  cfg: ShiftOverrunConfig | undefined;
  /**
   * One RNG value in [0,1) for this vehicle-day. Passed in so this function
   * stays pure; the caller is responsible for drawing it exactly once per
   * vehicle-day (drawing it per trip would let the allowance change mid-shift).
   */
  draw: number;
}

/**
 * Hours the shift end may be exceeded by. 0 means the historical hard-stop
 * behaviour.
 */
export function overrunAllowanceHours(input: OverrunAllowanceInput): number {
  const { shiftStartHour, shiftEndHour, driverProfile, cfg, draw } = input;

  // Absent block or explicitly disabled reproduces the old behaviour exactly.
  if (!cfg || cfg.enabled === false) return 0;

  const probability = Number.isFinite(cfg.probability) ? cfg.probability : 0;
  if (probability <= 0) return 0;
  // Not every day runs late.
  if (draw > probability) return 0;

  const maxHours = Number.isFinite(cfg.max_hours) ? cfg.max_hours : 0;
  if (maxHours <= 0) return 0;

  // Per-driver persistence from the existing behaviour model: a consistently
  // slower driver is consistently later.
  //
  // A MISSING or non-finite entry is neutral (1.0), not zero, so a new profile
  // name appearing in a preset cannot silently switch overrun off for that whole
  // cohort. A NEGATIVE entry is different: it is nonsense config, but the
  // faithful reading of "less than no overrun" is none at all, so it is passed
  // through and clamped by the `cap <= 0` guard below. Falling back to neutral
  // there would invert the operator's evident intent into FULL overrun.
  const rawMultiplier = cfg.profile_multiplier?.[driverProfile];
  const multiplier = Number.isFinite(rawMultiplier) ? (rawMultiplier as number) : 1;

  const cap = maxHours * multiplier;
  if (cap <= 0) return 0;

  // Rest guard. Normalise a night shift (end < start) onto a continuous line,
  // then measure the gap to the SAME vehicle's next shift start 24h later. A
  // vehicle must never overrun so far that it eats the rest before its next
  // shift - and for a nearly-round-the-clock roster there is no room at all.
  const normalisedEnd = shiftEndHour <= shiftStartHour ? shiftEndHour + 24 : shiftEndHour;
  const nextShiftStart = shiftStartHour + 24;
  const gapToNextShift = nextShiftStart - normalisedEnd;
  const minRest = Number.isFinite(cfg.min_rest_hours) ? cfg.min_rest_hours : 0;
  const availableBeforeRest = gapToNextShift - minRest;

  if (availableBeforeRest <= 0) return 0;

  return Math.min(cap, availableBeforeRest);
}
