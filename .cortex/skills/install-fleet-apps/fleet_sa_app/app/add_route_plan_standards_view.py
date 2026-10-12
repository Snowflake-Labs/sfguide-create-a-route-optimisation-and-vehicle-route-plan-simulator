#!/usr/bin/env python3
"""Insert the route_plan_standards view into app-views.json.

WHY A SCRIPT, AND WHY A TEXTUAL SPLICE.
app-views.json is a single 6,700-line object and this working tree is shared by
parallel sessions, so a whole-file rewrite would clobber a concurrent edit. A
json.load / json.dump round-trip is NOT safe either: the committed file keeps
many small arrays and objects on one line, so re-serialising it with indent=2
expands it to 8,457 lines and turns a one-view addition into a whole-file diff.
Measured, not assumed.

So the new key is spliced in as TEXT before the closing brace, and the rest of
the file is never touched. Running this twice replaces the block rather than
appending a duplicate.
"""
import json
import pathlib
import re
import sys

APP = pathlib.Path(__file__).resolve().parent / "app-views.json"
KEY = "route_plan_standards"

# ---------------------------------------------------------------------------
# Shared SQL fragments.
#
# REGION is the region predicate, spelled the "de-scoped consumer" way on
# purpose: the contract views carry every loaded region, so a query with no
# region predicate renders a populated panel that mixes San Francisco metro
# routes with continental line-haul. The NULL arm keeps the page alive before the
# context bar has resolved.
REGION = "(:region IS NULL OR r.REGION = :region)"

# Threshold overrides. The STANDARDS table stays authoritative: each slider is an
# OVERRIDE that COALESCEs to the row's own configured value, so the stored flags
# are reproduced exactly until someone moves a slider, and a region with
# different bands is never silently re-scored against another region's numbers.
# Only shift and density are overridable - they are the two a planning manager
# actually negotiates - and what gets restated is the COMPARISON, not the scoring
# rule, so there is no second copy of the standard to drift.
SHIFT_BREACH = "(r.PLAN_HOURS > COALESCE(:max_shift, r.MAX_SHIFT_HOURS))"
DENSITY_BREACH = "(r.KM_PER_STOP > COALESCE(:max_density, r.MAX_KM_PER_STOP))"
# The other three keep their stored flags. IS_TERRITORY_BREACH is already TRUE
# when nothing could be geocoded, which is deliberate and must not be softened
# here into "unmeasurable means fine".
BREACHES = (
    f"(IFF({SHIFT_BREACH},1,0) + IFF({DENSITY_BREACH},1,0)"
    " + IFF(r.IS_STOP_BAND_BREACH,1,0) + IFF(r.IS_TERRITORY_BREACH,1,0)"
    " + IFF(r.IS_SEQUENCE_BREACH,1,0))"
)

CTX = {"region": "context.region"}
CTX_SLIDERS = {
    "region": "context.region",
    "max_shift": "viewState.max_shift",
    "max_density": "viewState.max_density",
}

VIEW = {
    "label": "Route Plan Standards",
    "category": "Core",
    "description": (
        "How consistently each route planner builds routes against the written"
        " standard, what the variation costs against a live optimizer re-solve, and"
        " whether plans land early enough for the warehouse to start building"
        " sessions."
    ),
    "useCase": {
        "headline": (
            "Put a number on planner-to-planner variation, then price it against"
            " what the optimizer would have done with the same stops."
        ),
        "businessQuestion": (
            "Are all our route planners working to the same standard, and what is"
            " the inconsistency costing us in distance, hours and warehouse start"
            " time?"
        ),
        "audience": [
            "Head of transport planning",
            "Route planning manager",
            "Distribution centre manager",
            "Supply chain lead",
        ],
        "industries": [
            "Beverage and food distribution",
            "Retail distribution",
            "Wholesale and cash-and-carry",
            "Field service",
        ],
        "talkTrack": [
            "Open on the KPI strip: routes planned, the share meeting every"
            " standard, and how many planners sit off standard.",
            "Work the planner league table. Compliance and consistency are separate"
            " columns, so find a planner who scores well on one and badly on the"
            " other - that planner follows the rules and still plans unpredictably.",
            "Click that planner to see their own routes, and read which standard"
            " each route breaks rather than a blended score.",
            "Click a route and read the live optimizer comparison: the same stops"
            " re-solved on the real road graph, with the excess distance and cost.",
            "Move the shift-hours slider and watch compliance move. The standard is"
            " data, so a planning manager changes it without a release.",
            "Close on the warehouse readiness chart: the plans land after the"
            " warehouse wants to start picking, which is the delay the business"
            " actually feels.",
        ],
        "snowflakeCapabilities": [
            "The planning standard held as data and joined per region, so changing a"
            " threshold re-scores every planner with no code change",
            "A live VROOM re-solve of the selected route through OpenRouteService on"
            " Snowpark Container Services, so the benchmark is the real road network"
            " rather than a stored estimate",
            "The same scored routes answerable by the Cortex agent through"
            " SV_PLAN_STANDARDS, so a planning manager can ask rather than filter",
        ],
        "dataRequired": [
            "Planned routes with ordered stops (vehicle, date, sequence)",
            "Site master with location for the stops and the depot",
            "Vehicle-to-depot assignment",
            "The planning standard: stop band, shift cap, density and territory"
            " limits",
        ],
        "valueDrivers": [
            "Bring every planner onto one standard instead of managing dozens of"
            " private methods",
            "Cut planned distance by re-sequencing the routes the optimizer can"
            " already improve",
            "Release plans earlier so the warehouse starts building sessions at the"
            " start of the shift rather than waiting on planning",
        ],
        "method": (
            "Planned legs are grouped into routes by vehicle and planning date, then"
            " each route is scored against five independent standards for its"
            " region: stop band, shift hours, km per stop, territory radius and"
            " stop-order integrity. Planners are ranked on compliance and,"
            " separately, on the standard deviation of km per stop, which is the"
            " consistency measure. The selected route is re-solved live by the"
            " optimizer on the region road graph to price the gap."
        ),
        "caveats": (
            "Two fields are DERIVED, not recorded. Planner attribution is"
            " synthesized from the vehicle: it matches the dispatcher shown on Asset"
            " Velocity and is stable, but it is not a name from an HR system. Plan"
            " release time is recorded nowhere in the source, so it is inferred as"
            " the latest moment a plan could have been released and still have the"
            " vehicle leave on time - every readiness figure is therefore a bound on"
            " lateness rather than a measured clock. Only dense urban regions have"
            " multi-stop route plans: San Francisco averages 28 stops per route"
            " while the long-haul regions average 1.3, so those regions score"
            " near-perfect against bands that do not describe them. About 86 percent"
            " of stops resolve to a site geometry, and a route with none is counted"
            " as a territory breach rather than passed, so read the geocoded count"
            " beside any territory claim. The optimizer comparison is a live engine"
            " call for one route at a time and needs the region's routing service"
            " running. Telemetry and site data are synthetic."
        ),
    },
    "agentKnowledge": {
        "preferredTool": "query_plan_standards",
        "keyMetrics": [
            "routes planned and the share meeting every standard",
            "per-planner compliance percent AND the standard deviation of km per"
            " stop, which is the separate consistency measure",
            "breach counts split by which standard was broken",
            "excess km and cost from the live optimizer re-solve of the selected"
            " route",
            "minutes the last plan for a depot lands after the warehouse session"
            " start",
        ],
        "exampleQuestions": [
            "Which route planners are least consistent?",
            "Which planners build routes that run past the shift limit?",
            "What would the optimizer have done with this route?",
            "Which depots cannot start building sessions on time?",
            "What is our route plan compliance in San Francisco?",
        ],
        "gotchas": (
            "Compliance and consistency are DIFFERENT questions and do not move"
            " together: compliance asks whether a planner follows the standard, the"
            " standard deviation of km per stop asks whether they plan the same way"
            " twice, and for a team working to one standard the second is usually"
            " the real complaint - say which one you answered. Name the breached"
            " standard rather than only quoting a compliance score, because a"
            " planner cannot act on a blended percentage. A territory breach is ALSO"
            " recorded when no stop on the route could be geocoded, so check the"
            " geocoded stop count before calling it a planning failure. Planner"
            " attribution and plan release time are both derived, not recorded, so"
            " release figures bound lateness rather than measure it. Use"
            " service_date for operational questions, never plan_date: on San"
            " Francisco plan_date sits 40 days earlier, so a recent-window filter on"
            " it returns nothing without erroring. The two sliders OVERRIDE the"
            " stored thresholds, so a compliance number on screen may have been"
            " re-scored against a threshold the user chose - read max_shift and"
            " max_density from the panel before quoting compliance as the official"
            " figure. The optimizer comparison is a LIVE call for ONE route and"
            " exists only for the route selected on screen; it cannot be aggregated"
            " across routes."
        ),
    },
    "layout": {
        "default": {
            "columns": "1fr 1fr",
            "rows": "auto auto $content auto $map",
            "grid": (
                '"kpi kpi"\n'
                '"shift density"\n'
                '"planners routes"\n'
                '"gap gap"\n'
                '"map readiness"'
            ),
        }
    },
    "areas": {},
}

A = VIEW["areas"]

# ---------------------------------------------------------------------------
A["kpi"] = {
    "component": "MetricCards",
    "data": {
        "query": (
            "SELECT COUNT(*) AS routes,"
            f" ROUND(100.0 * DIV0(COUNT_IF({BREACHES} = 0), COUNT(*)), 2) AS compliance_pct,"
            f" COUNT(DISTINCT IFF({BREACHES} > 0, r.PLANNER_ID, NULL)) AS planners_off,"
            " ROUND(DIV0(SUM(r.PLAN_KM), SUM(r.STOPS)), 2) AS km_per_stop"
            " FROM FLEET_APP.PLAN_STANDARDS.VW_ROUTE_PLAN r"
            f" WHERE {REGION}"
        ),
        "params": CTX_SLIDERS,
        "mapping": {
            "metrics": [
                {"column": "routes", "label": "Routes Planned", "format": "number"},
                {
                    "column": "compliance_pct",
                    "label": "Meet Every Standard %",
                    "format": "number_2dp",
                },
                {
                    "column": "planners_off",
                    "label": "Planners Off Standard",
                    "format": "number",
                },
                {
                    "column": "km_per_stop",
                    "label": "Km per Stop (pooled)",
                    "format": "number_2dp",
                },
            ]
        },
    },
}

# ---------------------------------------------------------------------------
# One Slider per area (the component renders a single slider, not a list).
#
# `defaultSource` seeds each slider from the ACTIVE REGION's own configured
# standard, which is load-bearing: the component falls back to `config.min` when
# no default resolves, so a slider with a bare `default` would pin every region to
# one number on first render and quietly re-score the long-haul regions against
# metro bands. Seeding from STANDARDS means the opening screen reproduces the
# stored flags exactly, and any movement is a visible, deliberate override.
A["shift"] = {
    "component": "Slider",
    "config": {
        "label": "Max planned hours per route (override)",
        "min": 4,
        "max": 36,
        "step": 0.5,
        "default": 9,
        "defaultSource": (
            "SELECT MAX_SHIFT_HOURS AS MAX_SHIFT"
            " FROM FLEET_APP.PLAN_STANDARDS.VW_STANDARDS_CONFIG"
            " WHERE REGION = :region LIMIT 1"
        ),
        "info": (
            "The shift cap this page scores against. Seeded from the active"
            " region's configured standard; move it to test a tighter or looser"
            " rule and every compliance figure on the page re-scores."
        ),
    },
    "emits": {"max_shift": ""},
}

A["density"] = {
    "component": "Slider",
    "config": {
        "label": "Max km per stop (override)",
        "min": 1,
        "max": 900,
        "step": 1,
        "default": 8,
        "defaultSource": (
            "SELECT MAX_KM_PER_STOP AS MAX_DENSITY"
            " FROM FLEET_APP.PLAN_STANDARDS.VW_STANDARDS_CONFIG"
            " WHERE REGION = :region LIMIT 1"
        ),
        "info": (
            "The drop-density ceiling this page scores against. Seeded from the"
            " active region's configured standard. Metro rounds sit near 4 km per"
            " stop; line-haul is hundreds, which is why the range is wide."
        ),
    },
    "emits": {"max_density": ""},
}

# ---------------------------------------------------------------------------
# The league table. compliant_pct and inconsistency sit side by side ON PURPOSE:
# they are the two different questions, and a planner scoring well on one and
# badly on the other is the finding this panel exists to produce.
#
# km_per_stop is a RATIO OF SUMS, matching km_per_stop_pooled in the semantic
# view. The mean of per-route ratios is a different statistic, and mixing the two
# once reported the regional BEST planner as 60 km worse than a benchmark that was
# their own performance.
A["planners"] = {
    "component": "ClickableTable",
    "title": "Planner league table",
    "subtitle": (
        "Click a planner to see their routes. Compliance and consistency are"
        " different questions: inconsistency is the spread of km per stop."
    ),
    "data": {
        "query": (
            "SELECT r.PLANNER_LABEL AS planner,"
            " COUNT(*) AS routes,"
            f" ROUND(100.0 * DIV0(COUNT_IF({BREACHES} = 0), COUNT(*)), 2) AS compliant_pct,"
            " ROUND(STDDEV(r.KM_PER_STOP), 2) AS inconsistency,"
            " ROUND(DIV0(SUM(r.PLAN_KM), SUM(r.STOPS)), 2) AS km_per_stop,"
            f" COUNT_IF({SHIFT_BREACH}) AS over_shift,"
            " ANY_VALUE(r.PLANNER_ID) AS planner_id"
            " FROM FLEET_APP.PLAN_STANDARDS.VW_ROUTE_PLAN r"
            f" WHERE {REGION}"
            " GROUP BY r.PLANNER_LABEL"
            " ORDER BY inconsistency DESC NULLS LAST"
        ),
        "params": CTX_SLIDERS,
    },
    "config": {
        "rowKey": "planner",
        "showFreshness": True,
        "columns": [
            {"field": "planner", "header": "Planner"},
            {"field": "routes", "header": "Routes"},
            {"field": "compliant_pct", "header": "Compliant %"},
            {"field": "inconsistency", "header": "Inconsistency (SD km/stop)"},
            {"field": "km_per_stop", "header": "Km per Stop"},
            {"field": "over_shift", "header": "Over Shift"},
        ],
        "emptyMessage": (
            "No planned routes for this region. Multi-stop route planning data"
            " exists for dense urban regions; the long-haul regions carry"
            " single-leg line-haul plans."
        ),
    },
    "emits": {"selected_planner": "planner_id"},
}

# ---------------------------------------------------------------------------
# Routes for the selected planner.
#
# depot_json / stops_json are emitted so the `gap` area can call the optimizer
# WITHOUT reading a contract view in the same statement. That is a hard boundary,
# not a preference: a statement that calls an ORS service function and also reads
# the scoped FLEET_APP contract views fails with `Insufficient privileges to
# operate on view F_DIM_POIS_SCOPED` - measured under ACCOUNTADMIN and under the
# app's own FLEET_APP_DYNAMIC_READER role, so no grant fixes it.
#
# `config.columns` is an explicit allowlist, so the carrier columns ride on the
# row for the emit without ever rendering.
A["routes"] = {
    "component": "ClickableTable",
    "title": "Routes",
    "subtitle": "Click a route to map its stops and price it against the optimizer.",
    "data": {
        "query": (
            "SELECT r.VEHICLE_ID AS vehicle,"
            " r.SERVICE_DATE AS service_date,"
            " r.STOPS AS stops,"
            " ROUND(r.PLAN_HOURS, 2) AS plan_hours,"
            " ROUND(r.KM_PER_STOP, 2) AS km_per_stop,"
            f" {BREACHES} AS breaches,"
            " NULLIF(TRIM(CONCAT_WS(', ',"
            f" IFF({SHIFT_BREACH}, 'over shift', ''),"
            f" IFF({DENSITY_BREACH}, 'low density', ''),"
            " IFF(r.IS_STOP_BAND_BREACH, 'stop band', ''),"
            " IFF(r.IS_TERRITORY_BREACH, 'territory', ''),"
            " IFF(r.IS_SEQUENCE_BREACH, 'stop order', ''))), '') AS broke,"
            " r.ROUTE_ID AS route_id,"
            " r.VEHICLE_ID AS route_vehicle,"
            " TO_VARCHAR(r.PLAN_DATE, 'YYYY-MM-DD') AS route_plan_date,"
            " r.REGION AS route_region,"
            " r.STOPS AS route_stop_count,"
            " TO_VARCHAR(ARRAY_CONSTRUCT(r.DEPOT_LNG, r.DEPOT_LAT)) AS depot_json,"
            " TO_VARCHAR(s.STOPS_JSON) AS stops_json"
            " FROM FLEET_APP.PLAN_STANDARDS.VW_ROUTE_PLAN r"
            " LEFT JOIN (SELECT ROUTE_ID,"
            " ARRAY_AGG(ARRAY_CONSTRUCT(STOP_LNG, STOP_LAT))"
            " WITHIN GROUP (ORDER BY STOP_SEQ) AS STOPS_JSON"
            " FROM FLEET_APP.PLAN_STANDARDS.VW_ROUTE_STOPS"
            " WHERE SITE_GEOG IS NOT NULL GROUP BY ROUTE_ID) s"
            " ON s.ROUTE_ID = r.ROUTE_ID"
            f" WHERE {REGION}"
            " AND (:selected_planner IS NULL OR r.PLANNER_ID = :selected_planner)"
            " ORDER BY breaches DESC, r.KM_PER_STOP DESC NULLS LAST LIMIT 200"
        ),
        "params": {
            "region": "context.region",
            "max_shift": "viewState.max_shift",
            "max_density": "viewState.max_density",
            "selected_planner": "viewState.selected_planner",
        },
    },
    "config": {
        "rowKey": "route_id",
        "autoSelect": "first",
        "columns": [
            {"field": "vehicle", "header": "Vehicle"},
            {"field": "service_date", "header": "Service Date"},
            {"field": "stops", "header": "Stops"},
            {"field": "plan_hours", "header": "Planned Hours"},
            {"field": "km_per_stop", "header": "Km per Stop"},
            {"field": "breaches", "header": "Breaches"},
            {"field": "broke", "header": "Standards Broken"},
        ],
        "emptyMessage": "No routes for this planner in the current region.",
    },
    "emits": {
        "selected_route": "selection",
        "selected_route_vehicle": "route_vehicle",
        "selected_route_date": "route_plan_date",
        "selected_route_region": "route_region",
        "selected_route_stop_count": "route_stop_count",
        "selected_route_depot": "depot_json",
        "selected_route_stops": "stops_json",
    },
}

# ---------------------------------------------------------------------------
# The live optimizer comparison. Reads NO contract view - only the function, with
# every argument bound from viewState. See the note on A["routes"] for why that is
# mandatory rather than tidy.
A["gap"] = {
    "component": "MetricCards",
    "title": "Live optimizer comparison for the selected route",
    "subtitle": (
        "The same stops re-sequenced by the optimizer on the real road graph."
        " BOTH figures are road distances from the routing engine, so they are"
        " directly comparable - the planned figure is re-priced here rather than"
        " taken from the source system."
    ),
    "data": {
        # Every bind arrives as a STRING: viewState carries emitted row values as
        # text, and the runtime binds them untyped. Both coercions below are
        # MEASURED requirements, not defensive habit:
        #   TRY_TO_NUMBER on the stop count - binding it raw offered VARCHAR(2)
        #   where the function declares NUMBER, and Snowflake rejected the call
        #   outright with `Invalid argument types for function
        #   F_ROUTE_RESOLVE_GAP: (..., VARCHAR(2))` rather than coercing.
        #   CAST(... AS VARCHAR) inside TRY_PARSE_JSON - on FIRST RENDER every
        #   bind is a bare NULL with no type, so TRY_PARSE_JSON(NULL)::ARRAY
        #   failed to compile with `TRY_CAST cannot be used with arguments of
        #   types`. The `WHERE ... IS NOT NULL` guard does NOT save this: the
        #   function call is type-checked at compile time whether or not the
        #   predicate can ever be true.
        "query": (
            "SELECT ROUND(g.PLANNED_ROAD_KM, 2) AS planned_km,"
            " ROUND(g.OPTIMIZED_ROAD_KM, 2) AS optimized_km,"
            " ROUND(g.EXCESS_KM, 2) AS excess_km,"
            " ROUND(g.EXCESS_COST_USD, 2) AS excess_cost"
            " FROM TABLE(FLEET_APP.PLAN_STANDARDS.F_ROUTE_RESOLVE_GAP("
            " CAST(:route_region AS VARCHAR), CAST(:route_vehicle AS VARCHAR),"
            " TRY_TO_DATE(CAST(:route_date AS VARCHAR)),"
            " TRY_PARSE_JSON(CAST(:route_depot AS VARCHAR))::ARRAY,"
            " TRY_PARSE_JSON(CAST(:route_stops AS VARCHAR))::ARRAY,"
            " TRY_TO_NUMBER(CAST(:route_stop_count AS VARCHAR)))) g"
            " WHERE :route_stops IS NOT NULL"
        ),
        "params": {
            "route_region": "viewState.selected_route_region",
            "route_vehicle": "viewState.selected_route_vehicle",
            "route_date": "viewState.selected_route_date",
            "route_depot": "viewState.selected_route_depot",
            "route_stops": "viewState.selected_route_stops",
            "route_stop_count": "viewState.selected_route_stop_count",
        },
        "mapping": {
            "metrics": [
                {
                    "column": "planned_km",
                    "label": "Planned (road km)",
                    "format": "number_2dp",
                },
                {
                    "column": "optimized_km",
                    "label": "Optimizer (road km)",
                    "format": "number_2dp",
                },
                {"column": "excess_km", "label": "Excess km", "format": "number_2dp"},
                {
                    "column": "excess_cost",
                    "label": "Excess Cost USD",
                    "format": "number_2dp",
                },
            ]
        },
    },
    "config": {
        "emptyMessage": (
            "Select a route with geocoded stops to re-solve it live. This calls"
            " the optimizer and the routing engine for one route, so it needs the"
            " active region's routing service running."
        )
    },
}

# ---------------------------------------------------------------------------
# Stops of the selected route plus its depot.
#
# No route LINE is drawn, deliberately. The only road geometry available here
# comes from the optimizer call, and joining the stops with straight lines would
# draw a path no vehicle takes while looking authoritative - the stop ORDER is in
# the tooltip instead.
A["map"] = {
    "component": "Map",
    "title": "Stops on the selected route",
    "config": {
        "noPad": True,
        "emptyMessage": (
            "Select a route with geocoded stops. About 86 percent of stops"
            " resolve to a site geometry, so a route can legitimately have fewer"
            " points here than its stop count."
        ),
        "clickEmits": {"object": "selected_site", "objectColumn": "name"},
        "legend": [
            {"label": "Depot", "color": [41, 181, 232, 230]},
            {"label": "Planned stop", "color": [255, 160, 0, 200]},
        ],
        "layers": [
            {
                "type": "scatterplot",
                "id": "plan-standards-stops",
                "lng": "lng",
                "lat": "lat",
                "fillColor": [255, 160, 0, 200],
                "radius": 90,
                "radiusMinPixels": 4,
                "radiusMaxPixels": 10,
                "pickable": True,
                "tooltip": "<b>{name}</b><br/>Stop {seq}<br/>{leg_km} km on this leg",
                "data": {
                    "query": (
                        "SELECT SITE_LABEL AS name, STOP_LNG AS lng, STOP_LAT AS lat,"
                        " STOP_SEQ AS seq, ROUND(LEG_KM, 2) AS leg_km"
                        " FROM FLEET_APP.PLAN_STANDARDS.VW_ROUTE_STOPS"
                        " WHERE SITE_GEOG IS NOT NULL"
                        " AND :route_id IS NOT NULL AND ROUTE_ID = :route_id"
                        " ORDER BY STOP_SEQ LIMIT 500"
                    ),
                    "params": {"route_id": "viewState.selected_route"},
                },
            },
            {
                "type": "scatterplot",
                "id": "plan-standards-depot",
                "lng": "lng",
                "lat": "lat",
                "fillColor": [41, 181, 232, 230],
                "radius": 200,
                "radiusMinPixels": 7,
                "radiusMaxPixels": 16,
                "stroked": True,
                "lineColor": [255, 255, 255, 255],
                "lineWidthMinPixels": 2,
                "pickable": True,
                "tooltip": "<b>{name}</b><br/>Depot",
                "data": {
                    "query": (
                        "SELECT COALESCE(DEPOT_NAME, 'Depot') AS name,"
                        " DEPOT_LNG AS lng, DEPOT_LAT AS lat"
                        " FROM FLEET_APP.PLAN_STANDARDS.VW_ROUTE_PLAN"
                        " WHERE DEPOT_LNG IS NOT NULL"
                        " AND :route_id IS NOT NULL AND ROUTE_ID = :route_id"
                    ),
                    "params": {"route_id": "viewState.selected_route"},
                },
            },
        ],
    },
}

# ---------------------------------------------------------------------------
# Warehouse readiness. The bar is the SIGNED delta between the session start and
# the LAST plan release for the depot, because the warehouse cannot start until
# the last plan lands - averaging the releases would make a depot held up by one
# late plan look ready.
A["readiness"] = {
    "component": "Chart",
    "data": {
        "query": (
            "SELECT SUBSTR(r.DEPOT_NAME, 1, 22) AS depot,"
            " ROUND(AVG(r.BUILD_START_DELAY_MIN), 2) AS delay_min"
            " FROM FLEET_APP.PLAN_STANDARDS.VW_WAREHOUSE_READINESS r"
            f" WHERE {REGION}"
            " GROUP BY SUBSTR(r.DEPOT_NAME, 1, 22)"
            " ORDER BY delay_min DESC NULLS LAST LIMIT 15"
        ),
        "params": CTX,
    },
    "config": {
        "title": "Minutes the warehouse waits for the last plan (negative is early)",
        "xAxis": {"field": "depot", "fieldType": "category"},
        "series": [
            {"type": "bar", "field": "delay_min", "label": "Minutes after session start"}
        ],
    },
}


def main() -> int:
    raw = APP.read_text(encoding="utf-8")

    block = json.dumps({KEY: VIEW}, indent=2)
    # Strip the wrapper braces and re-indent to sit inside the top-level object.
    inner = block.split("\n")[1:-1]
    body = "\n".join(inner)

    if f'"{KEY}"' in raw:
        # Replace in place: from the key line to the line before the next
        # top-level key (2-space indent + quote) or the closing brace.
        pat = re.compile(
            r'\n  "' + KEY + r'": \{.*?\n  \}(?=,\n  "|\n\})', re.DOTALL
        )
        # The replacement MUST go through a lambda. `body` is serialized JSON and
        # contains the two-character escape \n inside the `grid` string literal;
        # passing it as a plain replacement makes re interpret that as a real
        # newline, which breaks the string and produced
        # `Invalid control character at: line 6783`. The parse check below is what
        # caught it before anything was written.
        new, n = pat.subn(lambda _m: "\n" + body, raw)
        if n != 1:
            print(f"ERROR: expected 1 existing block, matched {n}", file=sys.stderr)
            return 1
        raw = new
    else:
        # Splice before the final closing brace, leaving every other byte alone.
        idx = raw.rstrip().rfind("}")
        if idx < 0:
            print("ERROR: no closing brace found", file=sys.stderr)
            return 1
        head = raw[:idx].rstrip()
        if not head.endswith("}"):
            print(f"ERROR: unexpected tail {head[-40:]!r}", file=sys.stderr)
            return 1
        raw = head + ",\n" + body + "\n}\n"

    # Parse before writing. A malformed splice must fail here, not in the browser.
    doc = json.loads(raw)
    assert KEY in doc, "spliced key did not survive the parse"
    APP.write_text(raw, encoding="utf-8")
    print(f"OK: app-views.json holds {len(doc)} views, {len(raw.splitlines())} lines")
    return 0


if __name__ == "__main__":
    sys.exit(main())
