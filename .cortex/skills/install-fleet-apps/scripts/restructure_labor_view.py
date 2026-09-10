#!/usr/bin/env python3
"""Restructure the labor_overtime view to industry-standard shape.

Rewrites the existing entry in app-views.json rather than appending, because the
view already exists. Same reasoning as insert_labor_view.py for using a script:
the file is 6k lines of pretty-printed JSON where a text edit is easy to get
subtly wrong, and a whole-file json round trip would bury the change.

What changes, and why:

1. The EXCEPTION LIST becomes the centre of gravity, directly under the KPI row.
   It is the only panel that produces an action today - everything else is
   context for it. It also gains BINDING_CONSTRAINT (which limit actually
   applies) and a structural-cause column, so it does not read as surveillance.

2. The KPI row leads with OT % (denominator named in the label) and the AVOIDABLE
   premium rather than the loaded cost, and adds headcount vs FTE.

3. The cumulative-hours chart is replaced by a DISTRIBUTION. The old chart
   averaged across operators when nothing was selected, which hid exactly the
   outliers the view exists to surface - a fleet averaging 24h can contain
   someone heading for 85h, so the threshold reference lines looked decorative
   until a row was clicked. A histogram answers the same question honestly and
   shows concentration: 20 operators at 55h is a different problem from 200 at
   42h, and the mean is identical.

4. A weekly TREND panel is added. Weekly grain only, with no smoothing, because
   FLSA forbids averaging hours across two or more weeks.

5. A COMPLIANCE panel shows the count by binding constraint, making the
   regulatory regime visible rather than implied.
"""
import json
import sys
from pathlib import Path

APP_VIEWS = Path(__file__).resolve().parents[1] / "fleet_sa_app" / "app" / "app-views.json"
VIEW_ID = "labor_overtime"

WEEK_FN = "TABLE(FLEET_APP.LABOR.F_FACT_LABOR_WEEK_SCOPED(CAST(:region AS VARCHAR), CAST(:dataset_id AS VARCHAR)))"
TRIPS_FN = "TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(CAST(:region AS VARCHAR), CAST(:dataset_id AS VARCHAR)))"

SCOPE = {"region": "context.region", "vehicle_type": "context.vehicle_type", "dataset_id": "context.dataset_id"}


def params(**extra):
    p = dict(SCOPE)
    p.update(extra)
    return p


AREAS = {
    # ---------------------------------------------------------------- KPI row
    "kpi": {
        "component": "MetricCards",
        "data": {
            "query": (
                "SELECT COUNT(DISTINCT OPERATOR_ID) AS headcount, "
                "ROUND(SUM(FTE_EQUIVALENT), 1) AS fte, "
                "ROUND(100 * DIV0(SUM(OT_HOURS), SUM(HOURS_TO_DATE)), 1) AS ot_pct, "
                "ROUND(SUM(EST_OT_PREMIUM), 0) AS ot_premium, "
                "COUNT(DISTINCT IFF(OT_BAND IN ('AT_RISK','BREACH'), OPERATOR_ID, NULL)) AS at_risk, "
                "ROUND(100 * AVG(DRIVE_SHARE_OF_PAID), 1) AS drive_share "
                f"FROM {WEEK_FN} WHERE IS_CURRENT_WEEK"
            ),
            "params": params(),
            "mapping": {
                "metrics": [
                    {"column": "headcount", "label": "{{labels.operator_plural}}", "format": "number"},
                    {"column": "fte", "label": "FTE", "format": "number_2dp"},
                    {"column": "ot_pct", "label": "OT % of Paid Hours", "format": "number_2dp"},
                    {"column": "ot_premium", "label": "OT Premium (avoidable)", "format": "number"},
                    {"column": "at_risk", "label": "At Risk or Breach", "format": "number"},
                    {"column": "drive_share", "label": "Driving % of Paid", "format": "number_2dp"},
                ]
            },
        },
    },
    # ------------------------------------------------- the exception list
    "table": {
        "component": "ClickableTable",
        "data": {
            "query": (
                "SELECT OPERATOR_ID AS operator, TEAM_ID AS team, SUPERVISOR_ID AS supervisor, "
                "OT_BAND AS band, BINDING_CONSTRAINT AS binding_limit, "
                "HOURS_TO_DATE AS hours_so_far, PROJECTED_WEEK_HOURS AS projected_hours, "
                "DAYS_REMAINING AS days_left, "
                "PROJECTED_OT_HOURS AS projected_ot_hours, EST_OT_PREMIUM AS ot_premium, "
                # Structural cause, so a named person is never shown without the reason.
                "SHIFT_TYPE AS shift_pattern, DAYS_WORKED AS days_worked, "
                "ROUND(100 * DRIVE_SHARE_OF_PAID, 1) AS driving_pct, "
                "IFF(OT_ELIGIBLE_FLSA, 'Yes', 'Exempt (CMV)') AS flsa_ot_eligible "
                f"FROM {WEEK_FN} WHERE IS_CURRENT_WEEK "
                "ORDER BY projected_hours DESC NULLS LAST LIMIT 100"
            ),
            "params": params(),
        },
        "config": {
            "rowKey": "operator",
            "defaultSort": {"column": "projected_hours", "direction": "desc"},
        },
        "emits": {"selected_operator": "selection"},
    },
    # ------------------------------------------------------- distribution
    "distribution": {
        "component": "Chart",
        "data": {
            "query": (
                "WITH b AS ("
                "  SELECT CASE "
                "    WHEN PROJECTED_WEEK_HOURS < 20 THEN '00-20' "
                "    WHEN PROJECTED_WEEK_HOURS < 30 THEN '20-30' "
                "    WHEN PROJECTED_WEEK_HOURS < 40 THEN '30-40' "
                "    WHEN PROJECTED_WEEK_HOURS < 50 THEN '40-50' "
                "    WHEN PROJECTED_WEEK_HOURS < 60 THEN '50-60' "
                "    WHEN PROJECTED_WEEK_HOURS < 70 THEN '60-70' "
                "    ELSE '70+' END AS bucket, OPERATOR_ID "
                f"  FROM {WEEK_FN} WHERE IS_CURRENT_WEEK"
                ") "
                "SELECT bucket AS projected_hours_band, COUNT(DISTINCT OPERATOR_ID) AS operators "
                "FROM b GROUP BY bucket ORDER BY bucket"
            ),
            "params": params(),
        },
        "config": {
            "title": "Projected Week Hours: How Many {{labels.operator_plural}} in Each Band",
            "xAxis": {"field": "projected_hours_band", "fieldType": "category"},
            "series": [{"type": "bar", "field": "operators", "label": "{{labels.operator_plural}}"}],
        },
    },
    # ------------------------------------------------------------- trend
    "trend": {
        "component": "Chart",
        "data": {
            "query": (
                "SELECT WEEK_LABEL AS week, "
                "ROUND(100 * DIV0(SUM(OT_HOURS), SUM(HOURS_TO_DATE)), 1) AS ot_pct_of_paid, "
                "ROUND(SUM(EST_OT_PREMIUM), 0) AS ot_premium, "
                "COUNT(DISTINCT IFF(OT_BAND IN ('AT_RISK','BREACH'), OPERATOR_ID, NULL)) AS at_risk_operators "
                f"FROM {WEEK_FN} "
                # A week truncated at its START by the dataset boundary is not
                # comparable to a full week and would read as a fleet-wide drop.
                "WHERE NOT IS_PARTIAL_START "
                "GROUP BY WEEK_LABEL ORDER BY week"
            ),
            "params": params(),
        },
        "config": {
            "title": "Weekly Overtime Trend (no smoothing: FLSA forbids multi-week averaging)",
            "xAxis": {"field": "week", "fieldType": "category"},
            "series": [
                {"type": "bar", "field": "ot_premium", "label": "OT Premium"},
                {"type": "line", "field": "at_risk_operators", "label": "At-Risk {{labels.operator_plural}}"},
            ],
        },
    },
    # -------------------------------------------------------- compliance
    "compliance": {
        "component": "Chart",
        "data": {
            "query": (
                "SELECT BINDING_CONSTRAINT AS binding_limit, "
                "COUNT(DISTINCT OPERATOR_ID) AS operators "
                f"FROM {WEEK_FN} WHERE IS_CURRENT_WEEK "
                "GROUP BY BINDING_CONSTRAINT ORDER BY operators DESC"
            ),
            "params": params(),
        },
        "config": {
            "title": "Which Limit Binds (FLSA pay vs DOT hours-of-service)",
            "xAxis": {"field": "binding_limit", "fieldType": "category"},
            "series": [{"type": "bar", "field": "operators", "label": "{{labels.operator_plural}}"}],
        },
    },
    # -------------------------------------------------------------- team
    "team": {
        "component": "Chart",
        "data": {
            "query": (
                "SELECT TEAM_ID AS team, "
                "ROUND(SUM(EST_OT_PREMIUM), 0) AS ot_premium, "
                "COUNT(DISTINCT IFF(OT_BAND IN ('AT_RISK','BREACH'), OPERATOR_ID, NULL)) AS at_risk_operators "
                f"FROM {WEEK_FN} WHERE IS_CURRENT_WEEK AND TEAM_ID IS NOT NULL "
                "GROUP BY TEAM_ID ORDER BY ot_premium DESC NULLS LAST LIMIT 12"
            ),
            "params": params(),
        },
        "config": {
            "title": "Overtime Premium by Depot Team",
            "xAxis": {"field": "team", "fieldType": "category"},
            "series": [
                {"type": "bar", "field": "ot_premium", "label": "OT Premium"},
                {"type": "bar", "field": "at_risk_operators", "label": "At-Risk {{labels.operator_plural}}"},
            ],
        },
    },
    # --------------------------------------------------------------- map
    "map": {
        "component": "Map",
        "config": {
            "noPad": True,
            "legend": [{"label": "Work this week", "color": [41, 181, 232, 170], "shape": "line"}],
            "layers": [
                {
                    "type": "path",
                    "id": "labor-week-trips",
                    "geojsonColumn": "route_geojson",
                    "color": [41, 181, 232, 170],
                    "width": 3,
                    "widthMinPixels": 1,
                    "data": {
                        "query": (
                            f"WITH wk AS (SELECT MIN(WEEK_START) AS WS FROM {WEEK_FN} WHERE IS_CURRENT_WEEK) "
                            "SELECT t.TRIP_ID AS trip_id, ST_ASGEOJSON(t.ROUTE_GEOG)::STRING AS route_geojson "
                            f"FROM {TRIPS_FN} t, wk "
                            "WHERE t.ROUTE_GEOG IS NOT NULL "
                            "  AND t.TRIP_START >= wk.WS::TIMESTAMP_NTZ "
                            "  AND (:selected_operator IS NULL OR t.DRIVER_ID = :selected_operator) "
                            "ORDER BY t.TRIP_START LIMIT 400"
                        ),
                        "params": params(selected_operator="viewState.selected_operator"),
                    },
                }
            ],
        },
    },
}

LAYOUT = {
    "default": {
        "columns": "1fr 1fr",
        "rows": "auto $content auto auto $map",
        "grid": '"kpi kpi"\n"table table"\n"distribution trend"\n"compliance team"\n"map map"',
    }
}


def main() -> int:
    raw = APP_VIEWS.read_text()
    doc = json.loads(raw)
    if VIEW_ID not in doc:
        print(f"ERROR: {VIEW_ID} not found", file=sys.stderr)
        return 1

    view = doc[VIEW_ID]
    view["layout"] = LAYOUT
    view["areas"] = AREAS

    # Locate the existing block by its key line and replace just that slice, so
    # the rest of the 6k-line file keeps its byte-for-byte formatting.
    start_marker = f'  "{VIEW_ID}": {{'
    start = raw.index(start_marker)
    # The next top-level key begins at the first line matching two-space indent
    # plus a quote after our block starts.
    rest = raw[start + len(start_marker):]
    depth = 1
    i = 0
    while depth > 0:
        ch = rest[i]
        if ch == '"':  # skip strings, including escapes
            i += 1
            while rest[i] != '"':
                i += 2 if rest[i] == "\\" else 1
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        i += 1
    end = start + len(start_marker) + i

    block = json.dumps({VIEW_ID: view}, indent=2, ensure_ascii=False)
    block = "\n".join(block.split("\n")[1:-1])

    updated = raw[:start] + block + raw[end:]

    parsed = json.loads(updated)
    v = parsed[VIEW_ID]
    for required in ("useCase", "agentKnowledge", "layout", "areas"):
        if required not in v:
            print(f"ERROR: lost {required}", file=sys.stderr)
            return 1
    expected = set(AREAS) | {"kpi"}
    if set(v["areas"]) != set(AREAS):
        print(f"ERROR: areas mismatch {set(v['areas'])}", file=sys.stderr)
        return 1
    for dash in ("\u2013", "\u2014"):
        if dash in json.dumps(v, ensure_ascii=False):
            print(f"ERROR: unicode dash {dash!r}", file=sys.stderr)
            return 1
    if len(parsed) != len(doc):
        print(f"ERROR: view count changed {len(doc)} -> {len(parsed)}", file=sys.stderr)
        return 1

    APP_VIEWS.write_text(updated)
    print(f"restructured {VIEW_ID}: areas = {', '.join(AREAS)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
