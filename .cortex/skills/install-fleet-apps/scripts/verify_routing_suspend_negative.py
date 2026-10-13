#!/usr/bin/env python3
"""Negative tests for fleet_tools/user/verify_routing_suspend.mts - each case
re-introduces a misclassification between an ENGINE STATE (resume fixes it) and a
PAYLOAD DEFECT (only correcting the request fixes it), in both directions."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

USER = ".cortex/skills/install-fleet-apps/fleet_tools/user"
MOD = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/lib/routing-suspend.ts"

h = Harness("verify_routing_suspend.mts", path=f"{USER}/verify_routing_suspend.mts",
            cwd=USER, cmd=["npx", "tsx"])

# The historical bug: no off-graph precedence, so a 6010 refusal reported as
# `matrix_precompute_failed` became "the engine is starting". Both the string
# detector and the structured detector lose it.
h.replace(MOD, "  if (isOutOfGraph(text)) return { suspended: false, outOfGraph: true };\n", "",
          expect="FAIL  live message -> outOfGraph",
          name="off-graph precedence dropped from detectOrsSuspended")
_orig = h.path(MOD).read_text()


def _strip_both():
    a = "  if (isOutOfGraph(text)) return { suspended: false, outOfGraph: true };\n"
    b = "  if (isOutOfGraph(serialized)) return { suspended: false, outOfGraph: true };\n"
    assert a in _orig and b in _orig, "precedence anchors not found"
    h.path(MOD).write_text(_orig.replace(a, "").replace(b, ""))


h.custom(
    "off-graph precedence dropped from both detectors",
    _strip_both,
    lambda: h.path(MOD).write_text(_orig),
    expect="FAIL  live result object -> not suspended")

# Over-broadening the off-graph patterns silently disables auto-resume: a real
# matrix pre-compute outage must still read as suspended.
h.replace(MOD, "  /could not find routable point/i,\n",
          "  /could not find routable point/i,\n  /matrix_precompute_failed/i,\n",
          expect="FAIL  matrix_precompute_failed with no off-graph cause -> suspended",
          name="matrix_precompute_failed treated as off-graph")

# ORS reports lat first; passing it through unswapped puts SF in the Southern Ocean.
h.replace(MOD, "    const lat = Number(m[1]);\n    const lon = Number(m[2]);",
          "    const lon = Number(m[1]);\n    const lat = Number(m[2]);",
          expect="FAIL  lon is negative (San Francisco)",
          name="out-of-graph coordinates not swapped to lon,lat")

# The off-graph copy must never promise a wait.
h.replace(MOD, "`engine refused the request. The engine is healthy - waiting will not help. `",
          "`engine refused the request. It may still be starting - retry in a few minutes. `",
          expect="FAIL  message promises NO wait",
          name="off-graph message promises a wait")

# A warming-up engine is UP: classifying it as suspended claims a resume.
h.replace(MOD, "  /circuit_open/i,\n];", "  /circuit_open/i,\n  /service_warming_up/i,\n];",
          expect="FAIL  service_warming_up -> not_ready",
          name="service_warming_up classified as suspended")

sys.exit(h.finish())
