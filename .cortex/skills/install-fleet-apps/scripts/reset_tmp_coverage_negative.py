#!/usr/bin/env python3
"""Negative tests for `reset_local_state.sh --check-tmp-coverage` (gate
reset_tmp_coverage) - each case makes an install script name a /tmp path the
fresh-machine reset would leave behind, and the self-check must name it.

M1 is the original defect: a docstring naming the SA and admin build logs in
shell brace form, which the literal scan reads as a bare `fleet_` prefix."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SCRIPTS = ".cortex/skills/install-fleet-apps/scripts"
# This file is itself inside the scanned tree, so every sample path is built
# from TMP: a literal temp-dir path here would turn the baseline red.
TMP = "/" + "tmp/"

h = Harness("reset_local_state.sh", args=["--check-tmp-coverage"],
            path=".cortex/skills/routing-solution-cleanup/scripts/reset_local_state.sh")

h.replace(f"{SCRIPTS}/check_next_build_warnings.py",
          f"into {TMP}fleet_sa_build.log and\n{TMP}fleet_admin_build.log while",
          f"into {TMP}fleet_{{sa,admin}}_build.log while",
          expect=f"does not clear: {TMP}fleet_",
          name="M1 the original bug: brace-form log path in a docstring")

h.add(f"{SCRIPTS}/new_step.sh", f"#!/usr/bin/env bash\nsnow sql -q 'SELECT 1' > {TMP}newstep_run.log 2>&1\n",
      expect=f"{TMP}newstep_run.log", name="M2 a new install script writing an uncovered log")

h.add(f"{SCRIPTS}/new_probe.py", f"open('{TMP}probe_scratch.json', 'w').write('{{}}')\n",
      expect=f"{TMP}probe_scratch.json", name="M3 a Python script writing uncovered scratch")

h.add(".cortex/skills/routing-agent/scripts/new_tool.sh", f"#!/usr/bin/env bash\necho x > {TMP}routing_tool.out\n",
      expect=f"{TMP}routing_tool.out", name="M4 the routing-agent skill is in scope too")

sys.exit(h.finish())
