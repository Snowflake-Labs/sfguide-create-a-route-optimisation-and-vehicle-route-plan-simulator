#!/usr/bin/env python3
"""Negative tests for fleet_tools/user/verify_map_spec.mts - each case
re-introduces a silent map failure the validators exist to reject (an inline
map binding viewState, an off-by-one layer cap, verb/client constant drift), or
the render_map compile probe defects that rejected a VALID live-routing layer."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

USER = ".cortex/skills/install-fleet-apps/fleet_tools/user"
CODES = f"{USER}/src/codes.ts"
SCHEMA = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/lib/map-spec-schema.ts"

h = Harness("verify_map_spec.mts", path=f"{USER}/verify_map_spec.mts", cwd=USER,
            cmd=["npx", "tsx"])

# --- render_map's compile probe (mapLayerCompileProbe) -------------------------
# Old defect 1: an UNTYPED NULL cannot resolve an overloaded function signature.
h.replace(CODES, "'NULL::VARCHAR'", "'NULL'", count=-1,
          expect="FAIL  probe: a bind becomes NULL::VARCHAR, the type /api/query really binds",
          name="probe binds an untyped NULL")
# Old defect 2: the leftover-bind regex also matched the second colon of `::TYPE`.
h.replace(CODES, "return probe.replace(/(?<!:):(?!:)[A-Za-z_][A-Za-z0-9_]*/g, 'NULL::VARCHAR');",
          "return probe.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, 'NULL::VARCHAR');",
          expect="FAIL  probe: ::FLOAT / ::VARIANT / ::VARCHAR casts survive untouched",
          name="probe leftover-bind regex eats ::TYPE casts")

# --- validators ---------------------------------------------------------------
# An inline map has no view state: a viewState.* param binds NULL and draws blank.
h.replace(SCHEMA, "if (!opts.allowViewState && ref.startsWith('viewState.')) {",
          "if (false && ref.startsWith('viewState.')) {",
          expect="FAIL  a viewState.* param is rejected on an inline map",
          name="viewState.* accepted on an inline map")
# Over-tightening: the render_view PAGE path must keep viewState.* legal.
h.replace(SCHEMA, "if (!opts.allowViewState && ref.startsWith('viewState.')) {",
          "if (ref.startsWith('viewState.')) {",
          expect="FAIL  viewState.* is legal on a rendered PAGE",
          name="viewState.* rejected on the render_view page path too")
# Off-by-one on the layer cap.
h.replace(SCHEMA, "if (raw.length > MAX_MAP_LAYERS) {", "if (raw.length >= MAX_MAP_LAYERS) {",
          expect="FAIL  exactly 4 layers is ACCEPTED (off-by-one guard)",
          name="layer cap off by one")
# The verb and client copies of the layer-type list drift apart.
h.replace(CODES, "export const MAP_LAYER_TYPES = ['scatterplot', 'path', 'h3', 'geojson', 'arc'] as const;",
          "export const MAP_LAYER_TYPES = ['scatterplot', 'path', 'h3', 'geojson', 'arc', 'heatmap'] as const;",
          expect="FAIL  MAP_LAYER_TYPES agrees across the trust boundary",
          name="verb MAP_LAYER_TYPES drifts from the client")

sys.exit(h.finish())
