#!/usr/bin/env python3
"""Negative tests for check_view_availability.py - each case re-creates a way a
view over a missing layer goes back to hidden-with-no-reason, dead-on-open, or
recommended by the agent."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SA = ".cortex/skills/install-fleet-apps/fleet_sa_app"
UI = f"{SA}/ui/src"
PROCS = ".cortex/skills/install-fleet-apps/fleet_tools/user/src/procs"

h = Harness("check_view_availability.py")

# The original walker read only top-level area queries.
h.replace(f"{UI}/lib/view-deps.ts", "    for (const v of Object.values(o)) collectQueries(v, out);\n", "",
          expect="A ",
          name="M1 view-deps.ts stops walking nested queries (drifts from layer_impact.py)")

h.replace(".cortex/skills/install-fleet-apps/fleet_sa_app/app/view_catalog.sql", "  REQUIRED_SCHEMAS      ARRAY", "  REQUIRED_SCHEMAZ      ARRAY",
          expect="B view_catalog.sql has no REQUIRED_SCHEMAS column",
          name="M2 the agent catalog loses the dependency column")

# The original gate: hide with no reason.
h.replace(f"{UI}/lib/load-views.tsx", "      hidden: view.hidden,\n", "      hidden: view.hidden || !!unavailable,\n",
          expect="C load-views derives `hidden` from something other than the authored view",
          name="M3 an unavailable view is hidden again")

h.replace(f"{UI}/lib/load-views.tsx", "      unavailable,\n", "",
          expect="C load-views never sets `unavailable`",
          name="M4 the reason never reaches the view def")

h.replace(f"{UI}/components/views/view-panel.tsx",
          "        {viewDef?.unavailable ? (\n          <UnavailableViewNotice label={viewDef.label} info={viewDef.unavailable} />\n        ) : viewDef ? (",
          "        {viewDef ? (",
          expect="D view-panel does not render UnavailableViewNotice",
          name="M5 an unavailable view mounts its failing panels")

h.replace(f"{UI}/app/api/pack-status/route.ts", "INFORMATION_SCHEMA.FUNCTIONS WHERE FUNCTION_SCHEMA", "INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA",
          expect="E pack-status lacks the function-only schema probe",
          name="M6 function-only schemas are no longer probed")

h.replace(f"{PROCS}/show_view.ts", "    const missing = await missingLayers(ctx.conn, viewId);\n",
          "    const missing: string[] = [];\n",
          expect="F show_view.ts never checks missingLayers()",
          name="M7 show_view hands over a dead view as working")

h.replace(f"{PROCS}/list_use_cases.ts", "           'missing_layers', M\n", "",
          expect="F list_use_cases does not return missing_layers",
          name="M8 the agent's catalog listing loses availability")

sys.exit(h.finish())
