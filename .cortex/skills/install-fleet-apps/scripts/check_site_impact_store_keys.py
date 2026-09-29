#!/usr/bin/env python3
"""Gate: Site Impact store lookups are region-keyed and null-safe.

Two defects made every Site Impact page open log /api/query 500s:

  1. STORE_ID is NOT unique across regions (ST0011 exists in Switzerland, USA,
     UsTexas and SanFrancisco). The selected-store isochrone layer joined
     VW_STORES on STORE_ID alone, so `(SELECT LON FROM pt)` saw 4 rows and
     raised 090150 - the candidate drive-time outline never drew for ANY store.
  2. With no store selected, the LIVE_* UDTFs built ORS coordinates from scalar
     `(SELECT LON FROM ...)` subqueries. NULL coordinates went to ORS, which
     answered 3003, surfaced as `Boolean value 'ORS {...}' is not recognized`.
     Driving the call from a row source makes an empty selection call nothing.

Rules (comments stripped first - a comment explaining a rule is not the rule):
  A  every JOIN onto a store table in app-views.json constrains REGION
  B  no ORS coordinate is a scalar `(SELECT LON|LAT FROM ...)` subquery, in the
     app views or in the Site Impact UDTFs
  C  the isochrone layer resolves its profile per region (UsTexas has no
     driving-car graph, so a hardcoded profile fails with 3003 'profile')
  D  each Site Impact UDTF feeds ORS from a row source `c` filtered by REGION
"""

import json
import re
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
VIEWS = SKILL / "fleet_sa_app/app/app-views.json"
SQL = SKILL / "scripts/analytic_layer_live_routing.sql"

UDTFS = [
    "LIVE_ZIP_BANDS",
    "LIVE_CANDIDATE_ISO",
    "LIVE_OVERLAPS",
    "LIVE_OVERLAP_ZIPS",
    "LIVE_OVERLAP_CELLS",
]
STORE_TABLE = r"(?:VW_STORES|STORE_FACTS|LOCATION\.STORES)"
SCALAR_COORD = re.compile(r"\(\s*SELECT\s+(?:LON|LAT)\s+FROM\b", re.I)

failures: list[tuple[str, str]] = []


def fail(rule: str, msg: str) -> None:
    failures.append((rule, msg))


def strip_sql_comments(src: str) -> str:
    return re.sub(r"--[^\n]*", "", src)


def view_queries() -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []

    def walk(o, where):
        if isinstance(o, dict):
            for k, v in o.items():
                if k == "query" and isinstance(v, str):
                    out.append((where, v))
                else:
                    walk(v, o.get("id", where) if isinstance(o.get("id"), str) else where)
        elif isinstance(o, list):
            for x in o:
                walk(x, where)

    walk(json.loads(VIEWS.read_text(encoding="utf-8")), "?")
    return out


def udtf_bodies() -> dict[str, str]:
    src = strip_sql_comments(SQL.read_text(encoding="utf-8"))
    bodies = {}
    for name in UDTFS:
        m = re.search(
            r"CREATE OR REPLACE FUNCTION FLEET_APP\.LOCATION\." + name + r"\(.*?\$\$(.*?)\$\$;",
            src, re.S)
        if m:
            bodies[name] = m.group(1)
    return bodies


def rule_a(queries):
    seen = 0
    join = re.compile(
        r"JOIN\s+\S*" + STORE_TABLE + r"\s+(\w+)\s+ON\s+(.*?)(?=\s+(?:WHERE|JOIN|LEFT|GROUP|ORDER|UNION)\b|\)|$)",
        re.I | re.S)
    for where, q in queries:
        for m in join.finditer(q):
            seen += 1
            if not re.search(r"\b" + m.group(1) + r"\.REGION\b", m.group(2), re.I):
                fail("A", f"{where}: store join keyed on id only: ON {m.group(2)[:90]}")
    if seen == 0:
        fail("A", "vacuous: no store joins found in app-views.json (anchor moved?)")


def rule_b(queries, bodies):
    for where, q in queries:
        if re.search(r"ISOCHRONES|MATRIX|DIRECTIONS", q) and SCALAR_COORD.search(q):
            fail("B", f"{where}: ORS coordinate built from a scalar subquery")
    for name, body in bodies.items():
        if SCALAR_COORD.search(body):
            fail("B", f"{name}: ORS coordinate built from a scalar subquery")


def rule_c(queries):
    iso = [(w, q) for w, q in queries if w == "candidate-isochrone"]
    if not iso:
        fail("C", "vacuous: candidate-isochrone layer not found")
    for where, q in iso:
        if re.search(r"ISOCHRONES\(\s*'", q):
            fail("C", f"{where}: ISOCHRONES profile is a hardcoded literal")
        if "VW_REGION_PROFILE" not in q:
            fail("C", f"{where}: profile not resolved via VW_REGION_PROFILE")


def rule_d(bodies):
    missing = [n for n in UDTFS if n not in bodies]
    if missing:
        fail("D", f"vacuous: UDTF bodies not found: {missing}")
    src_re = re.compile(
        r"FROM\s*\(\s*SELECT\s+LON\s*,\s*LAT\s+FROM\s+\S+\s+WHERE\s+([^)]*)\)\s*c\s*,\s*TABLE\(\s*OPENROUTESERVICE_APP\.CORE\.ISOCHRONES\(",
        re.I | re.S)
    for name, body in bodies.items():
        m = src_re.search(body)
        if not m:
            fail("D", f"{name}: ISOCHRONES not driven from a row source `c`")
            continue
        if not re.search(r"\bREGION\s*=\s*P_REGION\b", m.group(1), re.I):
            fail("D", f"{name}: row source not filtered by REGION")
        if "c.LON" not in body or "c.LAT" not in body:
            fail("D", f"{name}: ORS coordinates do not read the row source")


def main() -> int:
    queries = view_queries()
    bodies = udtf_bodies()
    rule_a(queries)
    rule_b(queries, bodies)
    rule_c(queries)
    rule_d(bodies)
    for rule, msg in failures:
        print(f"FAILED [{rule}] {msg}")
    if failures:
        return 1
    print(f"site-impact store keys: OK ({len(queries)} view queries, {len(bodies)} UDTFs)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
