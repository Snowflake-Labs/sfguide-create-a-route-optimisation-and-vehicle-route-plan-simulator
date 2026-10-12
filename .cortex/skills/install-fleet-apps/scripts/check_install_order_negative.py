#!/usr/bin/env python3
"""Negative tests for check_install_order.py - one per ordering class it guards.

1. within-file, via CALL: the 0643d687 defect re-created exactly - the
   VW_REGION_PROFILE statement moved back BELOW analytic_layer.sql's guarded
   `CALL BUILD_LOCATION_DIAGNOSTICS()`, whose PRUNE_UNROUTABLE_HH_CELLS reads it
   at runtime. The old gate passed this (same-file CREATE counted anywhere).
2. within-file, direct: a top-level read placed above the CREATE it needs.
3. cross-file: a step reads a database no earlier step creates (the
   vehicle_profile_catalog.sql / FLEET_APP defect class).
4. precedence: the marketplace sources step moved after SV_OFFERS's step.
And two shapes that must NOT fire are proven by the green baseline: a
`DROP ... IF EXISTS` of the object before its CREATE, and a `CREATE TASK ... AS
CALL` (runs on schedule, not at load).
"""
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

S = ".cortex/skills/install-fleet-apps/scripts"
AL = f"{S}/analytic_layer.sql"
h = Harness("check_install_order.py")

p = h.path(AL)
original = p.read_text()
m = re.search(r"CREATE OR REPLACE VIEW FLEET_APP\.CORE\.VW_REGION_PROFILE\b.*?;\n", original, re.S)
assert m, "VW_REGION_PROFILE statement not found - update this test"
view_stmt = m.group(0)


def move_view_to_end():
    p.write_text(original.replace(view_stmt, "", 1) + "\n" + view_stmt)
    assert p.read_text() != original


h.custom("VW_REGION_PROFILE created after the CALL that reads it (0643d687)",
         move_view_to_end, lambda: p.write_text(original),
         expect="reaches FLEET_APP.CORE.VW_REGION_PROFILE through CALL")
h.replace(AL, view_stmt,
          "SELECT COUNT(*) FROM FLEET_APP.CORE.VW_REGION_PROFILE_NEGTEST;\n" + view_stmt
          + "CREATE OR REPLACE VIEW FLEET_APP.CORE.VW_REGION_PROFILE_NEGTEST AS SELECT 1 AS X;\n",
          expect="VW_REGION_PROFILE_NEGTEST through a load-time statement",
          name="top-level read above the CREATE it needs")
h.replace(f"{S}/seed_data.sql", "\n", "\nSELECT * FROM NEGTEST_LATER_DB.CORE.SOMETHING;\n",
          expect="references NEGTEST_LATER_DB.CORE.SOMETHING before anything creates it",
          name="cross-file: a database no earlier step creates")

GATE = h.root / S / "check_install_order.py"
GATE_SRC = GATE.read_text()


def _swap_order():
    mk = re.search(r'    \("4\.4 marketplace",[^\n]*\n', GATE_SRC).group(0)
    sv = re.search(r'    \("4\.5 semantic \(mkt\)",[^\n]*\n', GATE_SRC).group(0)
    GATE.write_text(GATE_SRC.replace(mk, "", 1).replace(sv, sv + mk, 1))
    assert GATE.read_text() != GATE_SRC


h.custom("precedence: marketplace sources after SV_OFFERS",
         _swap_order, lambda: GATE.write_text(GATE_SRC),
         expect="'4.4 marketplace' must run BEFORE '4.5 semantic (mkt)'")
sys.exit(h.finish())
