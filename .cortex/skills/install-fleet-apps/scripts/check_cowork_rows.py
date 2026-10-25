#!/usr/bin/env python3
"""check_cowork_rows.py - every routing verb result that has something to draw
carries a CoWork-drawable `rows` array, and the agent is told to draw it.

WHY
CoWork's data_to_map draws an MCP result only when the payload is ONE JSON
document with a top-level `rows` array of objects. Routing verbs returned
`{ result }` with the geometry on fields inside it, and the agent spec said an MCP
result can never be mapped, so a successful route showed no map in CoWork.

WHY rows ALONE WAS NOT ENOUGH (observed in CoWork 2026-10-24)
The managed MCP server delivers a verb's output as {"json":{"result":"<doc as a
STRING>"}}, so `rows` never reaches data_to_map at the top level: get_directions
returned ok and no map appeared. The verbs now also persist their rows under a
`result_id`, and the agent draws them through the Cortex Analyst tool
query_routing_results (SV_ROUTING_RESULTS), which data_to_map does accept.

RULES
A  Each GEOMETRY verb declares nullable `rows` AND `result_id` beside `result`
   and returns `withMapRows(ctx, '<its own verb name>', result, <spec>)`.
B  No other user verb calls withMapRows (run_sql, render_map, deep_link, ...
   have nothing to draw through this path).
C  map_rows.ts returns `{ result }` alone unless status is SUCCESS, keeps FULL
   detail first (tolerance ladder starts at 0 = unsimplified, strictly
   increasing, ends at 5000 m), picks ONE shared tolerance as the finest tier
   whose row set fits ROWS_MAX, and keeps the cell cap <= 64 KB and the
   row-set cap <= 200 KB. (A fixed 250 m first tier drew a 151-point city
   route as 7 segments.)
D  The vendored synapse envelope keeps an omitted nullable return key absent
   (patch 10), so a FAILED call carries no `rows: null`.
E  Every agent spec carrying the CoWork map block has the routing-result rule:
   query_routing_results for the result_id, then data_to_map on THAT call's
   tool_use_id and never the routing verb's own, geojson/GEOJSON vs
   latlon/LAT/LON, no render_map, no deep_link; it names exactly the GEOMETRY
   verbs; it does not offer the routing verb result itself as a map source; and
   the spec binds query_routing_results to SV_ROUTING_RESULTS.
F  map_rows.ts persists the rows (INSERT into ROUTING_RESULT_GEOMETRY with the
   caller's identity.user as ACTOR) and returns result_id only from that write.
G  The table and the ACTOR = CURRENT_USER() secure view exist in deploy-agent.sql,
   SV_ROUTING_RESULTS reads the VIEW (never the table), and role_binding.sql
   grants the view, never the table.
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[4]
SKILL = ROOT / ".cortex/skills/install-fleet-apps"
DEPLOY_AGENT = ROOT / ".cortex/skills/routing-agent/references/deploy-agent.sql"
PROCS = SKILL / "fleet_tools/user/src/procs"
MAP_ROWS = SKILL / "fleet_tools/user/src/map_rows.ts"
ENVELOPE = SKILL / "fleet_tools/vendor/synapse/src/runtime/envelope.ts"
APP = SKILL / "fleet_sa_app/app"
TABLE = "FLEET_INTELLIGENCE.ROUTING_TOOLS.ROUTING_RESULT_GEOMETRY"
VIEW = "FLEET_INTELLIGENCE.ROUTING_TOOLS.VW_ROUTING_RESULT_GEOMETRY"
SV = "FLEET_INTELLIGENCE.SEMANTIC.SV_ROUTING_RESULTS"
TOOL = "query_routing_results"

GEOMETRY = {
    "get_directions", "compute_isochrone", "map_match", "snap_to_road", "optimize_routes",
    "delivery_optimization", "network_optimization", "catchment", "find_poi", "evac_seed",
    "evac_solve", "vrp_solve", "query_overture_places", "query_overture_addresses",
}
RULE_HEAD = "DRAWING A ROUTING RESULT IN COWORK"
OLD_WORDING = [
    "data_to_map accepts only a sql/analyst tool result",
    "is still not mappable",
    "an mcp result is rejected as a map source",
    "the same one data_to_map has",
    # the ninth-pass wording, false since cortex PR 157597 made MCP results map sources
    "the routing verb's own result is not a source",
    "never the routing verb's own tool_use_id",
]


def strip_ts_comments(s: str) -> str:
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    return re.sub(r"(?m)^\s*//.*$|(?<=[;,{}()])\s*//.*$", "", s)


def returns_block(src: str) -> str:
    i = src.find("returns: {")
    return src[i:src.find("\n  },", i)] if i >= 0 else ""


def main() -> int:
    problems: list[str] = []

    # --- A / B: the verbs --------------------------------------------------------
    for f in sorted(PROCS.glob("*.ts")):
        name = f.stem
        code = strip_ts_comments(f.read_text())
        uses = re.search(r"return\s+withMapRows\(\s*ctx\s*,\s*'([a-z_]+)'\s*,\s*result\s*,", code)
        if name in GEOMETRY:
            if not uses:
                problems.append(f"A {f.name}: does not return withMapRows(ctx, '<verb>', result, ...) - "
                                f"CoWork gets no drawable rows for this verb")
            elif uses.group(1) != name:
                problems.append(f"A {f.name}: withMapRows records verb {uses.group(1)!r}, not {name!r}")
            rb = returns_block(code)
            if not re.search(r"rows:\s*t\.array\(t\.object\(\{\}\)\)\.nullable\(\)", rb):
                problems.append(f"A {f.name}: returns does not declare a nullable `rows` beside `result`, "
                                f"so the envelope drops the row set")
            if not re.search(r"result_id:\s*t\.string\(\)\.nullable\(\)", rb):
                problems.append(f"A {f.name}: returns does not declare a nullable `result_id`, "
                                f"so the envelope drops the id CoWork needs to draw the result")
            if re.search(r"return\s*\{\s*result\s*\}", code):
                problems.append(f"A {f.name}: still has a bare `return {{ result }}` path")
        elif "withMapRows" in code:
            problems.append(f"B {f.name}: is not a geometry verb but calls withMapRows")
    missing = GEOMETRY - {f.stem for f in PROCS.glob("*.ts")}
    if missing:
        problems.append(f"A geometry verbs missing from procs/: {sorted(missing)}")

    # --- C: the projection ---------------------------------------------------------
    m = strip_ts_comments(MAP_ROWS.read_text())
    fn = m[m.find("export async function withMapRows"):]
    fn = fn[:fn.find("\n}\n")]
    guard = re.search(r"if\s*\(\s*String\(result\.status[^)]*\)\s*!==\s*'SUCCESS'\s*\)\s*return\s+bare", fn)
    if not guard or fn.find("pointRows(") < guard.start():
        problems.append("C map_rows.ts: withMapRows no longer returns { result } alone before building "
                        "rows when status is not SUCCESS - a FAILED call would carry rows")
    for const, cap in (("CELL_MAX", 64_000), ("ROWS_MAX", 200_000)):
        mm = re.search(rf"const {const} = ([\d_]+);", m)
        if not mm or int(mm.group(1).replace("_", "")) > cap:
            problems.append(f"C map_rows.ts: {const} missing or above {cap} - CoWork drops the map")
    lad = re.search(r"const TOLERANCES_M = \[([\d,\s]+)\];", m)
    tol = [int(x) for x in lad.group(1).split(",")] if lad else []
    if not tol or tol[0] != 0:
        problems.append("C map_rows.ts: the tolerance ladder does not start at 0 (full detail) - "
                        "routes are simplified even when the full line fits")
    elif any(b <= a for a, b in zip(tol, tol[1:])) or tol[-1] != 5000:
        problems.append(f"C map_rows.ts: the tolerance ladder {tol} is not strictly increasing to 5000")
    if "${TOLERANCES_M.join(" not in m or not re.search(r"COALESCE\(MIN\(IFF\(BYTES <= \$\{ROWS_MAX\}", m):
        problems.append("C map_rows.ts: SIMPLIFY_SQL does not pick the FINEST tier of TOLERANCES_M "
                        "whose row set fits ROWS_MAX")
    if not re.search(r"WHERE LAD\.TOL = PICK\.T", m):
        problems.append("C map_rows.ts: rows are not all emitted at the one picked tolerance - "
                        "a multi-route result can drop routes")
    if not re.search(r"BEST AS \(SELECT MAX\(FIT\) AS F FROM TIERS\)", m) or "FIT = BEST.F" not in m:
        problems.append("C map_rows.ts: the tier target is not the MAX fit over all tiers - ST_SIMPLIFY "
                        "collapses a short line to NULL at 5 km, so a 5 km target draws no map")

    # --- F: persistence ----------------------------------------------------------
    if not re.search(rf"INSERT INTO \$\{{GEOMETRY_TABLE\}}\s*\(RESULT_ID, VERB, ACTOR,", m) \
            or f"const GEOMETRY_TABLE = '{TABLE}'" not in m:
        problems.append(f"F map_rows.ts: rows are not INSERTed into {TABLE} - query_routing_results "
                        f"finds nothing and CoWork cannot draw the route")
    persist = m[m.find("async function persistRows"):]
    persist = persist[:persist.find("\n}\n")]
    if not re.search(r"exec\(PERSIST_SQL,\s*\[id,\s*verb,\s*identity\.user,", persist):
        problems.append("F map_rows.ts: the persisted ACTOR is not identity.user - the per-user secure "
                        "view then hides the caller's own rows")
    if not re.search(r"await\s+persistRows\(", fn) or not re.search(r"result_id:\s*id\b", fn):
        problems.append("F map_rows.ts: withMapRows does not return the result_id from persistRows")

    # --- D: envelope patch -----------------------------------------------------------
    env = strip_ts_comments(ENVELOPE.read_text())
    if not re.search(r"what === 'returns' && schema\.kind === 'nullable' && !\(key in obj\)\)\s*continue", env):
        problems.append("D envelope.ts: patch 10 is gone - an omitted `rows` becomes `rows: null` "
                        "on every FAILED call")

    # --- E: agent specs ---------------------------------------------------------------
    for spec in sorted(APP.glob("*agent-spec.json")):
        try:
            d = json.loads(spec.read_text())
        except json.JSONDecodeError:
            problems.append(f"E {spec.name}: is not valid JSON")
            continue
        ins = d.get("instructions", {})
        orch = ins.get("orchestration", "")
        if "DRAWING A MAP IN COWORK" not in orch:
            continue
        low = (orch + "\n" + ins.get("response", "")).lower()
        for w in OLD_WORDING:
            if w in low:
                problems.append(f"E {spec.name}: still says {w!r} - routing results ARE mappable now")
        i = orch.find("- " + RULE_HEAD)
        if i < 0:
            problems.append(f"E {spec.name}: no '{RULE_HEAD}' bullet")
            continue
        bullet = orch[i:orch.find("\n", i) if orch.find("\n", i) >= 0 else len(orch)]
        direct = bullet.find("call data_to_map ONCE with THAT routing verb call's own tool_use_id")
        q = bullet.find(f"call {TOOL}")
        dm = bullet.find(f"data_to_map ONCE with the {TOOL} call's tool_use_id")
        if direct < 0:
            problems.append(f"E {spec.name}: the {RULE_HEAD} bullet does not draw the routing verb's "
                            f"own tool_use_id first - the model takes the {TOOL} detour on every map")
        if q < 0 or dm < 0 or dm < q or (direct >= 0 and q < direct):
            problems.append(f"E {spec.name}: the {RULE_HEAD} bullet does not keep {TOOL} as the "
                            f"FALLBACK after the direct path (call {TOOL}, then pass ITS tool_use_id)")
        fb = bullet[direct:q] if 0 <= direct < q else ""
        if "rejects it as not mappable" not in fb or "refreshable map" not in fb:
            problems.append(f"E {spec.name}: the {RULE_HEAD} bullet lost the fallback trigger (rejected "
                            f"as not mappable, or a refreshable map wanted)")
        tools = {t.get("tool_spec", {}).get("name"): t.get("tool_spec", {}) for t in d.get("tools", [])}
        if tools.get(TOOL, {}).get("type") != "cortex_analyst_text_to_sql":
            problems.append(f"E {spec.name}: no cortex_analyst_text_to_sql tool named {TOOL}")
        if d.get("tool_resources", {}).get(TOOL, {}).get("semantic_view") != SV:
            problems.append(f"E {spec.name}: {TOOL} is not bound to {SV}")
        for need, why in (
            ('layer_type "geojson", geo_column "GEOJSON"', "the GEOJSON layer"),
            ('layer_type "latlon", lat_column "LAT", lon_column "LON"', "the LAT/LON layer"),
            ("Do NOT call render_map", "not redrawing with render_map"),
            ("do NOT deep_link instead", "drawing instead of deep_linking"),
            ("unmappable_rows", "what to say when the map is too large"),
            ("If data_to_map is absent you are in the SA app", "the SA-app branch"),
        ):
            if need not in bullet:
                problems.append(f"E {spec.name}: the {RULE_HEAD} bullet lost {why} ({need!r})")
        src = re.search(rf"a {TOOL} result for the result_id returned by one of the routing verbs \(([^)]*)\)", orch)
        named = {v.strip() for v in src.group(1).split(",")} if src else set()
        if named != GEOMETRY:
            problems.append(f"E {spec.name}: the data_to_map source sentence names {sorted(named)}, "
                            f"not the geometry verbs (missing {sorted(GEOMETRY - named)}, "
                            f"extra {sorted(named - GEOMETRY)})")

    # --- G: table, secure view, semantic view, grant -----------------------------------
    da = DEPLOY_AGENT.read_text()
    if f"CREATE TABLE IF NOT EXISTS {TABLE}" not in da:
        problems.append(f"G deploy-agent.sql: does not create {TABLE}")
    vi = da.find(f"CREATE OR REPLACE SECURE VIEW {VIEW}")
    vbody = da[vi:da.find(";", vi)] if vi >= 0 else ""
    if not re.search(r"WHERE\s+ACTOR\s*=\s*CURRENT_USER\(\)", vbody):
        problems.append(f"G deploy-agent.sql: {VIEW} is missing or not a SECURE view filtered "
                        f"ACTOR = CURRENT_USER() - every user would read every user's routes")
    sv = (APP / "semantic_views.sql").read_text()
    si = sv.find(f"CREATE OR REPLACE SEMANTIC VIEW {SV}")
    sbody = sv[si:sv.find("\n;", si)] if si >= 0 else ""
    if f"AS {VIEW}" not in sbody:
        problems.append(f"G semantic_views.sql: {SV} is missing or does not read {VIEW}")
    if re.search(rf"AS {re.escape(TABLE)}\b", sbody):
        problems.append(f"G semantic_views.sql: {SV} reads the raw table, bypassing the per-user view")
    rb = (APP / "role_binding.sql").read_text()
    if f"GRANT SELECT ON VIEW {VIEW} TO ROLE FLEET_APP_USER" not in rb:
        problems.append(f"G role_binding.sql: FLEET_APP_USER cannot read {VIEW}")
    if re.search(rf"(?im)^\s*GRANT[^;]*\b{re.escape(TABLE)}\b", rb):
        problems.append(f"G role_binding.sql: grants the raw table {TABLE} - it holds every user's routes")

    # --- H: run_sql results are drawable (H3 density, points, shapes) -----------
    # Observed in CoWork: run_sql computed the exact H3 density inside an
    # isochrone, persisted nothing, and the agent drew a bounding-box
    # approximation instead. Every link of the run_sql path is checked here.
    rs = strip_ts_comments((PROCS / "run_sql.ts").read_text())
    if not re.search(r"result_id:\s*t\s*\.string\(\)\s*\.nullable\(\)", returns_block(rs)):
        problems.append("H run_sql.ts: returns does not declare a nullable `result_id` - the envelope drops it")
    if not re.search(r"await\s+persistSqlMapRows\(\s*ctx\s*,\s*rows\s*\)", rs) \
            or not re.search(r"result_id:\s*resultId\b", rs):
        problems.append("H run_sql.ts: execute does not persist its rows via persistSqlMapRows and return the "
                        "result_id - a run_sql density cannot be drawn in CoWork")
    sq = m[m.find("export async function persistSqlMapRows"):]
    sq = sq[:sq.find("\n}\n")]
    if not re.search(r"sqlMapRows\(rows\)", sq) or "persistRows(ctx.conn, ctx.identity, 'run_sql'" not in sq:
        problems.append("H map_rows.ts: persistSqlMapRows does not project with sqlMapRows and persist as verb 'run_sql'")
    if not re.search(r"\(RESULT_ID, VERB, ACTOR, SEQ, GEOJSON, LON, LAT, H3, VALUE, LABEL\)", m):
        problems.append("H map_rows.ts: PERSIST_SQL does not write H3, VALUE, LABEL - an H3 density persists empty")
    tbl = da[da.find(f"CREATE TABLE IF NOT EXISTS {TABLE}"):]
    tbl = tbl[:tbl.find(";")]
    upgrade = re.search(r"defs ARRAY DEFAULT ARRAY_CONSTRUCT\(([^)]*)\)", da)
    upgrade_cols = upgrade.group(1) if upgrade and "ADD COLUMN" in da else ""
    for col in ("H3", "VALUE", "LABEL"):
        if not re.search(rf"\b{col}\s+(STRING|FLOAT)", tbl):
            problems.append(f"H deploy-agent.sql: {TABLE} has no {col} column")
        if f"'{col} " not in upgrade_cols:
            problems.append(f"H deploy-agent.sql: the upgrade block does not add {col} to an existing table")
        if not re.search(rf"\b{col}\b", vbody.split("FROM")[0]):
            problems.append(f"H deploy-agent.sql: {VIEW} does not select {col}")
        if not re.search(rf"geom\.{col.lower()} AS {col}\b", sbody):
            problems.append(f"H semantic_views.sql: {SV} has no {col} dimension")
    if "layer_type h3 on column H3" not in sbody:
        problems.append(f"H semantic_views.sql: {SV} does not say how to draw H3 rows")
    for spec in sorted(APP.glob("*agent-spec.json")):
        orch = json.loads(spec.read_text()).get("instructions", {}).get("orchestration", "")
        if "DRAWING A MAP IN COWORK" not in orch:
            continue
        for need, why in (
            ("MAPPING A run_sql RESULT", "the run_sql mapping rule"),
            ("or by run_sql when it returns a result_id", "run_sql as a query_routing_results source"),
            ("MCP RESULT IS A MAP SOURCE", "the direct MCP source rule"),
            ("a SUCCESSFUL routing verb or run_sql call whose payload carries rows", "run_sql/verb as a direct source"),
            ("NEVER swap a computed result for an approximation", "the no-approximation rule"),
        ):
            if need not in orch:
                problems.append(f"H {spec.name}: lost {why} ({need!r})")

    if problems:
        print("FAIL: CoWork routing rows:")
        for p in problems:
            print(f"  - {p}")
        return 1
    print(f"OK: {len(GEOMETRY)} routing verbs return CoWork-drawable rows and the specs say how to draw them")
    return 0


if __name__ == "__main__":
    sys.exit(main())
