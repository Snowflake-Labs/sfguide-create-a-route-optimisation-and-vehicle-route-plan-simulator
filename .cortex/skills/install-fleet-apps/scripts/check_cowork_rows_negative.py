#!/usr/bin/env python3
"""Negative tests for check_cowork_rows.py - each case re-introduces one way a
routing result stops being drawable in CoWork, and the gate must name it."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SK = ".cortex/skills/install-fleet-apps"
PROCS = f"{SK}/fleet_tools/user/src/procs"
MAP_ROWS = f"{SK}/fleet_tools/user/src/map_rows.ts"
ENVELOPE = f"{SK}/fleet_tools/vendor/synapse/src/runtime/envelope.ts"
SPEC = f"{SK}/fleet_sa_app/app/agent-spec.json"
SUPER = f"{SK}/fleet_sa_app/app/super-agent-spec.json"
DEPLOY = ".cortex/skills/routing-agent/references/deploy-agent.sql"
SVS = f"{SK}/fleet_sa_app/app/semantic_views.sql"
ROLE = f"{SK}/fleet_sa_app/app/role_binding.sql"

h = Harness("check_cowork_rows.py")

# A: a geometry verb goes back to the bare result (the shipped defect).
h.replace(f"{PROCS}/get_directions.ts",
          "return withMapRows(ctx, 'get_directions', result, geometryAt('geometry'));", "return { result };",
          expect="A get_directions.ts: does not return withMapRows", name="directions returns bare result")
# A: rows declared nowhere - the envelope would drop it.
h.replace(f"{PROCS}/snap_to_road.ts",
          "    rows: t.array(t.object({})).nullable().describe(ROWS_DESCRIPTION),\n", "",
          expect="A snap_to_road.ts: returns does not declare a nullable `rows`", name="snap drops rows decl")
# A: the call survives only inside a comment.
h.replace(f"{PROCS}/catchment.ts",
          "    return withMapRows(ctx, 'catchment', result, geometryAt('geometry'));",
          "    // return withMapRows(ctx, 'catchment', result, geometryAt('geometry'));\n    return { result } as never;",
          expect="A catchment.ts: does not return withMapRows", name="withMapRows only in a comment")
# A: result_id not declared - the envelope drops the id CoWork draws from.
h.replace(f"{PROCS}/compute_isochrone.ts",
          "    result_id: t.string().nullable().describe(RESULT_ID_DESCRIPTION),\n", "",
          expect="A compute_isochrone.ts: returns does not declare a nullable `result_id`",
          name="isochrone drops result_id decl")
# A: a copy-pasted verb name would file rows under the wrong verb.
h.replace(f"{PROCS}/find_poi.ts", "withMapRows(ctx, 'find_poi',", "withMapRows(ctx, 'catchment',",
          expect="A find_poi.ts: withMapRows records verb 'catchment'", name="wrong verb name recorded")
# B: a verb with nothing to draw gains rows.
h.replace(f"{PROCS}/deep_link.ts", "export const deep_link", "import { withMapRows } from '../map_rows.js';\nexport const deep_link",
          expect="B deep_link.ts: is not a geometry verb but calls withMapRows", name="deep_link uses withMapRows")
# C: rows built on FAILED payloads.
h.replace(MAP_ROWS, "  if (String(result.status ?? '') !== 'SUCCESS') return bare;\n", "",
          expect="C map_rows.ts: withMapRows no longer returns { result } alone", name="status guard deleted")
h.replace(MAP_ROWS, "const CELL_MAX = 60_000;", "const CELL_MAX = 70_000;",
          expect="C map_rows.ts: CELL_MAX missing or above 64000", name="cell cap above 64 KB")
h.replace(MAP_ROWS, "const ROWS_MAX = 190_000;", "const ROWS_MAX = 400_000;",
          expect="C map_rows.ts: ROWS_MAX missing or above 200000", name="row-set cap above 200 KB")
h.replace(MAP_ROWS, "ST_SIMPLIFY(G, 250))::STRING)", "ST_SIMPLIFY(G, 10))::STRING)",
          expect="C map_rows.ts: geometry is not simplified with ST_SIMPLIFY(G, 250) first", name="tolerance 10 m")
# D: framework patch reverted -> rows: null on every failure.
h.replace(ENVELOPE, "    if (what === 'returns' && schema.kind === 'nullable' && !(key in obj)) continue;\n", "",
          expect="D envelope.ts: patch 10 is gone", name="envelope patch reverted")
# F: persistence.
h.replace(MAP_ROWS, "INSERT INTO ${GEOMETRY_TABLE} (RESULT_ID", "SELECT 1 /* ${GEOMETRY_TABLE} (RESULT_ID",
          expect="F map_rows.ts: rows are not INSERTed", name="insert removed")
h.replace(MAP_ROWS, "[id, verb, identity.user,", "[id, verb, 'SYSTEM',",
          expect="F map_rows.ts: the persisted ACTOR is not identity.user", name="actor hard-coded")
h.replace(MAP_ROWS, "return id ? { result, rows, result_id: id }", "return id ? { result, rows }",
          expect="F map_rows.ts: withMapRows does not return the result_id", name="result_id not returned")
# G: privacy and wiring.
h.replace(DEPLOY, "WHERE ACTOR = CURRENT_USER();", ";",
          expect="G deploy-agent.sql: FLEET_INTELLIGENCE.ROUTING_TOOLS.VW_ROUTING_RESULT_GEOMETRY is missing or not",
          name="per-user filter dropped")
h.replace(SVS, "geom AS FLEET_INTELLIGENCE.ROUTING_TOOLS.VW_ROUTING_RESULT_GEOMETRY",
          "geom AS FLEET_INTELLIGENCE.ROUTING_TOOLS.ROUTING_RESULT_GEOMETRY",
          expect="G semantic_views.sql: FLEET_INTELLIGENCE.SEMANTIC.SV_ROUTING_RESULTS is missing or does not read",
          name="SV reads raw table")
h.replace(ROLE, "GRANT SELECT ON VIEW FLEET_INTELLIGENCE.ROUTING_TOOLS.VW_ROUTING_RESULT_GEOMETRY TO ROLE FLEET_APP_USER;",
          "GRANT SELECT ON TABLE FLEET_INTELLIGENCE.ROUTING_TOOLS.ROUTING_RESULT_GEOMETRY TO ROLE FLEET_APP_USER;",
          expect="G role_binding.sql: grants the raw table", name="table granted instead of view")


def spec_case(name, rel, old, new, expect):
    p = h.path(rel)
    original = p.read_text()

    def apply():
        d = json.loads(original)
        o = d["instructions"]["orchestration"]
        assert old in o, f"anchor not found: {old[:60]!r}"
        d["instructions"]["orchestration"] = o.replace(old, new, 1)
        p.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n")

    h.custom(name, apply, lambda: p.write_text(original), expect)


# E: the agent rule.
spec_case("old 'not mappable' sentence restored", SPEC,
          "Geometry computed LIVE by the routing engine is drawn through query_routing_results",
          "Geometry computed LIVE by the routing engine is still not mappable; see",
          expect="E agent-spec.json: still says 'is still not mappable'")
# E: the SHIPPED seventh-pass wording - the one that failed in CoWork - must fail.
spec_case("shipped verb-tool_use_id wording restored", SPEC,
          "returns status SUCCESS with a result_id, call query_routing_results for the geometry of that exact "
          "result_id, then call data_to_map ONCE with the query_routing_results call's tool_use_id - never "
          "the routing verb's own tool_use_id.",
          "returns status SUCCESS and its payload has rows, call data_to_map ONCE with THAT call's tool_use_id.",
          expect="still says \"with that call's tool_use_id\"")
spec_case("verb result offered as a source again (super spec)", SUPER,
          "(b) a query_routing_results result for the result_id returned by one of the routing verbs (",
          "(b) a routing verb result that carries a top-level rows array (",
          expect="still says 'a routing verb result that carries a top-level rows array'")
spec_case("latlon layer instruction dropped (super spec)", SUPER,
          'Rows with LAT and LON -> layer_type "latlon", lat_column "LAT", lon_column "LON". ', "",
          expect="E super-agent-spec.json: the DRAWING A ROUTING RESULT IN COWORK bullet lost the LAT/LON layer")
spec_case("'do not deep_link' dropped", SPEC,
          ", and do NOT deep_link instead of drawing it", "",
          expect="drawing instead of deep_linking")
spec_case("SA-app branch dropped", SPEC,
          " If data_to_map is absent you are in the SA app: the routing verb's geometry is drawn inline from result, so do not call render_map for the same geometry.",
          "", expect="the SA-app branch")
spec_case("a geometry verb missing from the source sentence", SPEC,
          "map_match, snap_to_road, ", "map_match, ",
          expect="missing ['snap_to_road']")
spec_case("rule bullet deleted", SPEC, "- DRAWING A ROUTING RESULT IN COWORK:", "- ROUTING RESULTS:",
          expect="E agent-spec.json: no 'DRAWING A ROUTING RESULT IN COWORK' bullet")


def tool_case(name, rel, mutate, expect):
    p = h.path(rel)
    original = p.read_text()

    def apply():
        d = json.loads(original)
        mutate(d)
        p.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n")

    h.custom(name, apply, lambda: p.write_text(original), expect)


tool_case("query_routing_results tool removed", SPEC,
          lambda d: d.__setitem__("tools", [t for t in d["tools"]
                                            if t.get("tool_spec", {}).get("name") != "query_routing_results"]),
          expect="E agent-spec.json: no cortex_analyst_text_to_sql tool named query_routing_results")
tool_case("query_routing_results bound to the wrong view", SUPER,
          lambda d: d["tool_resources"]["query_routing_results"].__setitem__(
              "semantic_view", "FLEET_INTELLIGENCE.SEMANTIC.SV_ROUTE_DEVIATION"),
          expect="E super-agent-spec.json: query_routing_results is not bound to")

sys.exit(h.finish())
