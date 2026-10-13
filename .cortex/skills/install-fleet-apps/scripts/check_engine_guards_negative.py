#!/usr/bin/env python3
"""Negative tests for check_engine_guards.py - each case puts an object whose
CREATE needs the routing engine back into an engine-free installer file, and the
gate must name the file and the engine function.

The historical defect: analytic_layer.sql defined its live-routing UDTFs inline;
on an engine-less account the first CREATE FUNCTION failed at load and `snow sql
-f` silently dropped ~129 later statements. Cases also cover the gate's derived
function list (a new engine function is covered automatically) and its guard
against an empty list."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SK = ".cortex/skills/install-fleet-apps"
LIVE = f"{SK}/scripts/analytic_layer_live_routing.sql"
ANALYTIC = f"{SK}/scripts/analytic_layer.sql"
MODULES = f"{SK}/openrouteservice_app/app/modules"

h = Harness("check_engine_guards.py")


def append_case(name: str, rel: str, sql: str, expect: str) -> None:
    p = h.path(rel)
    original = p.read_text()
    h.custom(name, lambda: p.write_text(original + "\n" + sql + "\n"),
             lambda: p.write_text(original), expect=expect)


def live_zip_bands() -> str:
    """The real LIVE_ZIP_BANDS UDTF, lifted verbatim from the live-routing file."""
    text = h.path(LIVE).read_text()
    start = text.index("CREATE OR REPLACE FUNCTION FLEET_APP.LOCATION.LIVE_ZIP_BANDS")
    return text[start: text.index("\n$$;\n", start) + 4]


# The exact historical defect: a live-routing UDTF moved back inline.
append_case("live-routing UDTF moved back into analytic_layer.sql", ANALYTIC, live_zip_bands(),
            expect="analytic_layer.sql:")
append_case("live-routing UDTF names the engine function", ANALYTIC, live_zip_bands(),
            expect="creates FLEET_APP.LOCATION.LIVE_ZIP_BANDS which calls OPENROUTESERVICE_APP.CORE.ISOCHRONES")

# A plain view in another engine-free file.
append_case("view calling the engine in delivery_sync_layer.sql", f"{SK}/scripts/delivery_sync_layer.sql",
            "CREATE OR REPLACE VIEW FLEET_APP.DELIVERY_SYNC.VW_NEGTEST AS\n"
            "SELECT OPENROUTESERVICE_APP.CORE.MATRIX('driving-car', ARRAY_CONSTRUCT()) AS M;",
            expect="delivery_sync_layer.sql")

# CTAS with IF NOT EXISTS in the seed file.
append_case("CTAS calling the engine in seed_data.sql", f"{SK}/scripts/seed_data.sql",
            "CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.NEGTEST_ROUTES AS\n"
            "SELECT OPENROUTESERVICE_APP.CORE.DIRECTIONS('driving-car', ARRAY_CONSTRUCT()) AS R;",
            expect="creates FLEET_INTELLIGENCE.CORE.NEGTEST_ROUTES which calls OPENROUTESERVICE_APP.CORE.DIRECTIONS")

# The same UDTF, indented (Snowflake accepts leading whitespace before CREATE).
append_case("indented engine-dependent CREATE FUNCTION", ANALYTIC,
            "\n".join("  " + ln for ln in live_zip_bands().split("\n")),
            expect="creates FLEET_APP.LOCATION.LIVE_ZIP_BANDS which calls OPENROUTESERVICE_APP.CORE.ISOCHRONES")

# A function newly added to an engine module is covered with no gate edit.
mod = h.path(f"{MODULES}/02_routing_functions.sql")
mod_orig = mod.read_text()
view_file = h.path(f"{SK}/fleet_sa_app/app/view_catalog.sql")
view_orig = view_file.read_text()


def add_new_engine_fn():
    mod.write_text(mod_orig + "\nCREATE OR REPLACE FUNCTION CORE.NEGTEST_SNAP(P VARIANT) RETURNS VARIANT AS 'P';\n")
    view_file.write_text(view_orig + "\nCREATE OR REPLACE VIEW FLEET_APP.CORE.VW_NEGTEST AS\n"
                         "SELECT OPENROUTESERVICE_APP.CORE.NEGTEST_SNAP(NULL) AS S;\n")


h.custom("new engine function is covered automatically", add_new_engine_fn,
         lambda: (mod.write_text(mod_orig), view_file.write_text(view_orig)),
         expect="calls OPENROUTESERVICE_APP.CORE.NEGTEST_SNAP")

# The derived function list must never be empty (that would pass every file).
mods = h.path(MODULES)
moved = h.path(MODULES + "_moved")
h.custom("engine modules missing (empty function list)",
         lambda: mods.rename(moved), lambda: moved.rename(mods),
         expect="no OPENROUTESERVICE_APP.CORE functions found")

sys.exit(h.finish())
