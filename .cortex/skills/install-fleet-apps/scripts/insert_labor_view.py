#!/usr/bin/env python3
"""One-shot inserter for the labor_overtime view into app-views.json.

Kept as a script rather than a hand edit because app-views.json is 6k lines of
pretty-printed JSON: a text insertion is easy to get subtly wrong, and a
json.load/json.dump round trip would reformat the entire file and bury the real
change in a whole-file diff. This inserts the new key as text at a known
boundary and then parses the result to prove it is still valid JSON.

Safe to re-run: if labor_overtime is already present it exits without changing
anything.
"""
import json
import sys
from pathlib import Path

APP_VIEWS = Path(__file__).resolve().parents[1] / "fleet_sa_app" / "app" / "app-views.json"
VIEW_ID = "labor_overtime"
ANCHOR = '  "space_time_density": {'

WEEK_FN = "TABLE(FLEET_APP.LABOR.F_FACT_LABOR_WEEK_SCOPED(CAST(:region AS VARCHAR), CAST(:dataset_id AS VARCHAR)))"
DUTY_FN = "TABLE(FLEET_APP.LABOR.F_FACT_DUTY_PERIOD_SCOPED(CAST(:region AS VARCHAR), CAST(:dataset_id AS VARCHAR)))"
TRIPS_FN = "TABLE(FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED(CAST(:region AS VARCHAR), CAST(:dataset_id AS VARCHAR)))"

SCOPE_PARAMS = {
    "region": "context.region",
    "vehicle_type": "context.vehicle_type",
    "dataset_id": "context.dataset_id",
}


def scope_params(**extra):
    p = dict(SCOPE_PARAMS)
    p.update(extra)
    return p


VIEW = {
    "label": "Labour and Overtime",
    "category": "Core",
    "description": "Paid hours per {{labels.operator}} per payroll week, projected to week end against overtime thresholds, with the resulting cost and the teams driving it.",
    "useCase": {
        "headline": "See who is going to blow through an overtime threshold while there are still days left to do something about it.",
        "businessQuestion": "Which {{labels.operator_plural}} are projected to exceed their weekly hours limit, what will it cost, and which depot is generating it?",
        "audience": [
            "Operations leader",
            "Depot or branch supervisor",
            "HR and labour relations",
            "Finance and workforce planning",
        ],
        "industries": [
            "Distribution and DSD",
            "Logistics and transport",
            "Field service",
            "Last-mile delivery",
        ],
        "talkTrack": [
            "Start at the KPI row: how many {{labels.operator_plural}} are on the clock this week, how many are projected to cross the limit, and what the overtime is projected to cost.",
            "Make the timing point: this is a PROJECTION from the hours worked so far, not a month-end report. It is actionable while the week is still running.",
            "Open the at-risk table. It is ordered by projected hours, so it is a call list, and it already names the supervisor to call.",
            "Click an {{labels.operator}} and show the cumulative-hours line crossing the threshold markers, then their week's work on the map.",
            "Move to the team chart and reframe the problem: if the overtime concentrates in one shift pattern or one depot, the fix is rostering, not coaching individuals.",
            "Close on the platform point: no timekeeping integration was needed to get here. The hours were reconstructed from operational data already in Snowflake, and an alert can fire on this same projection before the threshold is crossed.",
        ],
        "snowflakeCapabilities": [
            "Paid time reconstructed from trip records with window-function sessionization, so no timekeeping feed is required to demonstrate the workflow",
            "The PERIOD data type with PERIOD_INTERSECT to split a duty period that straddles a payroll week boundary, so weekly hours are exact rather than clamped",
            "Semantic view (SV_LABOR) so the agent answers overtime questions in plain language without new SQL",
            "Snowflake ALERT plus a notification integration to warn a supervisor before a threshold is crossed, on the same projection shown here",
            "Masking and row access policies available on the same tables, which matters more for labour data than for fleet telemetry",
        ],
        "dataRequired": [
            "Trip or job records attributed to a person, with start and end timestamps",
            "A timekeeping or payroll feed for true clock hours, pay rates and contracted hours (this demo synthesizes the commercial attributes)",
            "The overtime thresholds and payroll week start that apply in the jurisdiction",
            "Team or depot structure and supervisor assignment, to route an alert to a human",
        ],
        "valueDrivers": [
            "Intervene before a threshold is crossed rather than discovering it in the payroll run",
            "Attribute overtime to a shift pattern or depot, so the fix is a rostering change instead of across-the-board coaching",
            "Protect the workforce from sustained excessive hours, not just the labour budget",
        ],
        "method": "A duty period is a maximal run of an {{labels.operator}}'s trips with no gap longer than a configured threshold, so a shift crossing midnight stays one shift. Paid hours are the duty SPAN (first trip start to last trip end), because someone waiting between stops is on the clock; driving hours are tracked separately so the difference shows as utilization. Each duty period is intersected with the payroll week or weeks it touches, so a duty period straddling the boundary contributes to both and no hours are lost. Projection for the in-progress week is a linear daily run rate, anchored to the latest activity in the dataset rather than to wall-clock time.",
        "caveats": "Hours, days worked, trips and distance are derived from real recorded trips. Contracted hours, hourly rate, team and supervisor do NOT exist in the source data and are generated deterministically from the {{labels.operator}} id, so the overtime COST is indicative and the team structure is illustrative - the hours themselves are not synthesized. Paid time is modelled as the duty span, which excludes pre-trip and post-trip work a real clock system would capture, so these figures understate true paid hours. The fleet itself is synthetic. In a real deployment, per-person hours tracking is a decision for the customer, their legal team and where applicable their works council, and the thresholds shown default to US FLSA rather than local law.",
    },
    "agentKnowledge": {
        "preferredTool": "query_labor",
        "keyMetrics": [
            "operators on the clock this week",
            "operators projected to reach the at-risk threshold",
            "operators projected to breach the top threshold",
            "estimated overtime cost at week end",
            "average share of paid hours spent driving (utilization)",
            "projected week-end hours per operator",
            "projected overtime hours and cost per team",
        ],
        "exampleQuestions": [
            "who is projected to exceed 60 hours this week?",
            "which team has the most overtime?",
            "what will overtime cost us this week?",
            "who should I call about overtime?",
            "how many hours has DRV-00035 worked so far?",
            "is our overtime coming from one shift pattern?",
        ],
        "gotchas": "query_labor (SV_LABOR) models this whole view. Use projected_week_hours, NOT hours_to_date, for any 'will exceed' question - hours_to_date is mid-week and always under the limit. Filter is_current_week = TRUE for the projectable week; a completed week projects to its actual. A week with is_partial_start = TRUE is cut off at its BEGINNING by the dataset boundary, so its low totals are an artifact and must never be presented as a drop in hours. Thresholds are DATA (ot_threshold_1/2/3), not a fixed 40/50/60 - read them rather than assuming, since the defaults are US FLSA. Overtime COST rests on synthesized pay rates, so qualify money figures; the HOURS are derived from real trips and need no such caveat. Never mix the duty grain into weekly totals: a duty period straddling a week boundary counts in both weeks in the weekly fact but once in the duty fact.",
    },
    "layout": {
        "default": {
            "columns": "1fr 1fr",
            "rows": "auto auto $content $map",
            "grid": '"kpi kpi"\n"projection team"\n"table table"\n"map map"',
        }
    },
    "areas": {
        "kpi": {
            "component": "MetricCards",
            "data": {
                "query": (
                    "SELECT COUNT(DISTINCT OPERATOR_ID) AS operators, "
                    "SUM(IFF(OT_BAND = 'AT_RISK', 1, 0)) AS approaching, "
                    "SUM(IFF(OT_BAND = 'BREACH', 1, 0)) AS projected_breach, "
                    "ROUND(SUM(EST_OT_COST), 0) AS ot_cost, "
                    "ROUND(AVG(DRIVE_SHARE_OF_PAID) * 100, 1) AS utilization "
                    f"FROM {WEEK_FN} WHERE IS_CURRENT_WEEK"
                ),
                "params": scope_params(),
                "mapping": {
                    "metrics": [
                        {"column": "operators", "label": "{{labels.operator_plural}} On Clock", "format": "number"},
                        {"column": "approaching", "label": "Approaching Limit", "format": "number"},
                        {"column": "projected_breach", "label": "Projected Breach", "format": "number"},
                        {"column": "ot_cost", "label": "Est. Overtime Cost", "format": "number"},
                        {"column": "utilization", "label": "Paid-Hour Utilisation %", "format": "number_2dp"},
                    ]
                },
            },
        },
        "projection": {
            "component": "Chart",
            "data": {
                "query": (
                    "WITH wk AS ("
                    f"  SELECT MIN(WEEK_START) AS WS FROM {WEEK_FN} WHERE IS_CURRENT_WEEK"
                    "), d AS ("
                    "  SELECT DUTY_START::DATE AS DAY, PAID_HOURS, OPERATOR_ID"
                    f"  FROM {DUTY_FN}, wk"
                    "  WHERE DUTY_START >= wk.WS::TIMESTAMP_NTZ"
                    "    AND (:selected_operator IS NULL OR OPERATOR_ID = :selected_operator)"
                    "), agg AS ("
                    "  SELECT DAY, SUM(PAID_HOURS) / COUNT(DISTINCT OPERATOR_ID) AS HRS FROM d GROUP BY DAY"
                    ") "
                    "SELECT TO_VARCHAR(DAY, 'Dy DD Mon') AS day, "
                    "ROUND(SUM(HRS) OVER (ORDER BY DAY), 1) AS cumulative_hours, "
                    f"(SELECT MAX(OT_THRESHOLD_1) FROM {WEEK_FN}) AS ot_starts, "
                    f"(SELECT MAX(OT_THRESHOLD_3) FROM {WEEK_FN}) AS breach_limit "
                    "FROM agg ORDER BY DAY"
                ),
                "params": scope_params(selected_operator="viewState.selected_operator"),
            },
            "config": {
                "title": "Cumulative Paid Hours This Week vs Thresholds",
                "xAxis": {"field": "day", "fieldType": "category"},
                "series": [
                    {"type": "bar", "field": "cumulative_hours", "label": "Cumulative Hours"},
                    {"type": "line", "field": "ot_starts", "label": "Overtime Starts"},
                    {"type": "line", "field": "breach_limit", "label": "Breach Limit"},
                ],
            },
        },
        "team": {
            "component": "Chart",
            "data": {
                "query": (
                    "SELECT TEAM_ID AS team, "
                    "ROUND(SUM(PROJECTED_OT_HOURS), 1) AS projected_ot_hours, "
                    "COUNT(DISTINCT IFF(OT_BAND IN ('AT_RISK', 'BREACH'), OPERATOR_ID, NULL)) AS at_risk_operators "
                    f"FROM {WEEK_FN} WHERE IS_CURRENT_WEEK AND TEAM_ID IS NOT NULL "
                    "GROUP BY TEAM_ID ORDER BY projected_ot_hours DESC NULLS LAST LIMIT 12"
                ),
                "params": scope_params(),
            },
            "config": {
                "title": "Projected Overtime by Team",
                "xAxis": {"field": "team", "fieldType": "category"},
                "series": [
                    {"type": "bar", "field": "projected_ot_hours", "label": "Projected OT Hours"},
                    {"type": "bar", "field": "at_risk_operators", "label": "At-Risk {{labels.operator_plural}}"},
                ],
            },
        },
        "table": {
            "component": "ClickableTable",
            "data": {
                "query": (
                    "SELECT OPERATOR_ID AS operator, TEAM_ID AS team, SUPERVISOR_ID AS supervisor, "
                    "SHIFT_TYPE AS shift, OT_BAND AS band, "
                    "HOURS_TO_DATE AS hours_so_far, DAYS_WORKED AS days_worked, "
                    "PROJECTED_WEEK_HOURS AS projected_hours, PROJECTED_OT_HOURS AS projected_ot_hours, "
                    "EST_OT_COST AS est_ot_cost, "
                    "ROUND(DRIVE_SHARE_OF_PAID * 100, 1) AS utilisation_pct, "
                    "STOPS_PER_PAID_HOUR AS stops_per_hour "
                    f"FROM {WEEK_FN} WHERE IS_CURRENT_WEEK "
                    "ORDER BY projected_hours DESC NULLS LAST LIMIT 100"
                ),
                "params": scope_params(),
            },
            "config": {
                "rowKey": "operator",
                "defaultSort": {"column": "projected_hours", "direction": "desc"},
            },
            "emits": {"selected_operator": "selection"},
        },
        "map": {
            "component": "Map",
            "config": {
                "noPad": True,
                "legend": [
                    {"label": "Work this week", "color": [41, 181, 232, 170], "shape": "line"}
                ],
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
                                "WITH wk AS ("
                                f"  SELECT MIN(WEEK_START) AS WS FROM {WEEK_FN} WHERE IS_CURRENT_WEEK"
                                ") "
                                "SELECT t.TRIP_ID AS trip_id, "
                                "ST_ASGEOJSON(t.ROUTE_GEOG)::STRING AS route_geojson "
                                f"FROM {TRIPS_FN} t, wk "
                                "WHERE t.ROUTE_GEOG IS NOT NULL "
                                "  AND t.TRIP_START >= wk.WS::TIMESTAMP_NTZ "
                                "  AND (:selected_operator IS NULL OR t.DRIVER_ID = :selected_operator) "
                                "ORDER BY t.TRIP_START LIMIT 400"
                            ),
                            "params": scope_params(selected_operator="viewState.selected_operator"),
                        },
                    }
                ],
            },
        },
    },
}


def main() -> int:
    raw = APP_VIEWS.read_text()
    if f'"{VIEW_ID}"' in raw:
        print(f"{VIEW_ID} already present - nothing to do")
        return 0
    if ANCHOR not in raw:
        print(f"ERROR: anchor not found: {ANCHOR!r}", file=sys.stderr)
        return 1

    body = json.dumps({VIEW_ID: VIEW}, indent=2, ensure_ascii=False)
    # json.dumps with indent=2 already puts the single top-level key at a 2-space
    # indent, which is exactly the depth of its future siblings, so dropping the
    # wrapping braces is the whole re-indent.
    block = "\n".join(body.split("\n")[1:-1])

    updated = raw.replace(ANCHOR, block + ",\n" + ANCHOR, 1)

    # Prove the result is still valid JSON and that the view landed at top level
    # with the blocks the Tenet 10 gate requires, BEFORE writing.
    parsed = json.loads(updated)
    if VIEW_ID not in parsed:
        print("ERROR: view did not land at top level", file=sys.stderr)
        return 1
    for required in ("useCase", "agentKnowledge", "layout", "areas"):
        if required not in parsed[VIEW_ID]:
            print(f"ERROR: {VIEW_ID} missing {required}", file=sys.stderr)
            return 1
    for dash in ("\u2013", "\u2014"):
        if dash in json.dumps(parsed[VIEW_ID], ensure_ascii=False):
            print(f"ERROR: unicode dash {dash!r} present", file=sys.stderr)
            return 1

    APP_VIEWS.write_text(updated)
    print(f"inserted {VIEW_ID} ({len(parsed)} views total)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
