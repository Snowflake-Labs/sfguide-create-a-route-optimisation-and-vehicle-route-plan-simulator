#!/usr/bin/env python3
"""Negative tests for fleet_tools/user/verify_shift_overrun.mts - each case
breaks one half of the ROSTER-vs-LEGAL allowance policy: the historical hard
stop escape hatch, the rest guard, night-shift normalisation, per-driver scaling
and the NaN/negative degradation."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

USER = ".cortex/skills/install-fleet-apps/fleet_tools/user"
MOD = ".cortex/skills/install-fleet-apps/fleet_admin_app/ui/src/server/studio/engine/shift-overrun.ts"

h = Harness("verify_shift_overrun.mts", path=f"{USER}/verify_shift_overrun.mts", cwd=USER,
            cmd=["npx", "tsx"])

# enabled:false must reproduce the historical hard stop exactly.
h.replace(MOD, "if (!cfg || cfg.enabled === false) return 0;", "if (!cfg) return 0;",
          expect="FAIL  enabled:false -> 0",
          name="enabled:false no longer honoured")

# The rest guard: an allowance that ignores it works into the next shift.
h.replace(MOD, "return Math.min(cap, availableBeforeRest);", "return cap;",
          expect="FAIL  10-23 OUTLIER clipped by rest guard to 3.0h",
          name="rest guard no longer clips the cap")

# Night shift read literally: end < start is not normalised, so the gap to the
# next shift is overstated and the rest guard never bites on a night roster.
h.replace(MOD, "const normalisedEnd = shiftEndHour <= shiftStartHour ? shiftEndHour + 24 : shiftEndHour;",
          "const normalisedEnd = shiftEndHour;",
          expect="FAIL  HGV Night 18-04 cap above the 6h available -> clipped to 6.0h",
          name="night shift end not normalised across midnight")

# An unknown profile must be neutral, not zero.
h.replace(MOD, "? (rawMultiplier as number) : 1;", "? (rawMultiplier as number) : 0;",
          expect="FAIL  unknown profile -> neutral 1.0x, not 0",
          name="unknown driver profile switches overrun off")

# A negative multiplier must clamp to none, not fall back to full overrun.
h.replace(MOD, "Number.isFinite(rawMultiplier) ? (rawMultiplier as number)",
          "Number.isFinite(rawMultiplier) && (rawMultiplier as number) > 0 ? (rawMultiplier as number)",
          expect="FAIL  negative multiplier -> 0, never negative",
          name="negative multiplier falls back to neutral (full overrun)")

# NaN config must degrade to 0, never to a NaN allowance.
mod = h.path(MOD)
mod_original = mod.read_text()


def drop_finite_guards():
    a = "Number.isFinite(cfg.probability) ? cfg.probability : 0"
    b = "Number.isFinite(cfg.max_hours) ? cfg.max_hours : 0"
    assert a in mod_original and b in mod_original, "finite-guard anchors not found"
    mod.write_text(mod_original.replace(a, "cfg.probability").replace(b, "cfg.max_hours"))


h.custom("NaN probability/max_hours passed through unguarded", drop_finite_guards,
         lambda: mod.write_text(mod_original), expect="FAIL  NaN config -> 0, never NaN")

sys.exit(h.finish())
