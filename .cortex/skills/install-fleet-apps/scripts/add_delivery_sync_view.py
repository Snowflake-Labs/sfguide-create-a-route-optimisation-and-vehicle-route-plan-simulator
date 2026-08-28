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
# Every "busiest X" pick below is tie-broken explicitly. Without that the ORDER BY
# is non-deterministic and the page silently changes anchor between loads - the
# focus site was observed flipping between two sites for the SAME service day,
# which is what made the single approach ring look like it landed on a random
# site. Ties are real here because visit counts are small integers.
SD = ("COALESCE("
      "(SELECT SERVICE_DATE FROM FLEET_APP.DELIVERY_SYNC.VW_SITE_VISITS "
      "WHERE REGION = :region "
      "AND (:date_range_start IS NULL OR SERVICE_DATE >= :date_range_start::DATE) "
      "AND (:date_range_end IS NULL OR SERVICE_DATE <= :date_range_end::DATE) "
      "GROUP BY 1 ORDER BY COUNT(*) DESC, SERVICE_DATE DESC LIMIT 1), "
      "(SELECT SERVICE_DATE FROM FLEET_APP.DELIVERY_SYNC.VW_SITE_VISITS "
      "WHERE REGION = :region GROUP BY 1 "
      "ORDER BY COUNT(*) DESC, SERVICE_DATE DESC LIMIT 1))")
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
# Focus site: the clicked site, else the busiest site that day (tie-broken by
# SITE_ID so it is stable across loads). Guarantees the live ring and ETA calls
# never receive a NULL anchor. The SAME expression and tie-break is used by
# LIVE_APPROACH_RINGS to exclude this site, so the two can never disagree about
# which site is the focus.
SITE = ("COALESCE(:selected_site, (SELECT SITE_ID FROM "
        "FLEET_APP.DELIVERY_SYNC.VW_SITE_VISITS WHERE REGION = :region "
        "AND SERVICE_DATE = " + SD + " GROUP BY 1 "
        "ORDER BY COUNT(*) DESC, SITE_ID LIMIT 1))")

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

# Map colouring. Grey and blue are split by CLASS, not by state: grey is site
# furniture (the estate and its geofences), Snowflake light blue is vehicles.
# Before this split an en-route grey vehicle and a near-black site marker read as
# almost the same dot. Now the two can never be confused: sites are the only
# HOLLOW markers (transparent fill, grey ring) and vehicles are the only blue
# ones. Within vehicles, colour is reserved for the three ACTIONABLE states, so
# en-route and idle stay flat blue and the eye lands on the few that matter.
# All values are config, so the palette can be retuned without touching code.
SITE_STROKE_GREY = [90, 99, 104, 235]   # the estate: ring only, no fill
GEOFENCE_GREY = [90, 99, 104, 130]      # detection boundary: fainter than the site
TRANSPARENT = [0, 0, 0, 0]              # alpha 0 - see NOTE below
# Snowflake light blue #29B5E8 (app-config.json style.chart.palette[0]).
SNOWFLAKE_BLUE = [41, 181, 232, 240]
VEHICLE_PALETTE = {
    "ON_SITE": [46, 160, 67, 240],       # green  - vehicle is unloading
    "JUST_LEFT": [214, 57, 57, 240],     # red    - load just landed, crew can go
    "APPROACHING": [255, 171, 0, 245],   # yellow - inside the live drive-time band
    "DRIVING": SNOWFLAKE_BLUE,           # blue   - en route, nothing to act on
    "IDLE": SNOWFLAKE_BLUE,              # blue   - no further stops today
}

# NOTE on hollow markers: layer-compiler.ts never passes `filled` to
# ScatterplotLayer, so deck.gl's default filled:true stands and there is no
# config route to a genuinely unfilled circle. An alpha-0 fill is the way to get
# one - it still renders, just invisibly, while stroked + lineColor draw the
# ring. Picking is geometry-based, not colour-based, so tooltips and clickEmits
# keep working on a transparent marker.

# Geofence radii in METRES, from DIM_VEHICLE_DWELL_SLA.BUFFER_RADIUS_M for the
# monitored site types: WAREHOUSE 200, STORE 100, DESTINATION 100. These are the
# actual circles the detector tests every ping against, so drawing them makes the
# arrival/departure logic legible rather than a black box.
#
# Rendered as scatterplots because deck.gl radius is already in METRES, which is
# exact - and unavoidable, since ST_BUFFER rejects GEOGRAPHY (GEOMETRY only) so
# there is no geodesic buffer available in SQL. getRadius is static per layer
# (layer-compiler.ts, no radiusColumn), hence ONE LAYER PER RADIUS. NJ today is
# all WAREHOUSE, so the 100 m layer is empty there - it is emitted anyway so the
# view stays correct on a dataset that includes stores.
GEOFENCE_RADII = (200, 100)

# Approach-ring colours. Snowflake DARK blue #11567F, deliberately not the light
# blue that now belongs to vehicles. The focus site's ring is drawn strongly; the
# other ~117 rings are drawn very faintly, because at 1.5x average overlap an
# alpha that reads well for one ring accumulates into a solid wash for a hundred.
# Two separate layers are required rather than one: buildGeoJsonLayer passes
# getLineColor STATICALLY (only getFillColor supports a per-feature accessor via
# colorColumn/colorMap), so a single layer cannot vary outline strength by row.
RING_FOCUS_FILL = [17, 86, 127, 30]
RING_FOCUS_LINE = [17, 86, 127, 220]
RING_ALL_FILL = [17, 86, 127, 8]
RING_ALL_LINE = [17, 86, 127, 85]

# Approach threshold in MINUTES for LIVE_FLEET_STATUS. APPROACH (above) is the
# same setting in SECONDS for the isochrone ring, which takes seconds; keeping
# both derived from PARAMS.APPROACH_SECONDS means the ring the user sees and the
# yellow "approaching" colour always agree on what "close" means.
APPROACH_MIN = ("(SELECT ROUND(APPROACH_SECONDS/60.0) FROM "
                "FLEET_APP.DELIVERY_SYNC.VW_ACTIVE_SCOPE WHERE REGION = :region LIMIT 1)")

VIEW = {
    "label": "Delivery Sync",
    "category": "Core",
    "description": (
        "When each vehicle reached its delivery site and when it left, so the "
        "receiving crew travels only once the load is actually on the floor."
    ),
    "useCase": {
        # Presenter/agent block: renders the view's "i" overlay (composed to
        # markdown by lib/use-case.ts) and feeds the chat agent's solution
        # catalog. Replaces the former free-text "info" field; the methodology
        # prose that used to live there is now `method` + `caveats`.
        "headline": (
            "Tell the receiving crew exactly when a load is on the floor, so they "
            "travel to site once and at the right time."
        ),
        "businessQuestion": (
            "Has the delivery actually arrived and left, so the crew that receives "
            "or installs it can be sent now rather than sent twice?"
        ),
        "audience": [
            "Site or crew scheduler",
            "Field operations manager",
            "Delivery operations",
            "Customer service",
        ],
        "industries": [
            "Beverage and CPG distribution",
            "Construction and building materials",
            "Retail replenishment",
            "Field installation services",
        ],
        "talkTrack": [
            "Point at the As Of card first - it names the exact service day and the "
            "instant being replayed.",
            "Read the readiness split: sites READY, IN_PROGRESS, and still EXPECTED.",
            "Drag the replay clock forward and watch sites flip to READY as vehicles "
            "depart.",
            "On the map, call out the colour rules: green on site, red just left, "
            "yellow inside the live approach band, blue for a vehicle with nothing "
            "actionable.",
            "Show the inbound table: which vehicles are inside the approach window, "
            "with a live drive-time ETA from the routing engine.",
            "Land the value: one avoided wasted crew trip per site per week is the "
            "whole business case.",
        ],
        "snowflakeCapabilities": [
            "Geofence arrival and departure detected from raw pings with Dynamic "
            "Tables, with no per-site status flag required",
            "Live drive-time ETA and approach band computed by the routing engine "
            "(OpenRouteService on Snowpark Container Services) at the replay "
            "instant, never precomputed",
            "Replayable operational state, so the same demo can be run at any hour "
            "of a real service day",
        ],
        "dataRequired": [
            "Position pings with timestamp",
            "Delivery site master with a detection radius per site",
            "Optional but important in production: the dispatch plan, which is what "
            "supplies genuinely forward-looking expected arrivals",
        ],
        "valueDrivers": [
            "Stop the wasted second trip when a crew arrives before the load does",
            "Shorten the gap between delivery and the revenue-earning work that "
            "follows it",
            "Give the customer a credible arrival window instead of a day-long one",
        ],
        "method": (
            "Arrival and departure are detected from geofence entry and exit, not from a "
            "status flag: every position ping is tested against the site's own radius "
            "(DIM_VEHICLE_DWELL_SLA.BUFFER_RADIUS_M), consecutive inside-pings are grouped "
            "into a visit, and the arrival/departure pair is taken from the stationary core "
            "of that visit. Every site's 15-minute approach ring, and the inbound ETA, are "
            "computed live by the "
            "routing engine at the replay instant. The rings are drive-time, not radius, "
            "so they follow the road network; they are only distinguishable when you zoom "
            "in, which is why the focus site's ring is drawn more strongly. "
            "This page shows ONE service day, and the As Of card names the exact instant "
            "being replayed. The day is the busiest delivery day inside the global date "
            "range; if the selected range contains no deliveries at all, it falls back to "
            "the busiest day for the region so the page still shows something, and the As "
            "Of card is what tells you which day and time you are looking at. The replay "
            "clock steps in 10-minute increments, which is finer than the median time on "
            "site, so a typical delivery is visible while the vehicle is still there. "
            "On the map, hollow grey rings are the delivery sites and the smaller solid "
            "dots are vehicles, coloured only when their state is actionable: green on "
            "site, red just left, yellow inside the live drive-time approach band. En "
            "route and idle vehicles stay Snowflake blue so the eye lands on the few "
            "that matter. Grey is only ever site furniture and blue is only ever a "
            "vehicle, so the two classes cannot be confused. An optional Site geofence "
            "layer (off by default) draws each site's true 100-200 m detection radius; "
            "it is only legible zoomed in, because that is how big those circles "
            "really are. "
        ),
        "caveats": (
            "A site reading EXPECTED is hindsight, not a forecast: the visit is in "
            "the data because it was detected later the same day. In production that "
            "state would come from the dispatch plan. READY and IN_PROGRESS are "
            "direct detections. The telemetry itself is synthetic."
        ),
    },
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
            "same site reads EXPECTED earlier in the day and READY later. IMPORTANT: "
            "EXPECTED is NOT a forecast. A visit only exists because it was detected "
            "from telemetry, so at an early replay instant a later visit reads EXPECTED "
            "purely because the rest of the day is already in the data - it is hindsight. "
            "In production that state would come from the dispatch plan instead. READY "
            "and IN_PROGRESS are direct detections and carry no such caveat. "
            "On the map, sites are hollow grey rings and do NOT encode readiness; "
            "readiness lives in the KPI cards, the readiness table and the site tooltip. "
            "Vehicle colour carries the actionable state, and only three states are "
            "coloured (on site, just left, approaching) - en route and idle are both "
            "Snowflake blue on purpose. APPROACHING is a LIVE ROAD-TIME threshold from "
            "the routing engine, not a straight-line radius. A visit is "
            "only counted once the vehicle was genuinely stationary inside the geofence "
            "for at least MIN_STOP_SECONDS, so a vehicle that merely drove past a site "
            "produces no event. Approach rings are drawn for every site on the day "
            "(the focus site's ring is stronger); they are computed outward FROM each "
            "site so "
            "it only approximates drive time toward it; the quoted minutes-out always "
            "comes from the live matrix call instead. If the routing engine is suspended "
            "the ring and the inbound ETA RAISE rather than return nothing, so the app "
            "shows a resume notice instead of a silently empty map; the optional "
            "geofence layer needs no routing and keeps working regardless. "
            "SOURCE_STATUS_HINT separates "
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
                # playIntervalMs is a MINIMUM frame time, not a period: Play waits
                # for every area's query to settle before stepping, so the panels
                # stay in lockstep with the clock. playMaxWaitMs caps that wait so
                # one slow query degrades playback to a timed advance rather than
                # freezing it.
                "playIntervalMs": 400,
                "playMaxWaitMs": 8000,
                "info": (
                    "Scrubs the service day in 10-minute steps. Everything on the page "
                    "is evaluated at this instant: site readiness, the notification feed "
                    "cutoff, and the live approach ring and inbound ETA. 10 minutes is "
                    "finer than the median time on site (about 12 minutes), so a typical "
                    "delivery is always caught while the vehicle is still there; an "
                    "hourly step misses roughly two thirds of them. Play advances only "
                    "once every panel has finished loading the current instant, so a step "
                    "takes as long as the slowest query (the live routing call) rather "
                    "than a fixed interval."
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
                    # All sites' rings, ON by default. Fetched once per service day,
                    # not per replay step, so leaving it on costs ~4.9s at load and
                    # nothing thereafter.
                    {"key": "show_all_rings", "label": "All approach rings (15 min)", "default": True},
                    {"key": "show_ring", "label": "Focus site ring (15 min)", "default": True},
                    # Default OFF: a 100-200 m circle is only a few pixels at city
                    # zoom, so it is a zoomed-in diagnostic rather than an overview
                    # layer. Off also means no query at all - LayerFetcher skips
                    # fetching a gated-off layer - so it costs nothing until asked
                    # for.
                    {"key": "show_geofence", "label": "Site geofence (100-200 m)", "default": False},
                    {"key": "show_vehicles", "label": "Vehicles", "default": True},
                ],
                # Only the three ACTIONABLE vehicle states get a colour. Listing
                # DRIVING and IDLE separately would undercut the point of muting
                # them: at a typical instant it is about 11 coloured against 41
                # blue, so the eye should land on the few that matter.
                "legend": [
                    {"label": "On site now", "color": VEHICLE_PALETTE["ON_SITE"]},
                    {"label": "Just left", "color": VEHICLE_PALETTE["JUST_LEFT"]},
                    {"label": "Approaching (15 min)", "color": VEHICLE_PALETTE["APPROACHING"]},
                    {"label": "En route / idle", "color": SNOWFLAKE_BLUE},
                    {"label": "Delivery site (grey ring)", "color": SITE_STROKE_GREY},
                    {"label": "Geofence 100-200 m", "color": GEOFENCE_GREY, "shape": "line"},
                    # Dark blue #11567F, NOT the light blue used for vehicles: the
                    # ring used to share the vehicles' blue, which now reads as a
                    # vehicle smeared across the map.
                    {"label": "Approach ring, all sites", "color": RING_ALL_LINE, "shape": "line"},
                    {"label": "Approach ring, focus site", "color": RING_FOCUS_LINE, "shape": "line"},
                ],
                "layers": [
                    {
                        # EVERY site's 15-minute ring, drawn faintly and FIRST so
                        # it sits under the focus ring, the geofences, the sites
                        # and the vehicles.
                        #
                        # Bound to the region and the date range ONLY. Deliberately
                        # not to :as_of_minute - a drive-time ring does not move as
                        # the replay clock advances - and deliberately not to
                        # :selected_site either, which is why the focus site is NOT
                        # excluded here (P_EXCLUDE_SITE_ID is passed NULL).
                        #
                        # Excluding it would be marginally cleaner to look at, but it
                        # would put :selected_site in the params key and so re-run a
                        # ~4.9s 118-site ORS call on EVERY site click. Instead the
                        # focus site's faint ring is simply overdrawn by the strong
                        # one, which is layered after it: alpha 8 under alpha 30 fill
                        # and a width-1 alpha-85 outline under a width-2 alpha-220
                        # one is not perceptible. Net effect: this layer is fetched
                        # ONCE per page load and then never again - no stall on a
                        # click, no stall on a playback step.
                        "type": "geojson",
                        "id": "approach-rings-all",
                        "geojsonColumn": "geo",
                        "visibleWhen": "show_all_rings",
                        "noFit": True,
                        "fillColor": RING_ALL_FILL,
                        "lineColor": RING_ALL_LINE,
                        "lineWidth": 1,
                        "pickable": True,
                        "tooltip": "<b>{site_name}</b><br/>Within {minutes} min drive",
                        "data": {
                            "query": (
                                "SELECT ST_ASGEOJSON(RING_GEOG)::STRING AS geo, "
                                "SITE_NAME AS site_name, "
                                "ROUND(RANGE_SECONDS/60.0) AS minutes "
                                "FROM TABLE(FLEET_APP.DELIVERY_SYNC.LIVE_APPROACH_RINGS("
                                ":region, " + PROFILE + ", " + APPROACH + ", "
                                # NULL::VARCHAR, not a bare NULL: an untyped NULL
                                # gives Snowflake nothing to resolve the overload
                                # against and the call fails to compile.
                                + SD + "::DATE, NULL::VARCHAR))"
                            ),
                            "params": dict(CTX),
                        },
                    },
                    {
                        "type": "geojson",
                        "id": "approach-ring",
                        "geojsonColumn": "geo",
                        "visibleWhen": "show_ring",
                        "noFit": True,
                        "fillColor": RING_FOCUS_FILL,
                        "lineColor": RING_FOCUS_LINE,
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
                    # The detection boundaries the arrival/departure logic actually
                    # tests against, one layer per distinct radius. Listed BEFORE
                    # the site markers so the rings sit underneath them.
                    #
                    # These are the only ORS-INDEPENDENT geometry on the map: pure
                    # Snowflake data, so they keep drawing when the routing engine
                    # is cold and the isochrone cannot be computed.
                    #
                    # Time-independent, and deliberately NOT referencing the as-of
                    # instant: a geofence is a property of the site, not of the
                    # replay clock. That keeps the params key stable during
                    # playback, so these fetch ONCE instead of on every 10-minute
                    # step.
                    *[
                        {
                            "type": "scatterplot",
                            "id": "geofence-%d" % radius_m,
                            "lng": "lng",
                            "lat": "lat",
                            "visibleWhen": "show_geofence",
                            "noFit": True,
                            # Radius in METRES - the true geofence size.
                            "radius": radius_m,
                            # radiusMinPixels 0 on purpose: flooring it would draw
                            # the boundary larger than it is, which for a detection
                            # radius is a misrepresentation. The honest consequence
                            # is that these are only legible zoomed in.
                            "radiusMinPixels": 0,
                            "radiusMaxPixels": 400,
                            "fillColor": TRANSPARENT,
                            "stroked": True,
                            "lineColor": GEOFENCE_GREY,
                            "lineWidthMinPixels": 1,
                            "data": {
                                "query": (
                                    "SELECT SITE_ID AS site_id, "
                                    "ST_X(ANY_VALUE(SITE_GEOG)) AS lng, "
                                    "ST_Y(ANY_VALUE(SITE_GEOG)) AS lat "
                                    "FROM FLEET_APP.DELIVERY_SYNC.VW_SITE_VISITS "
                                    "WHERE REGION = :region AND SERVICE_DATE = " + SD
                                    + " AND SITE_GEOG IS NOT NULL "
                                    "AND GEOFENCE_RADIUS_M = %d GROUP BY SITE_ID" % radius_m
                                ),
                                "params": dict(CTX),
                            },
                        }
                        for radius_m in GEOFENCE_RADII
                    ],
                    {
                        # The fixed estate: larger, HOLLOW, one marker per site.
                        # Readiness no longer drives the colour (the vehicles carry
                        # that story now) but is rolled into the tooltip.
                        "type": "scatterplot",
                        "id": "sites",
                        # Opt out of selection framing: this layer is colour-bound
                        # to selected_site, so without noFit a click would collapse
                        # the camera onto the single matched point and zoom in
                        # before the approach ring finishes loading.
                        "noFit": True,
                        "lng": "lng",
                        "lat": "lat",
                        "radius": 140,
                        "radiusMinPixels": 6,
                        "radiusMaxPixels": 22,
                        "pickable": True,
                        "stroked": True,
                        "lineColor": SITE_STROKE_GREY,
                        # 2px so the ring stays readable once the fill is gone.
                        "lineWidthMinPixels": 2,
                        "fillColor": {
                            # Transparent at rest, so a site is a grey outline and
                            # can never be mistaken for a blue vehicle dot. The
                            # SELECTED site fills solid dark blue - a much stronger
                            # affordance than it was when every site was filled.
                            "base": TRANSPARENT,
                            "active": [17, 86, 127, 255],
                            "matchColumn": "site_id",
                            "whenViewStateEquals": "selected_site",
                        },
                        "tooltip": (
                            "<b>{site_name}</b><br/>{visits_today} delivery(s) today"
                            "<br/>{deliveries_done} done, {on_site_now} in progress"
                            "<br/>Last ready {last_ready_at}"
                        ),
                        "data": {
                            # DEDUPED to one row per site. F_SITE_READINESS_ASOF is
                            # per VISIT, so a site served twice in a day produced two
                            # exact-coordinate markers (134 rows for 118 sites on the
                            # reference day). Grouping also stops a repeat-visit site
                            # being drawn triple-weight.
                            "query": (
                                "SELECT SITE_ID AS site_id, ANY_VALUE(SITE_NAME) AS site_name, "
                                "ST_X(ANY_VALUE(SITE_GEOG)) AS lng, ST_Y(ANY_VALUE(SITE_GEOG)) AS lat, "
                                "COUNT(*) AS visits_today, "
                                "COUNT_IF(READINESS_ENUM='READY') AS deliveries_done, "
                                "COUNT_IF(READINESS_ENUM='IN_PROGRESS') AS on_site_now, "
                                "COALESCE(TO_VARCHAR(MAX(IFF(READINESS_ENUM='READY', "
                                "DEPARTURE_TS, NULL)),'HH24:MI'), '-') AS last_ready_at "
                                "FROM TABLE(FLEET_APP.DELIVERY_SYNC.F_SITE_READINESS_ASOF(:region, "
                                + ASOF + ")) WHERE SERVICE_DATE = " + SD
                                + " AND SITE_GEOG IS NOT NULL GROUP BY SITE_ID"
                            ),
                            "params": dict(CTX),
                        },
                    },
                    {
                        # The moving layer: every vehicle with a recent position,
                        # coloured ONLY when its state is actionable. Replaces the
                        # old focus-site inbound layer, so ORS calls per step stay
                        # at 2 (this fleet matrix + the inbound table).
                        "type": "scatterplot",
                        "id": "vehicles",
                        "lng": "lng",
                        "lat": "lat",
                        "visibleWhen": "show_vehicles",
                        "noFit": True,
                        "stroked": True,
                        # Static blue stroke on EVERY vehicle. For en-route/idle it
                        # matches the fill, so a neutral vehicle reads as one flat
                        # blue dot; for the three actionable states it becomes a
                        # blue ring around a coloured centre, which keeps "this is a
                        # vehicle" legible at a glance. Never grey - grey now means
                        # site.
                        "lineColor": SNOWFLAKE_BLUE,
                        "lineWidthMinPixels": 1,
                        "fillColor": {
                            "column": "status",
                            "palette": VEHICLE_PALETTE,
                            # Any future status not in the palette degrades to blue
                            # rather than to a stray colour.
                            "default": SNOWFLAKE_BLUE,
                        },
                        "radius": 70,
                        "radiusMinPixels": 4,
                        "radiusMaxPixels": 12,
                        "pickable": True,
                        "tooltip": (
                            "<b>{vehicle_id}</b><br/>{status_label}"
                            "<br/>{site_name}<br/>{detail}"
                        ),
                        "data": {
                            "query": (
                                "SELECT VEHICLE_ID AS vehicle_id, STATUS_ENUM AS status, "
                                "COALESCE(SITE_NAME, 'No further stops today') AS site_name, "
                                "CASE STATUS_ENUM "
                                "WHEN 'ON_SITE' THEN 'On site now' "
                                "WHEN 'JUST_LEFT' THEN 'Just left' "
                                "WHEN 'APPROACHING' THEN 'Approaching' "
                                "WHEN 'DRIVING' THEN 'En route' "
                                "ELSE 'Idle' END AS status_label, "
                                "CASE STATUS_ENUM "
                                "WHEN 'JUST_LEFT' THEN MINUTES_SINCE_LEFT::VARCHAR || ' min ago' "
                                "WHEN 'ON_SITE' THEN 'Unloading' "
                                "WHEN 'IDLE' THEN 'Day complete' "
                                "ELSE MINUTES_OUT::VARCHAR || ' min out, ' "
                                "|| DISTANCE_KM::VARCHAR || ' km by road' END AS detail, "
                                "ST_X(VEHICLE_GEOG) AS lng, ST_Y(VEHICLE_GEOG) AS lat "
                                "FROM TABLE(FLEET_APP.DELIVERY_SYNC.LIVE_FLEET_STATUS("
                                ":region, " + PROFILE + ", " + ASOF + ", "
                                + APPROACH_MIN + ", 20, 20))"
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
