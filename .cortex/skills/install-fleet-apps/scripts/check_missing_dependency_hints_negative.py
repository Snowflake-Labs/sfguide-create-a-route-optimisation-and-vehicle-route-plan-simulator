#!/usr/bin/env python3
"""Negative tests for check_missing_dependency_hints.py - each case re-creates a
way a missing layer goes back to showing a raw error or a guessed remedy.

M3 is the original defect: query_location with no missing-object guidance."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

UI = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src"
APP = ".cortex/skills/install-fleet-apps/fleet_sa_app/app"
MAP = f"{UI}/lib/repair-map.json"
ROUTE = f"{UI}/app/api/query/route.ts"
CALL = "    const missing = missingDependencyMessage(rawMsg, regionHint);\n"
GUIDANCE = " If it reports the object does not exist, the Location layer was not built"

h = Harness("check_missing_dependency_hints.py")

h.replace(MAP, '"prefix": "FLEET_APP.LABOR.",', '"prefix": "FLEET_APP.LABOUR_OLD.",',
          expect="A app-views.json: FLEET_APP.LABOR. has no repair-map.json entry",
          name="M1 a schema the views read loses its repair entry")

h.replace(ROUTE, CALL, "    // missingDependencyMessage(rawMsg, regionHint)\n    const missing = null as string | null;\n",
          expect="B route.ts: the catch never calls missingDependencyMessage()",
          name="M2 the call is commented out (a comment naming it must not count)")

h.replace(f"{APP}/agent-spec.json", GUIDANCE, " If it reports nothing, the layer was not built",
          expect="C agent-spec.json: query_location does not say",
          name="M3 the original defect: no missing-object guidance for the agent")

h.replace(f"{APP}/super-agent-spec.json", GUIDANCE, " If it reports nothing, the layer was not built",
          expect="C super-agent-spec.json: query_location does not say",
          name="M4 the regenerated super spec drops the guidance")

h.replace(MAP, '"CALL FLEET_INTELLIGENCE.LOCATION.BUILD_LOCATION_DIAGNOSTICS();"',
          '"Open the admin app and generate a Location dataset"',
          expect="D repair-map.json: the Location fix does not name BUILD_LOCATION_DIAGNOSTICS",
          name="M5 the Location fix is replaced by the invented generator")

h.replace(MAP, "It is not produced by the admin app Data Studio; there is no Location dataset generator.",
          "Generate a dataset in the admin app Data Studio.",
          expect="FLEET_APP.LOCATION. tells the user to generate a dataset",
          name="M6 a note sends the user to generate a dataset")

h.replace(ROUTE, "    const embedded = detectSuspendedInRows(rows);\n",
          "    const embedded = { suspended: false } as ReturnType<typeof detectSuspendedInRows>;\n",
          expect="E route.ts: the success path never calls detectSuspendedInRows(rows)",
          name="M7 the success path stops scanning rows for embedded engine errors")

sys.exit(h.finish())
