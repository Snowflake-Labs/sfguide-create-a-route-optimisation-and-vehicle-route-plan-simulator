#!/usr/bin/env python3
"""Insert (or replace) the delivery_sync view in the FLEET_SA_APP view registry.

app-views.json is hand-formatted in places (compact inline arrays), so a full
json.dumps round-trip would reflow ~2.5k unrelated lines. This script therefore
does a TARGETED TEXTUAL splice: it brace-matches the top-level `dwell_sla` block
and inserts the new view immediately after it, leaving every other byte alone.
Idempotent - an existing delivery_sync block is removed first.
"""
import json
import pathlib
import sys

APP = pathlib.Path(__file__).resolve().parents[1] / "fleet_sa_app" / "app" / "app-views.json"

# Shared SQL fragments -------------------------------------------------------
# Service date. This page is a SINGLE-DAY replay (readiness and both live ORS
# calls are evaluated at one instant), but the app's global context supplies a
# date RANGE, not a date. So we resolve the range to the busiest day inside it.
#
# Do NOT go back to `SERVICE_DATE = :date_range_start`. The context bar default
# is `last_365_days` (app-config.json), which app-shell.tsx turns into
# date_range_start = today-365, so an equality match asks for a day a year ago
# and every area returns nothing - which is exactly how this view shipped empty.
#
# The second COALESCE arm falls back to the region's busiest day when the user's
# range contains no visits at all, so the page degrades to "showing another day"
# rather than to blank cards. The resolved date is published as a KPI card so
# that fallback is visible rather than silent.
SD = ("COALESCE("
      "(SELECT SERVICE_DATE FROM FLEET_APP.DELIVERY_SYNC.VW_SITE_VISITS "
      "WHERE REGION = :region "
      "AND (:date_range_start IS NULL OR SERVICE_DATE >= :date_range_start::DATE) "
      "AND (:date_range_end IS NULL OR SERVICE_DATE <= :date_range_end::DATE) "
      "GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1), "
      "(SELECT SERVICE_DATE FROM FLEET_APP.DELIVERY_SYNC.VW_SITE_VISITS "
      "WHERE REGION = :region GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1))")
# As-of instant: the replay clock. Readiness and both live ORS calls are all
# evaluated at this instant so the whole page tells one consistent story.
# As-of instant: the replay clock. Readiness and both live ORS calls are all
# evaluated at this instant so the whole page tells one consistent story.
#
# The clock steps in 10-MINUTE increments, so the bind carries MINUTES SINCE
# MIDNIGHT (not an hour). 10 minutes is not arbitrary: a sampling grid of step S
# only guarantees landing inside a visit lasting at least S, and the median
# delivery dwell is 12.3 min. 10 min is therefore the coarsest step below the
# median, so the typical delivery is always visible as IN_PROGRESS. Measured on
# the reference day, coverage of visits ever seen on-site: 34% hourly, 72% at
# 15 min, 87% at 10 min, 96% at 5 min (5 min doubles the slider for 8 points).
ASOF = "DATEADD('minute', COALESCE(:as_of_minute, 540), " + SD + "::TIMESTAMP_NTZ)"
# Active ORS profile for the region (driving-hgv / driving-car / cycling-electric).
PROFILE = ("(SELECT ORS_PROFILE FROM FLEET_APP.DELIVERY_SYNC.VW_ACTIVE_SCOPE "
           "WHERE REGION = :region LIMIT 1)")
APPROACH = ("(SELECT APPROACH_SECONDS FROM FLEET_APP.DELIVERY_SYNC.VW_ACTIVE_SCOPE "
            "WHERE REGION = :region LIMIT 1)")
# Focus site: the clicked site, else the busiest site that day. Guarantees the
# live ring and ETA calls never receive a NULL anchor.
SITE = ("COALESCE(:selected_site, (SELECT SITE_ID FROM "
        "FLEET_APP.DELIVERY_SYNC.VW_SITE_VISITS WHERE REGION = :region "
        "AND SERVICE_DATE = " + SD + " GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1))")

CTX = {
    "region": "context.region",
    "vehicle_type": "context.vehicle_type",
    "date_range_start": "context.date_range_start",
    "date_range_end": "context.date_range_end",
}

PALETTE = {
    "READY": [46, 160, 67, 235],
    "IN_PROGRESS": [255, 171, 0, 245],
    "EXPECTED": [145, 158, 171, 200],
}

VIEW = {
    "label": "Delivery Sync",
    "category": "Core",
    "description": (
        "When each vehicle reached its delivery site and when it left, so the "
        "receiving crew travels only once the load is actually on the floor."
    ),
    "info": (
        "Arrival and departure are detected from geofence entry and exit, not from a "
        "status flag: every position ping is tested against the site's own radius "
        "(DIM_VEHICLE_DWELL_SLA.BUFFER_RADIUS_M), consecutive inside-pings are grouped "
        "into a visit, and the arrival/departure pair is taken from the stationary core "
        "of that visit. The approach ring and the inbound ETA are computed live by the "
        "routing engine at the replay instant. "
        "This page shows ONE service day, and the As Of card names the exact instant "
        "being replayed. The day is the busiest delivery day inside the global date "
        "range; if the selected range contains no deliveries at all, it falls back to "
        "the busiest day for the region so the page still shows something, and the As "
        "Of card is what tells you which day and time you are looking at. The replay "
        "clock steps in 10-minute increments, which is finer than the median time on "
        "site, so a typical delivery is visible while the vehicle is still there."
    ),
    "agentKnowledge": {
        "preferredTool": "query_delivery_sync",
        "keyMetrics": [
            "site visits detected for the service date",
            "sites READY (vehicle departed, load on the floor)",
            "sites IN_PROGRESS (vehicle on site at the replay instant)",
            "sites still EXPECTED at the replay instant",
            "average time on site in minutes",
            "minutes out for inbound vehicles",
        ],
        "exampleQuestions": [
            "Which sites are ready for the crew right now?",
            "Has the vehicle left site X yet?",
            "How long did the vehicle spend at site X?",
            "Which vehicles are within 15 minutes of their next site?",
            "Which sites are still waiting on a delivery?",
        ],
        "gotchas": (
            "Readiness is evaluated AT the replay hour, not at wall-clock now, so the "
            "same site reads EXPECTED earlier in the day and READY later. A visit is "
            "only counted once the vehicle was genuinely stationary inside the geofence "
            "for at least MIN_STOP_SECONDS, so a vehicle that merely drove past a site "
            "produces no event. The approach ring is computed outward FROM the site so "
            "it only approximates drive time toward it; the quoted minutes-out always "
            "comes from the live matrix call instead. SOURCE_STATUS_HINT separates "
            "deliveries from pickups and idles but is descriptive only and plays no "
            "part in detection."
        ),
    },
    "layout": {
        "default": {
            "columns": "1fr 1fr",
            "rows": "auto auto $heroMap $content $content",
            "grid": (
                '"delivery_sync delivery_sync"\n'
                '"filter clock"\n'
                '"map map"\n'
                '"feed readiness"\n'
                '"inbound inbound"'
            ),
        }
    },
    "areas": {
        # Named delivery_sync on purpose: MetricCards publishes its values to
        # viewState as __memo_<areaName>, so this yields __memo_delivery_sync
        # for the chat agent (Tenet 10, Channel A).
        "delivery_sync": {
            "component": "MetricCards",
            "data": {
                # COUNT_IF over an EMPTY set returns NULL in Snowflake, not 0, so
                # without COALESCE an out-of-scope date renders four dashes and a
                # data-scoping problem is indistinguishable from a broken view.
                # A genuine zero must read "0"; only avg_dwell is legitimately
                # dash-able, since no average exists over no rows.
                "query": (
                    "SELECT COALESCE(COUNT(*), 0) AS visits, "
                    "COALESCE(COUNT_IF(READINESS_ENUM='READY'), 0) AS ready, "
                    "COALESCE(COUNT_IF(READINESS_ENUM='IN_PROGRESS'), 0) AS on_site, "
                    "COALESCE(COUNT_IF(READINESS_ENUM='EXPECTED'), 0) AS expected, "
                    "ROUND(AVG(DWELL_MINUTES),1) AS avg_dwell, "
                    "TO_VARCHAR(" + ASOF + ", 'DD Mon HH24:MI') AS as_of "
                    "FROM TABLE(FLEET_APP.DELIVERY_SYNC.F_SITE_READINESS_ASOF(:region, "
                    + ASOF + ")) WHERE SERVICE_DATE = " + SD
                ),
                "params": dict(CTX),
                "mapping": {
                    "metrics": [
                        {"column": "ready", "label": "Sites Ready", "format": "number"},
                        {"column": "on_site", "label": "Vehicle On Site", "format": "number"},
                        {"column": "expected", "label": "Still Expected", "format": "number"},
                        {"column": "avg_dwell", "label": "Avg Min On Site", "format": "number_2dp"},
                        # The exact replay instant, so the numbers are attributable
                        # to a moment and the SD range fallback is never silent.
                        {"column": "as_of", "label": "As Of", "format": "text"},
                    ]
                },
            },
        },
        "filter": {
            "component": "FilterBar",
            "filters": [
                {
                    "name": "site",
                    "label": "Focus site",
                    "data": {
                        "query": (
                            "SELECT SITE_ID AS value, SITE_NAME AS label FROM "
                            "FLEET_APP.DELIVERY_SYNC.VW_SITE_VISITS WHERE REGION = :region "
                            "AND SERVICE_DATE = " + SD + " AND SITE_NAME IS NOT NULL "
                            "GROUP BY 1,2 ORDER BY 2 LIMIT 300"
                        ),
                        "params": dict(CTX),
                    },
                    "emits": {"selected_site": "selection"},
                }
            ],
        },
        "clock": {
            "component": "Slider",
            "config": {
                "label": "Replay time",
                # Minutes since midnight. 1430 is 23:50, the last clean 10-minute
                # mark; 540 is 09:00. 144 positions at 400 ms sweeps a full day in
                # about a minute.
                "min": 0,
                "max": 1430,
                "step": 10,
                "default": 540,
                "format": "time_of_day",
                "play": True,
                "playIntervalMs": 400,
                "info": (
                    "Scrubs the service day in 10-minute steps. Everything on the page "
                    "is evaluated at this instant: site readiness, the notification feed "
                    "cutoff, and the live approach ring and inbound ETA. 10 minutes is "
                    "finer than the median time on site (about 12 minutes), so a typical "
                    "delivery is always caught while the vehicle is still there; an "
                    "hourly step misses roughly two thirds of them."
                ),
            },
            "emits": {"as_of_minute": ""},
        },
        "map": {
            "component": "Map",
            "config": {
                "noPad": True,
                "clickEmits": {
                    "object": "selected_site",
                    "objectColumn": "site_id",
                    "lng": "lng",
                    "lat": "lat",
                },
                "toggles": [
                    {"key": "show_ring", "label": "Approach ring", "default": True},
                    {"key": "show_inbound", "label": "Inbound vehicles", "default": True},
                ],
                "legend": [
                    {"label": "Ready for crew", "color": PALETTE["READY"]},
                    {"label": "Vehicle on site", "color": PALETTE["IN_PROGRESS"]},
                    {"label": "Still expected", "color": PALETTE["EXPECTED"]},
                    {"label": "Inbound vehicle", "color": [41, 181, 232, 240]},
                    {"label": "Approach ring", "color": [41, 181, 232, 200], "shape": "line"},
                ],
                "layers": [
                    {
                        "type": "geojson",
                        "id": "approach-ring",
                        "geojsonColumn": "geo",
                        "visibleWhen": "show_ring",
                        "noFit": True,
                        "fillColor": [41, 181, 232, 30],
                        "lineColor": [41, 181, 232, 220],
                        "lineWidth": 2,
                        "pickable": True,
                        "tooltip": "<b>{site_name}</b><br/>Within {minutes} min drive",
                        "data": {
                            "query": (
                                "SELECT ST_ASGEOJSON(RING_GEOG)::STRING AS geo, "
                                "SITE_NAME AS site_name, "
                                "ROUND(RANGE_SECONDS/60.0) AS minutes "
                                "FROM TABLE(FLEET_APP.DELIVERY_SYNC.LIVE_APPROACH_RING("
                                ":region, " + PROFILE + ", " + SITE + ", " + APPROACH + "))"
                            ),
                            "params": dict(CTX),
                        },
                    },
                    {
                        "type": "scatterplot",
                        "id": "sites",
                        "lng": "lng",
                        "lat": "lat",
                        "radius": 90,
                        "radiusMinPixels": 5,
                        "radiusMaxPixels": 16,
                        "pickable": True,
                        "fillColor": {
                            "base": [145, 158, 171, 200],
                            "active": [17, 86, 127, 255],
                            "matchColumn": "site_id",
                            "whenViewStateEquals": "selected_site",
                            "baseColumn": "readiness",
                            "basePalette": PALETTE,
                        },
                        "tooltip": (
                            "<b>{site_name}</b><br/>{readiness}<br/>Vehicle {vehicle_id}"
                            "<br/>On site {dwell_min} min<br/>Load ready {ready_at}"
                        ),
                        "data": {
                            "query": (
                                "SELECT SITE_ID AS site_id, SITE_NAME AS site_name, "
                                "READINESS_ENUM AS readiness, ST_X(SITE_GEOG) AS lng, "
                                "ST_Y(SITE_GEOG) AS lat, VEHICLE_ID AS vehicle_id, "
                                "DWELL_MINUTES AS dwell_min, "
                                "IFF(READINESS_ENUM='READY', "
                                "TO_VARCHAR(PRODUCT_READY_TS,'HH24:MI'), '-') AS ready_at "
                                "FROM TABLE(FLEET_APP.DELIVERY_SYNC.F_SITE_READINESS_ASOF(:region, "
                                + ASOF + ")) WHERE SERVICE_DATE = " + SD
                                + " AND SITE_GEOG IS NOT NULL"
                            ),
                            "params": dict(CTX),
                        },
                    },
                    {
                        "type": "scatterplot",
                        "id": "inbound",
                        "lng": "lng",
                        "lat": "lat",
                        "visibleWhen": "show_inbound",
                        "noFit": True,
                        "stroked": True,
                        "lineColor": [255, 255, 255, 230],
                        "lineWidthMinPixels": 1,
                        "fillColor": [41, 181, 232, 240],
                        "radius": 70,
                        "radiusMinPixels": 4,
                        "radiusMaxPixels": 12,
                        "pickable": True,
                        "tooltip": (
                            "<b>{vehicle_id}</b><br/>{minutes_out} min from {site_name}"
                            "<br/>{distance_km} km by road<br/>ETA {eta}"
                        ),
                        "data": {
                            "query": (
                                "SELECT VEHICLE_ID AS vehicle_id, SITE_NAME AS site_name, "
                                "MINUTES_OUT AS minutes_out, DISTANCE_KM AS distance_km, "
                                "TO_VARCHAR(ETA_TS,'HH24:MI') AS eta, "
                                "ST_X(VEHICLE_GEOG) AS lng, ST_Y(VEHICLE_GEOG) AS lat "
                                "FROM TABLE(FLEET_APP.DELIVERY_SYNC.LIVE_INBOUND_ETA("
                                ":region, " + PROFILE + ", " + SITE + ", " + ASOF + ", 20)) "
                                "WHERE MINUTES_OUT IS NOT NULL "
                                "ORDER BY MINUTES_OUT LIMIT 25"
                            ),
                            "params": dict(CTX),
                        },
                    },
                ],
            },
        },
        "feed": {
            "component": "Table",
            "data": {
                "query": (
                    "SELECT TO_VARCHAR(EVENT_TS,'HH24:MI:SS') AS \"At\", "
                    "EVENT_TYPE AS \"Event\", SITE_NAME AS \"Site\", "
                    "VEHICLE_ID AS \"Vehicle\", DWELL_MINUTES AS \"On site (min)\" "
                    "FROM FLEET_APP.DELIVERY_SYNC.VW_EVENTS "
                    "WHERE REGION = :region AND SERVICE_DATE = " + SD
                    + " AND EVENT_TS <= " + ASOF + " ORDER BY EVENT_TS DESC LIMIT 200"
                ),
                "params": dict(CTX),
            },
            "config": {"title": "Notification feed", "fitRows": 6},
        },
        "readiness": {
            "component": "ClickableTable",
            "data": {
                "query": (
                    "SELECT SITE_ID AS site_id, SITE_NAME AS \"Site\", "
                    "READINESS_ENUM AS \"State\", VEHICLE_ID AS \"Vehicle\", "
                    "TO_VARCHAR(ARRIVAL_TS,'HH24:MI') AS \"Arrived\", "
                    "IFF(READINESS_ENUM='READY', TO_VARCHAR(DEPARTURE_TS,'HH24:MI'), '-') "
                    "AS \"Departed\", DWELL_MINUTES AS \"On site (min)\" "
                    "FROM TABLE(FLEET_APP.DELIVERY_SYNC.F_SITE_READINESS_ASOF(:region, "
                    + ASOF + ")) WHERE SERVICE_DATE = " + SD
                    + " ORDER BY CASE READINESS_ENUM WHEN 'IN_PROGRESS' THEN 0 "
                      "WHEN 'READY' THEN 1 ELSE 2 END, ARRIVAL_TS DESC LIMIT 300"
                ),
                "params": dict(CTX),
            },
            "config": {"title": "Site readiness", "fitRows": 6, "idColumn": "site_id"},
            "emits": {"selected_site": "selection"},
        },
        "inbound": {
            "component": "Table",
            "data": {
                "query": (
                    "SELECT VEHICLE_ID AS \"Vehicle\", MINUTES_OUT AS \"Minutes out\", "
                    "DISTANCE_KM AS \"Road km\", TO_VARCHAR(ETA_TS,'HH24:MI') AS \"ETA\", "
                    "TO_VARCHAR(POSITION_TS,'HH24:MI') AS \"Position as of\" "
                    "FROM TABLE(FLEET_APP.DELIVERY_SYNC.LIVE_INBOUND_ETA("
                    ":region, " + PROFILE + ", " + SITE + ", " + ASOF + ", 20)) "
                    "WHERE MINUTES_OUT IS NOT NULL ORDER BY MINUTES_OUT LIMIT 25"
                ),
                "params": dict(CTX),
            },
            "config": {"title": "Inbound to focus site (live routing)", "fitRows": 6},
        },
    },
}


def block_span(text: str, key: str):
    """Return (start, end) char offsets of a top-level `"key": { ... }` block,
    end being just past the closing brace. Brace counting is string-aware."""
    marker = '\n  "%s": {' % key
    i = text.find(marker)
    if i < 0:
        return None
    brace = text.index('{', i + len(marker) - 1)
    depth, j, in_str, esc = 0, brace, False, False
    while j < len(text):
        c = text[j]
        if in_str:
            if esc:
                esc = False
            elif c == '\\':
                esc = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return (i + 1, j + 1)
        j += 1
    raise ValueError('unbalanced braces scanning %s' % key)


# viewState binds this view can emit. The renderer only supplies a bind if the
# area declares it in data.params, so any query referencing one of these without
# the matching entry fails at runtime with
# "Bind variable :<name> not set" - which is exactly what shipped the first time.
# Deriving the bindings from the SQL removes the chance of missing one.
VIEWSTATE_BINDS = ("as_of_minute", "selected_site")


def bind_viewstate_params(node) -> int:
    """Walk the view tree and, for every data.query, add the viewState params
    that query actually references. Returns the number of bindings added."""
    added = 0
    if isinstance(node, dict):
        data = node.get("data")
        if isinstance(data, dict) and isinstance(data.get("query"), str):
            q = data["query"]
            params = data.setdefault("params", {})
            for name in VIEWSTATE_BINDS:
                if (":" + name) in q and name not in params:
                    params[name] = "viewState." + name
                    added += 1
        for val in node.values():
            added += bind_viewstate_params(val)
    elif isinstance(node, list):
        for val in node:
            added += bind_viewstate_params(val)
    return added


def main() -> int:
    text = APP.read_text()

    n = bind_viewstate_params(VIEW)
    print("viewState bindings injected: %d" % n)

    # Remove any prior delivery_sync block (idempotency), including its comma.
    prior = block_span(text, 'delivery_sync')
    if prior:
        s, e = prior
        tail = text[e:]
        if tail.startswith(','):
            e += 1
        # also swallow the newline + indent that preceded the block
        text = text[:s].rstrip('\n ') + '\n' + text[e:].lstrip('\n')
        # normalise: ensure the previous line still ends with a comma
        text = text.replace('},\n  "', '},\n  "')  # no-op guard, keeps intent explicit

    span = block_span(text, 'dwell_sla')
    if not span:
        print('ERROR: could not locate the dwell_sla block', file=sys.stderr)
        return 1
    _, end = span

    body = json.dumps(VIEW, indent=2, ensure_ascii=False)
    body = '\n'.join(('  ' + ln) if ln.strip() else ln for ln in body.splitlines())
    snippet = ',\n  "delivery_sync": ' + body.lstrip()

    # dwell_sla is followed by a comma in the registry; splice after the brace
    # and before that comma so we do not disturb it.
    assert text[end] == ',', 'unexpected char after dwell_sla block: %r' % text[end]
    out = text[:end] + snippet + text[end:]

    json.loads(out)  # fail loudly rather than write invalid JSON
    APP.write_text(out)
    print('delivery_sync spliced in; %d views total' % len(json.loads(out)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
