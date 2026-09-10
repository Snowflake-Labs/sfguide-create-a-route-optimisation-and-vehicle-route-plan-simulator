// Regression test for engine/shift-overrun.ts - the ROSTER-vs-LEGAL cap split.
//
// Run with: npx tsx verify_shift_overrun.mts   (from fleet_tools/user)
//
// It lives here rather than under fleet_admin_app/ui for one practical reason:
// this package already carries tsx as a devDependency, while the admin app UI
// does not - running it there makes npx block on an interactive install prompt
// and then re-download tsx on every invocation. shift-overrun.ts is
// dependency-free pure TypeScript (its only import is a `type`, which erases at
// compile time), so a relative import works.
//
// WHAT THIS PROTECTS
//
// The trip loop used to hard-stop at shift end and silently DISCARD the
// remaining assigned jobs, which made daily capacity equal to shift width and
// nothing else. Measured on a 100-vehicle e-bike fleet: a flat ~3.5 jobs/hour on
// every shift, the 13h shift finishing 0.5h EARLY because it exhausted its
// assignment, and the 5h and 6h shifts stopping dead at the wall after 18.8 and
// 22.3 jobs. Weekly hours collapsed to `shift_width x days_worked` with hard
// ceilings of 35h / 42h / 91h, so two of three cohorts could never reach a
// 40-hour overtime threshold at any horizon.
//
// Both directions matter here. Under-shooting reproduces that dead end.
// Over-shooting is worse: an allowance that ignores the rest guard would let a
// vehicle work into its own next shift, and one that leaked past
// `breaks.max_daily_driving_hours` would manufacture hours-of-service breaches
// that are supposed to be rare and separately modelled. This file asserts the
// allowance policy; the loop's LEGAL cap is a separate hard break in engine.ts
// and is deliberately NOT softened by anything here.
import { overrunAllowanceHours } from '../../fleet_admin_app/ui/src/server/studio/engine/shift-overrun';
import type { ShiftOverrunConfig } from '../../fleet_admin_app/ui/src/server/studio/engine/shift-overrun';

let fails = 0;
function chk(label: string, ok: boolean) {
  if (!ok) { fails++; console.log(`FAIL  ${label}`); } else { console.log(`ok    ${label}`); }
}
function near(a: number, b: number, eps = 1e-9) { return Math.abs(a - b) < eps; }

// The shipped preset values, so this test tracks what actually generates data.
const cfg: ShiftOverrunConfig = {
  enabled: true,
  probability: 0.4,
  max_hours: 2.5,
  min_rest_hours: 8,
  profile_multiplier: { COMPLIANT: 0.6, MILD: 1.0, OUTLIER: 1.6 },
};

// A draw at or below probability makes the day eligible; above it does not.
const DRAW_ELIGIBLE = 0.1;
const DRAW_NOT = 0.9;

// The three real e-bike shifts plus the two real HGV shifts, by (start, end).
const SHIFT_10_15 = { shiftStartHour: 10, shiftEndHour: 15 };  // 5h
const SHIFT_17_23 = { shiftStartHour: 17, shiftEndHour: 23 };  // 6h
const SHIFT_10_23 = { shiftStartHour: 10, shiftEndHour: 23 };  // 13h
const SHIFT_DAY   = { shiftStartHour: 5,  shiftEndHour: 17 };  // 12h, hgv
const SHIFT_NIGHT = { shiftStartHour: 18, shiftEndHour: 4  };  // 10h, hgv, crosses midnight

// --- disabled / absent config reproduces the historical hard stop EXACTLY ----
// This is the escape hatch. If it ever returns non-zero, every existing dataset
// becomes irreproducible and the six demos built on them shift silently.
chk('undefined cfg -> 0 (historical hard stop)',
  overrunAllowanceHours({ ...SHIFT_10_15, driverProfile: 'MILD', cfg: undefined, draw: DRAW_ELIGIBLE }) === 0);
chk('enabled:false -> 0',
  overrunAllowanceHours({ ...SHIFT_10_15, driverProfile: 'MILD', cfg: { ...cfg, enabled: false }, draw: DRAW_ELIGIBLE }) === 0);
chk('probability 0 -> 0',
  overrunAllowanceHours({ ...SHIFT_10_15, driverProfile: 'MILD', cfg: { ...cfg, probability: 0 }, draw: 0 }) === 0);
chk('max_hours 0 -> 0',
  overrunAllowanceHours({ ...SHIFT_10_15, driverProfile: 'MILD', cfg: { ...cfg, max_hours: 0 }, draw: DRAW_ELIGIBLE }) === 0);

// --- not every day runs late -------------------------------------------------
chk('draw above probability -> 0',
  overrunAllowanceHours({ ...SHIFT_10_15, driverProfile: 'MILD', cfg, draw: DRAW_NOT }) === 0);
chk('draw at probability boundary is eligible',
  overrunAllowanceHours({ ...SHIFT_10_15, driverProfile: 'MILD', cfg, draw: 0.4 }) > 0);

// --- the capacity-bound short shifts DO get an allowance --------------------
// These are the cohorts that could not previously reach 40h/week at any horizon.
chk('10-15 MILD -> full 2.5h cap',
  near(overrunAllowanceHours({ ...SHIFT_10_15, driverProfile: 'MILD', cfg, draw: DRAW_ELIGIBLE }), 2.5));
chk('17-23 MILD -> full 2.5h cap',
  near(overrunAllowanceHours({ ...SHIFT_17_23, driverProfile: 'MILD', cfg, draw: DRAW_ELIGIBLE }), 2.5));

// --- per-driver persistence scales the cap ----------------------------------
chk('COMPLIANT gets 0.6x (1.5h)',
  near(overrunAllowanceHours({ ...SHIFT_10_15, driverProfile: 'COMPLIANT', cfg, draw: DRAW_ELIGIBLE }), 1.5));
chk('OUTLIER gets 1.6x (4.0h) where rest allows',
  near(overrunAllowanceHours({ ...SHIFT_10_15, driverProfile: 'OUTLIER', cfg, draw: DRAW_ELIGIBLE }), 4.0));
// An unknown profile must be NEUTRAL, not zero: a new profile name appearing in
// a preset must not silently switch overrun off for that cohort.
chk('unknown profile -> neutral 1.0x, not 0',
  near(overrunAllowanceHours({ ...SHIFT_10_15, driverProfile: 'BRAND_NEW', cfg, draw: DRAW_ELIGIBLE }), 2.5));

// --- the rest guard clips a cap that would eat the next shift ---------------
// 10-23 leaves an 11h gap; with 8h minimum rest only 3h is available, so an
// OUTLIER's 4.0h cap must be clipped to 3.0h rather than honoured.
chk('10-23 OUTLIER clipped by rest guard to 3.0h',
  near(overrunAllowanceHours({ ...SHIFT_10_23, driverProfile: 'OUTLIER', cfg, draw: DRAW_ELIGIBLE }), 3.0));
chk('10-23 MILD still gets its 2.5h (under the 3h available)',
  near(overrunAllowanceHours({ ...SHIFT_10_23, driverProfile: 'MILD', cfg, draw: DRAW_ELIGIBLE }), 2.5));
// A near-round-the-clock roster has no room at all. Without this guard the
// vehicle would work straight into its own next shift.
chk('22h roster (0-22) -> 0, no room before rest',
  overrunAllowanceHours({ shiftStartHour: 0, shiftEndHour: 22, driverProfile: 'MILD', cfg, draw: DRAW_ELIGIBLE }) === 0);
chk('20h roster (0-20) -> 0, still inside min rest',
  overrunAllowanceHours({ shiftStartHour: 0, shiftEndHour: 20, driverProfile: 'MILD', cfg, draw: DRAW_ELIGIBLE }) === 0);

// --- a night shift crossing midnight computes the same as a day shift -------
// The normalisation bug class this guards: treating end<start literally makes
// the gap negative and silently zeroes (or explodes) the allowance for every
// night-shift vehicle. HGV Night is 18-04.
chk('HGV Night 18-04 MILD -> 2.5h (crosses midnight)',
  near(overrunAllowanceHours({ ...SHIFT_NIGHT, driverProfile: 'MILD', cfg, draw: DRAW_ELIGIBLE }), 2.5));
chk('HGV Day 5-17 MILD -> 2.5h',
  near(overrunAllowanceHours({ ...SHIFT_DAY, driverProfile: 'MILD', cfg, draw: DRAW_ELIGIBLE }), 2.5));
// Night 18-04 leaves a 14h gap so 6h is available: an OUTLIER's 4.0h is NOT
// clipped, unlike the 13h day shift above. Asserts the guard is computed from
// the actual gap and not a constant.
chk('HGV Night 18-04 OUTLIER -> full 4.0h (14h gap, not clipped)',
  near(overrunAllowanceHours({ ...SHIFT_NIGHT, driverProfile: 'OUTLIER', cfg, draw: DRAW_ELIGIBLE }), 4.0));

// --- malformed config must degrade to safe, not to NaN ----------------------
// A NaN allowance would make `currentHour >= shiftEnd + NaN` always false and
// run the loop to its trip limit, producing absurd duty spans with no error.
const bad = { enabled: true, probability: NaN, max_hours: NaN, min_rest_hours: NaN } as unknown as ShiftOverrunConfig;
chk('NaN config -> 0, never NaN',
  overrunAllowanceHours({ ...SHIFT_10_15, driverProfile: 'MILD', cfg: bad, draw: DRAW_ELIGIBLE }) === 0);
const negMult = { ...cfg, profile_multiplier: { MILD: -3 } };
chk('negative multiplier -> 0, never negative',
  overrunAllowanceHours({ ...SHIFT_10_15, driverProfile: 'MILD', cfg: negMult, draw: DRAW_ELIGIBLE }) === 0);
const r = overrunAllowanceHours({ ...SHIFT_10_15, driverProfile: 'MILD', cfg, draw: DRAW_ELIGIBLE });
chk('result is finite', Number.isFinite(r));

console.log(fails ? `\n${fails} FAILURE(S)` : `\nall 22 assertions passed`);
process.exit(fails ? 1 : 0);
