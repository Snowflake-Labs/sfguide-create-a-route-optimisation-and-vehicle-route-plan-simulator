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
# C: the SHIPPED defect - a fixed 250 m first tier drew a city route as 7 segments.
h.replace(MAP_ROWS, "const TOLERANCES_M = [0, 5, 25, 100, 250, 1000, 5000];",
          "const TOLERANCES_M = [250, 1000, 5000];",
          expect="C map_rows.ts: the tolerance ladder does not start at 0", name="250 m first tier restored")
h.replace(MAP_ROWS, "const TOLERANCES_M = [0, 5, 25, 100, 250, 1000, 5000];",
          "const TOLERANCES_M = [0, 250, 25, 1000, 5000];",
          expect="is not strictly increasing to 5000", name="ladder not monotonic")
h.replace(MAP_ROWS, "COALESCE(MIN(IFF(BYTES <= ${ROWS_MAX}", "COALESCE(MAX(IFF(BYTES <= ${ROWS_MAX}",
          expect="C map_rows.ts: SIMPLIFY_SQL does not pick the FINEST tier", name="coarsest tier picked")
h.replace(MAP_ROWS, "WHERE LAD.TOL = PICK.T AND", "WHERE",
          expect="C map_rows.ts: rows are not all emitted at the one picked tolerance", name="tiers not pinned")
# C: the first version of the ladder - target = the 5 km count, which is 0 for a short route.
h.replace(MAP_ROWS, "BEST AS (SELECT MAX(FIT) AS F FROM TIERS)",
          "BEST AS (SELECT FIT AS F FROM TIERS WHERE TOL = 5000)",
          expect="C map_rows.ts: the tier target is not the MAX fit over all tiers", name="5 km target restored")
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
# E: the NINTH-pass wording - "MCP is not a source" - is false since cortex PR 157597 and must fail.
spec_case("ninth-pass 'not a source' sentence restored", SPEC,
          "A direct (b) map is a snapshot:",
          "The routing verb's OWN result is NOT a source, and neither is run_sql's own result. A direct (b) map is a snapshot:",
          expect="still says \"the routing verb's own result is not a source\"")
spec_case("query_routing_results detour made primary again (super spec)", SUPER,
          "tatus SUCCESS, call data_to_map ONCE with THAT routing verb call's own tool_use_id. Only if "
          "data_to_map rejects it as not mappable, or the user wants a refreshable map, call",
          "tatus SUCCESS with a result_id, call",
          expect="does not draw the routing verb's own tool_use_id first")
spec_case("fallback trigger dropped", SPEC,
          "Only if data_to_map rejects it as not mappable, or the user wants a refreshable map, call",
          "Then also call",
          expect="lost the fallback trigger")
spec_case("fallback removed entirely", SPEC,
          " call query_routing_results for the geometry of its result_id, then call data_to_map ONCE with the "
          "query_routing_results call's tool_use_id.",
          " report the figures.",
          expect=f"does not keep query_routing_results as the FALLBACK")
spec_case("direct-source rule header dropped", SPEC,
          "- Source constraint (MCP RESULT IS A MAP SOURCE):", "- Source constraint:",
          expect="lost the direct MCP source rule")
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

# H: run_sql results drawable (the Eiffel-tower H3 density that was redrawn as a bbox).
h.replace(f"{PROCS}/run_sql.ts", "await persistSqlMapRows(ctx, rows)", "null",
          expect="H run_sql.ts: execute does not persist its rows", name="run_sql persists nothing")
h.replace(f"{PROCS}/run_sql.ts", "      result_id: resultId,\n", "",
          expect="H run_sql.ts: execute does not persist its rows", name="run_sql drops result_id")
h.replace(f"{PROCS}/run_sql.ts", "    result_id: t\n      .string()\n      .nullable()", "    result_id_x: t\n      .string()\n      .nullable()",
          expect="H run_sql.ts: returns does not declare a nullable `result_id`", name="run_sql result_id undeclared")
h.replace(MAP_ROWS, "persistRows(ctx.conn, ctx.identity, 'run_sql', mapRows)", "persistRows(ctx.conn, ctx.identity, 'get_directions', mapRows)",
          expect="H map_rows.ts: persistSqlMapRows does not project", name="run_sql rows filed under another verb")
h.replace(MAP_ROWS, "SEQ, GEOJSON, LON, LAT, H3, VALUE, LABEL)", "SEQ, GEOJSON, LON, LAT)",
          expect="H map_rows.ts: PERSIST_SQL does not write H3, VALUE, LABEL", name="H3 not persisted")
h.replace(DEPLOY, "    H3         STRING,\n", "",
          expect="H deploy-agent.sql: FLEET_INTELLIGENCE.ROUTING_TOOLS.ROUTING_RESULT_GEOMETRY has no H3 column",
          name="table lacks H3")
h.replace(DEPLOY, "'H3 STRING', 'VALUE FLOAT', 'LABEL STRING'", "'VALUE FLOAT', 'LABEL STRING'",
          expect="H deploy-agent.sql: the upgrade block does not add H3", name="upgrade skips H3")
h.replace(DEPLOY, "LON, LAT, H3, VALUE, LABEL\nFROM", "LON, LAT\nFROM",
          expect="does not select H3", name="view hides H3")
h.replace(SVS, "    , geom.value AS VALUE\n", "    , geom.value AS VAL\n",
          expect="H semantic_views.sql: FLEET_INTELLIGENCE.SEMANTIC.SV_ROUTING_RESULTS has no VALUE dimension",
          name="SV lacks VALUE")
spec_case("no-approximation rule dropped", SPEC,
          "NEVER swap a computed result for an approximation", "Prefer the computed result over an approximation",
          expect="H agent-spec.json: lost the no-approximation rule")
spec_case("run_sql mapping rule dropped (super spec)", SUPER,
          "MAPPING A run_sql RESULT", "RUN_SQL RESULTS",
          expect="H super-agent-spec.json: lost the run_sql mapping rule")

# I: ROWS_MAX counted in raw bytes - the PR's 200 KB ceiling is escaped bytes.
h.replace(MAP_ROWS, "    bytes += escapedLen(JSON.stringify(row)) + 1;",
          "    bytes += JSON.stringify(row).length + 1;",
          expect="I map_rows.ts: a ROWS_MAX accumulator counts raw bytes", name="point rows raw bytes")
h.replace(MAP_ROWS, "    const len = escapedLen(text);\n    // Backstop",
          "    const len = text.length;\n    // Backstop",
          expect="I map_rows.ts: a ROWS_MAX accumulator counts raw bytes", name="geojson rows raw bytes")
h.replace(MAP_ROWS, "    const len = escapedLen(text);\n    if (bytes",
          "    const len = text.length;\n    if (bytes",
          expect="I map_rows.ts: a ROWS_MAX accumulator counts raw bytes", name="run_sql rows raw bytes")
h.replace(MAP_ROWS, "LENGTH(GJ) + REGEXP_COUNT(GJ, '[\"\\\\\\\\\\\\\\\\]') + ${ROW_OVERHEAD}",
          "LENGTH(GJ) + ${ROW_OVERHEAD}",
          expect="I map_rows.ts: the SQL tier picker's BYTES does not add the escape count",
          name="SQL picker raw bytes")
h.replace(MAP_ROWS, "JSON.stringify(s).length - 2;", "s.length;",
          expect="I map_rows.ts: escapedLen is missing", name="escapedLen measures raw")
# I: the escape term survives only in a comment.
h.replace(MAP_ROWS, "LENGTH(GJ) + REGEXP_COUNT(GJ, '[\"\\\\\\\\\\\\\\\\]') + ${ROW_OVERHEAD}",
          "LENGTH(GJ) /* + REGEXP_COUNT(GJ, x) */ + ${ROW_OVERHEAD}",
          expect="I map_rows.ts: the SQL tier picker's BYTES does not add the escape count",
          name="escape term only in a comment")

sys.exit(h.finish())
