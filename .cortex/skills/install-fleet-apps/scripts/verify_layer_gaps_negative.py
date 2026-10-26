#!/usr/bin/env python3
"""Negative tests for fleet_tools/user/verify_layer_gaps.mts - each case
re-introduces a way the deep_link dependency probe reports a working view as
"never built" (or a dead one as fine)."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

USER = ".cortex/skills/install-fleet-apps/fleet_tools/user"
MOD = f"{USER}/src/helpers.ts"

h = Harness("verify_layer_gaps.mts", path=f"{USER}/verify_layer_gaps.mts",
            cwd=USER, cmd=["npx", "tsx"])

# The shipped defect: the function branch of the UNION is not aliased.
h.replace(MOD, "|| FUNCTION_NAME AS F FROM", "|| FUNCTION_NAME FROM",
          expect="FAIL  function-only view that exists -> no gaps",
          name="function branch of the existence UNION unaliased")

# Existence read from the wrong column: every view looks unbuilt.
h.replace(MOD, "for (const r of rows) existing.add(String(r.F));",
          "for (const r of rows) existing.add(String(r.FQN));",
          expect="FAIL  function-only view that exists -> no gaps",
          name="existence read from a column the probe never returns")

# Functions never probed: every function-backed view looks unbuilt.
h.replace(MOD, "      if (fn.length) {", "      if (fn.length && false) {",
          expect="FAIL  function-only view that exists -> no gaps",
          name="function requirements skipped")

# Missing set computed from the wrong list: a dropped function passes.
h.replace(MOD, "missing: [...new Set(specs.filter((s) => !existing.has(s.fqn))",
          "missing: [...new Set(specs.filter((s) => s.mode !== 'function' && !existing.has(s.fqn))",
          expect="FAIL  function-only view whose function is absent -> reported missing",
          name="absent functions never reported missing")

sys.exit(h.finish())
