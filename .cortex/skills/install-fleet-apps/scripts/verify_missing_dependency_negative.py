#!/usr/bin/env python3
"""Negative tests for fleet_sa_app/ui/scripts/verify-missing-dependency.mts -
each case breaks lib/missing-dependency.ts the way it could plausibly regress,
and the suite must fail on the check that describes it."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

LIB = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/lib/missing-dependency.ts"
MAP = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/lib/repair-map.json"

UI = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui"
h = Harness("verify-missing-dependency.mts", path=f"{UI}/scripts/verify-missing-dependency.mts",
            cwd=UI, cmd=["npx", "tsx"])

h.replace(LIB, "|Unknown user-defined (?:table )?function\\s+([A-Za-z0-9_$.\"]+)", "",
          expect="FAIL  UDTF error parses its name",
          name="M1 the UDTF shape (LIVE_* functions) stops matching")

h.replace(LIB, ".replace(/\"/g, '')", "",
          expect="FAIL  quoted identifiers are unquoted",
          name="M2 quoted identifiers are no longer unquoted")

h.replace(LIB, "s.replace('{region}', region || '<region>')", "s.replace('{region}', String(region))",
          expect="FAIL  no region -> placeholder",
          name="M3 a null region renders as the word null")

h.replace(MAP, '"CALL FLEET_INTELLIGENCE.LOCATION.BUILD_LOCATION_DIAGNOSTICS();"',
          '"Generate a Location dataset in the admin app"',
          expect="FAIL  object: names BUILD_LOCATION_DIAGNOSTICS",
          name="M4 the original defect: the Location fix points at a generator")

sys.exit(h.finish())
