#!/usr/bin/env python3
"""check_cowork_rows.py - every routing verb result that has something to draw
carries a CoWork-drawable `rows` array, and the agent is told to draw it.

WHY
CoWork's data_to_map draws an MCP result only when the payload is ONE JSON
document with a top-level `rows` array of objects. Routing verbs returned
`{ result }` with the geometry on fields inside it, and the agent spec said an MCP
result can never be mapped, so a successful route showed no map in CoWork.

RULES
A  Each GEOMETRY verb declares `rows: t.array(t.object({})).nullable()` beside
   `result` and returns `withMapRows(ctx.conn, result, <spec>)`.
B  No other user verb calls withMapRows (run_sql, render_map, deep_link, ...
   have nothing to draw through this path).
C  map_rows.ts returns `{ result }` alone unless status is SUCCESS, simplifies
   every geometry with ST_SIMPLIFY(G, 250) first, and keeps the cell cap
   <= 64 KB and the row-set cap <= 200 KB.
D  The vendored synapse envelope keeps an omitted nullable return key absent
   (patch 10), so a FAILED call carries no `rows: null`.
E  Every agent spec carrying the CoWork map block has the routing-result rule:
   data_to_map on that call's tool_use_id, geojson/GEOJSON vs latlon/LAT/LON,
   no render_map, no deep_link; it names exactly the GEOMETRY verbs; and the old
   "MCP results cannot be mapped" wording is gone.
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[4]
SKILL = ROOT / ".cortex/skills/install-fleet-apps"
PROCS = SKILL / "fleet_tools/user/src/procs"
MAP_ROWS = SKILL / "fleet_tools/user/src/map_rows.ts"
ENVELOPE = SKILL / "fleet_tools/vendor/synapse/src/runtime/envelope.ts"
APP = SKILL / "fleet_sa_app/app"

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
        uses = re.search(r"return\s+withMapRows\(\s*ctx\.conn\s*,\s*result\s*,", code)
        if name in GEOMETRY:
            if not uses:
                problems.append(f"A {f.name}: does not return withMapRows(ctx.conn, result, ...) - "
                                f"CoWork gets no drawable rows for this verb")
            if not re.search(r"rows:\s*t\.array\(t\.object\(\{\}\)\)\.nullable\(\)", returns_block(code)):
                problems.append(f"A {f.name}: returns does not declare a nullable `rows` beside `result`, "
                                f"so the envelope drops the row set")
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
    first = re.search(r"ST_SIMPLIFY\(G,\s*(\d+)\)", m)
    if not first or first.group(1) != "250":
        problems.append("C map_rows.ts: geometry is not simplified with ST_SIMPLIFY(G, 250) first")

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
        for need, why in (
            ("tool_use_id", "which call to pass to data_to_map"),
            ('layer_type "geojson", geo_column "GEOJSON"', "the GEOJSON layer"),
            ('layer_type "latlon", lat_column "LAT", lon_column "LON"', "the LAT/LON layer"),
            ("Do NOT call render_map", "not redrawing with render_map"),
            ("do NOT deep_link instead", "drawing instead of deep_linking"),
            ("unmappable_rows", "what to say when the map is too large"),
            ("If data_to_map is absent you are in the SA app", "the SA-app branch"),
        ):
            if need not in bullet:
                problems.append(f"E {spec.name}: the {RULE_HEAD} bullet lost {why} ({need!r})")
        src = re.search(r"routing verb result that carries a top-level rows array \(([^)]*)\)", orch)
        named = {v.strip() for v in src.group(1).split(",")} if src else set()
        if named != GEOMETRY:
            problems.append(f"E {spec.name}: the data_to_map source sentence names {sorted(named)}, "
                            f"not the geometry verbs (missing {sorted(GEOMETRY - named)}, "
                            f"extra {sorted(named - GEOMETRY)})")

    if problems:
        print("FAIL: CoWork routing rows:")
        for p in problems:
            print(f"  - {p}")
        return 1
    print(f"OK: {len(GEOMETRY)} routing verbs return CoWork-drawable rows and the specs say how to draw them")
    return 0


if __name__ == "__main__":
    sys.exit(main())
