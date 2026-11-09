#!/usr/bin/env python3
"""Negative tests for check_admin_sql_inputs.py - each case re-opens a way a
raw routing profile or resolution could reach matrix-builder SQL, and the gate
must name the rule it breaks.

M1 is the original PR 160 finding: build/route.ts uppercased the raw profile
into TRAVEL_MATRIX table names."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

M = ".cortex/skills/install-fleet-apps/fleet_admin_app/ui/src/app/api/matrix"
BUILD = f"{M}/build/route.ts"
DELETE = f"{M}/[region]/[profile]/[resolution]/route.ts"
RESTORE = f"{M}/[region]/[profile]/[resolution]/restore/route.ts"
COST = f"{M}/cost-estimate/route.ts"
STATUS = f"{M}/status/route.ts"
LIB = ".cortex/skills/install-fleet-apps/fleet_admin_app/ui/src/server/lib/sanitize.ts"

h = Harness("check_admin_sql_inputs.py")

h.replace(BUILD, "    ({ profile: profileLit, upper: safeProfileUpper } = sanitizeProfile(reqProfile || 'driving-car'));\n",
          "    const profile = reqProfile || 'driving-car'; profileLit = profile; safeProfileUpper = profile.replace(/-/g, '_').toUpperCase();\n",
          expect="A build/route.ts: `profile.replace(`",
          name="M1 the original bug: raw profile uppercased into table names")
h.replace(BUILD, "    safeResolutions = sanitizeResolutions(resolutions);\n",
          "    safeResolutions = (resolutions as number[]).filter((r) => r >= 5 && r <= 10);\n",
          expect="A build/route.ts: `(resolutions as number[]).filter`",
          name="M2 the original range filter (lets 6e0 / 7.5 through)")
h.replace(DELETE, "    safeRes = sanitizeResolution(resolution);\n", "    safeRes = sanitizeIdentifier(resolution);\n",
          expect="A [region]/[profile]/[resolution]/route.ts: `sanitizeIdentifier(resolution)`",
          name="M3 DELETE takes any identifier as a resolution")
h.replace(RESTORE, "    safeProfile = escapeString(sanitizeProfile(profile).profile);\n",
          "    safeProfile = escapeString(profile);\n",
          expect="A [region]/[profile]/[resolution]/restore/route.ts: `escapeString(profile)`",
          name="M4 restore escapes instead of validating")
h.replace(COST, "      safeResolutions = sanitizeResolutions(resolutions);\n",
          "      safeResolutions = resolutions;\n",
          expect="B cost-estimate/route.ts does not call sanitizeResolutions",
          name="M5 cost-estimate interpolates unchecked resolutions into H3_COVERAGE_STRINGS")
h.replace(STATUS, "_${sanitizeProfile(j.profile).upper}_", "_${String(j.profile).toUpperCase()}_",
          expect="A status/route.ts: `String(j.profile ...)`",
          name="M6 status builds table names from stored rows unchecked")
h.replace(LIB, "!(ROUTING_PROFILES as readonly string[]).includes(val)", "!/^[a-z-]+$/.test(val)",
          expect="C sanitizeProfile does not check ROUTING_PROFILES",
          name="M7 profile pattern instead of the allowlist")
h.replace(LIB, "typeof r !== 'number' || !Number.isInteger(r) || ", "typeof r !== 'number' || ",
          expect="C sanitizeResolutions does not require Number.isInteger",
          name="M8 fractional resolutions accepted")
h.replace(LIB, "const MAX_RES = 10;", "const MAX_RES = 15;",
          expect="C MIN_RES/MAX_RES are not 5/10", name="M9 resolution range widened")
sys.exit(h.finish())
