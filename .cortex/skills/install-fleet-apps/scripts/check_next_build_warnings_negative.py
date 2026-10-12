#!/usr/bin/env python3
"""Negative tests for check_next_build_warnings.py - each case re-creates a
source of a "Compiled with warnings" production build, and the gate must name
the rule and the file.

M1 and M2 are the two original defects (admin globals.css `align-items: end`,
SA next.config without the `canvas` alias)."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SA = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui"
ADMIN = ".cortex/skills/install-fleet-apps/fleet_admin_app/ui"
ALIAS = "      canvas: false,\n"

h = Harness("check_next_build_warnings.py")

h.replace(f"{ADMIN}/src/app/globals.css", ".scale-row { display: flex; gap: 12px; align-items: flex-end; }",
          ".scale-row { display: flex; gap: 12px; align-items: end; }",
          expect="globals.css:151:46: end value has mixed support",
          name="M1 the original admin bug: align-items: end")

h.replace(f"{SA}/next.config.ts", ALIAS, "",
          expect="B .cortex/skills/install-fleet-apps/fleet_sa_app/ui: vega-canvas is installed",
          name="M2 the original SA bug: no canvas alias")

h.replace(f"{SA}/next.config.ts", ALIAS, "      // canvas: false,\n",
          expect="B .cortex/skills/install-fleet-apps/fleet_sa_app/ui",
          name="M3 alias commented out still reads as present")

h.add(f"{SA}/src/app/extra.css", ".toolbar { display: flex; justify-content: start; }\n",
      expect="fleet_sa_app/ui/src/app/extra.css:1",
      name="M4 a new stylesheet with another mixed-support value")

h.add(f"{ADMIN}/postcss.config.js", "module.exports = { plugins: {} };\n",
      expect="has its own PostCSS config",
      name="M5 an app config the mirrored pipeline would not match")

sys.exit(h.finish())
