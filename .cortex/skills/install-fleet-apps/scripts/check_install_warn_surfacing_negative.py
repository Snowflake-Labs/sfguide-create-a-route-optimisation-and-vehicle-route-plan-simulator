#!/usr/bin/env python3
"""Negative tests for check_install_warn_surfacing.py - each case re-creates a way
a skipped layer goes back to a bare WARN, or a clean run starts warning."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

S = ".cortex/skills/install-fleet-apps/scripts"
HELPER = f"{S}/layer_impact.py"
INSTALLER = f"{S}/install_fleet_apps.sh"

h = Harness("check_install_warn_surfacing.py")

h.replace(HELPER, "        for msg in _result_cells(text.splitlines()):\n",
          "        for msg in _result_cells(text.splitlines()) + [l.split(\"'\", 1)[-1] for l in text.splitlines() if \"'WARN:\" in l]:\n",
          expect="B the builder's echoed RETURN 'WARN:' source was reported as a failure",
          name="M1 echoed builder source is read as a result (the original step-3.5 trap)")

h.replace(HELPER, "            if part:\n                data.append(part)\n",
          "            if part and not data:\n                data.append(part)\n",
          expect="F a wrapped WARN cell lost its tail",
          name="M8 only the first wrapped line of a cell is kept (the line-regex behaviour)")

h.replace(INSTALLER, '[ -n "$SUMMARY_REGION" ] && DEGRADED_ARGS+=(--region "$SUMMARY_REGION")\n', "",
          expect="G installer does not pass --region to layer_impact.py",
          name="M9 fixes print '<region>' again")

h.replace(HELPER, "    return sorted(p for p in glob.glob(pattern) if os.path.getmtime(p) >= since)",
          "    return sorted(glob.glob(pattern))",
          expect="C a log older than the run was reported",
          name="M2 stale /tmp logs are read as this run's")

h.replace(HELPER, '    for word, layer in (("LOCATION DIAGNOSTICS", "location"), ("BUILD_LOCATION_", "location"),',
          '    for word, layer in (("NO_SUCH_WORD", "location"), ("NO_SUCH_WORD_2", "location"),',
          expect="A2 the 'Location diagnostics skipped' WARN does not map to Location",
          name="M3 the prose fallback is gone (the skipped-region WARN names no procedure)")

h.replace(HELPER, '    """Map a builder\'s WARN line to its layer by the builder it names."""\n',
          '    """Map a builder\'s WARN line to its layer by the builder it names."""\n    return None\n',
          expect="A a Location WARN row does not name 'Site Impact'",
          name="M4 no WARN maps to any layer")

h.replace(INSTALLER, ' --since "$START_TS"', "",
          expect='D installer does not pass --since "$START_TS"',
          name="M5 the installer stops scoping logs to this run")

h.replace(INSTALLER, '  echo "$DEGRADED_TXT"\n', "",
          expect="D the console summary never prints DEGRADED_TXT",
          name="M6 the console summary drops the block (a bare WARN again)")

h.replace(HELPER, "                targets = [e]\n",
          "                v = views.get(r.get(\"view\"))\n                targets = [x for s in view_schemas(v) for x in [entry_for_schema(s, entries)] if x]\n",
          expect="E a view-check ERROR blamed every schema the view reads",
          name="M7 an ERROR is blamed on every schema the view reads (the original over-attribution)")

h.replace(INSTALLER, '  echo " not OK: ${NONOK_STEPS} (details in that step\'s output above)"\n',
          '  echo " - see the status table"\n',
          expect="H the console points at a status table",
          name="M10 the finale points at the friction-log-only status table again")

h.replace(INSTALLER, '| while IFS= read -r l; do note "        failing: $l"; done || true\n', "",
          expect="I step 9 WARN does not name the failing views",
          name="M11 step 9 prints only the tally (EMPTY=1, no view named)")

h.replace(INSTALLER, "sed 's/,/, /g' || true)\n", "sed 's/,/, /g')\n",
          expect="J a clean run aborts under set -euo pipefail before the finale",
          name="M12 NONOK_STEPS grep without || true (the cycle-3 exit 1)")

h.replace(INSTALLER, 'note "        failing: $l"; done || true\n', 'note "        failing: $l"; done\n',
          expect="J a clean run aborts under set -euo pipefail before the finale",
          name="M13 step-9 failing-view pipeline without || true")

sys.exit(h.finish())
