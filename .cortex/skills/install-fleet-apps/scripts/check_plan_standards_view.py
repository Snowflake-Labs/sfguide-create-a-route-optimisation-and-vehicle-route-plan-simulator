#!/usr/bin/env python3
"""Execute every query in the route_plan_standards view with runtime binds.

Scoped stand-in for validate_app_views.py, which walks all 21 views and takes
longer than a feedback loop allows. Two passes, matching the real validator:
first render (nothing selected) and then a seeded selection, because the whole
right-hand side of this view only populates after a route is clicked.
"""
import json
import pathlib
import subprocess
import sys

APP = pathlib.Path(
    ".cortex/skills/install-fleet-apps/fleet_sa_app/app/app-views.json"
)
CONN = sys.argv[1] if len(sys.argv) > 1 else "TIB"
VIEW = "route_plan_standards"


def areas(view):
    """Yield (area_name, label, query, params) for every query in the view."""
    for name, area in view["areas"].items():
        data = area.get("data")
        if isinstance(data, dict) and data.get("query"):
            yield name, name, data["query"], data.get("params", {})
        cfg = area.get("config", {})
        if cfg.get("defaultSource"):
            yield name, f"{name}.defaultSource", cfg["defaultSource"], {
                "region": "context.region"
            }
        for layer in cfg.get("layers", []) or []:
            ld = layer.get("data") or {}
            if ld.get("query"):
                yield name, f"{name}.{layer.get('id')}", ld["query"], ld.get(
                    "params", {}
                )


def bind(sql, params, state):
    """Substitute :name with a SQL literal, longest name first so :ab != :abc."""
    for pname in sorted(params, key=len, reverse=True):
        val = state.get(params[pname].split(".", 1)[-1])
        lit = "NULL" if val is None else "'" + str(val).replace("'", "''") + "'"
        sql = sql.replace(f":{pname}", lit)
    return sql


def run(sql):
    p = subprocess.run(
        ["snow", "sql", "-c", CONN, "-q", sql, "--format", "json",
         "--enable-templating", "NONE"],
        capture_output=True, text=True, timeout=900,
    )
    if p.returncode != 0:
        tail = (p.stdout + p.stderr).strip().splitlines()
        return "ERROR", " ".join(t.strip() for t in tail[-4:])[:220]
    try:
        rows = json.loads(p.stdout)
    except json.JSONDecodeError:
        return "ERROR", "unparseable output"
    return ("OK" if rows else "EMPTY"), f"{len(rows)} row(s)"


def main() -> int:
    view = json.loads(APP.read_text())[VIEW]

    # Pass 1: first render. Region resolved, nothing selected, sliders unset so
    # every threshold falls back to the region's stored standard.
    first = {"region": "SanFrancisco"}
    # Pass 2: a seeded selection. Sourced from the data rather than invented, so
    # the gap area is exercised on a route that genuinely has geocoded stops.
    seed_sql = (
        "SELECT r.ROUTE_ID, r.PLANNER_ID, r.VEHICLE_ID,"
        " TO_VARCHAR(r.PLAN_DATE,'YYYY-MM-DD') AS PLAN_DATE, r.REGION, r.STOPS,"
        " TO_VARCHAR(ARRAY_CONSTRUCT(r.DEPOT_LNG, r.DEPOT_LAT)) AS DEPOT_JSON,"
        " TO_VARCHAR(s.STOPS_JSON) AS STOPS_JSON"
        " FROM FLEET_APP.PLAN_STANDARDS.VW_ROUTE_PLAN r"
        " JOIN (SELECT ROUTE_ID, ARRAY_AGG(ARRAY_CONSTRUCT(STOP_LNG, STOP_LAT))"
        " WITHIN GROUP (ORDER BY STOP_SEQ) AS STOPS_JSON"
        " FROM FLEET_APP.PLAN_STANDARDS.VW_ROUTE_STOPS WHERE SITE_GEOG IS NOT NULL"
        " GROUP BY ROUTE_ID) s ON s.ROUTE_ID = r.ROUTE_ID"
        " WHERE r.REGION='SanFrancisco' AND r.DEPOT_LNG IS NOT NULL"
        " AND r.GEOCODED_STOPS BETWEEN 6 AND 12"
        " ORDER BY r.KM_PER_STOP DESC LIMIT 1"
    )
    p = subprocess.run(
        ["snow", "sql", "-c", CONN, "-q", seed_sql, "--format", "json",
         "--enable-templating", "NONE"],
        capture_output=True, text=True, timeout=600,
    )
    seed = json.loads(p.stdout)[0] if p.returncode == 0 and p.stdout.strip() else {}
    if not seed:
        print("FATAL: could not seed a selection")
        return 1
    print(f"seeded route {seed['ROUTE_ID']} ({seed['STOPS']} stops)\n")

    second = dict(first)
    second.update(
        {
            "selected_planner": seed["PLANNER_ID"],
            "selected_route": seed["ROUTE_ID"],
            "selected_route_vehicle": seed["VEHICLE_ID"],
            "selected_route_date": seed["PLAN_DATE"],
            "selected_route_region": seed["REGION"],
            "selected_route_stop_count": seed["STOPS"],
            "selected_route_depot": seed["DEPOT_JSON"],
            "selected_route_stops": seed["STOPS_JSON"],
            # Sliders left unset on purpose in BOTH passes: the stored standard is
            # the default, and an override would hide a wrong fallback.
        }
    )

    failures = 0
    for label, state in (("first render", first), ("with selection", second)):
        print(f"--- {label} ---")
        for _area, name, sql, params in areas(view):
            status, detail = run(bind(sql, params, state))
            # An empty first render is expected for the selection-driven areas.
            expected_empty = label == "first render" and name.startswith(
                ("gap", "map")
            )
            bad = status == "ERROR" or (status == "EMPTY" and not expected_empty)
            if bad:
                failures += 1
            flag = "FAIL" if bad else "ok  "
            print(f"  {flag} {name:34} {status:6} {detail}")
        print()
    print("FAILURES:" if failures else "ALL AREAS RETURN DATA", failures or "")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
