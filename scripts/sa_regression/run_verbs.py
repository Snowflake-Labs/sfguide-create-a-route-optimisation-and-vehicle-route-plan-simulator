#!/usr/bin/env python3
"""Replay every non-declarative SA app / CoWork call per synthetic dataset.

validate_app_views.py already executes every app-views.json panel. This covers
what it cannot: the custom React pages (vrp_simulator, emergency_response,
backload_proposals, triangle_proposals, ops_console), the /api/tool verbs the
chat inline maps call, the CoWork deep-link verbs (show_view / deep_link) and
the agent itself via DATA_AGENT_RUN.

Each call is issued exactly as the app route issues it:
  CALL OPENROUTESERVICE_APP.ROUTING.<verb>(<business args>, NULL)
and the first column of the first row is JSON-parsed, as /api/tool does.

Usage: run_verbs.py -c TIB --region SanFrancisco [--only name] [--agent]
                    --report logs/sa_regression/p1/verbs_SanFrancisco.json
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import snowflake.connector

ROUTING = "OPENROUTESERVICE_APP.ROUTING"
OPS = "FLEET_INTELLIGENCE.SYNAPSE_OPS"
QUERY_TAG = ('{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps",'
             '"version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,'
             '"source":"sql","module":"sa-regression"}}')

PROFILE = {"ebike": "cycling-electric", "hgv": "driving-hgv", "car": "driving-car"}

# Place descriptions the geocoding verbs resolve inside each region's graph.
PLACES = {
    "SanFrancisco": ["Ferry Building, San Francisco, CA",
                     "Golden Gate Park, San Francisco, CA",
                     "Mission Dolores Park, San Francisco, CA",
                     "Union Square, San Francisco, CA"],
    "UsTexas": ["Downtown Austin, TX", "Round Rock, TX",
                "San Marcos, TX", "Georgetown, TX"],
    "UnitedStatesOfAmerica": ["Chicago, IL", "Indianapolis, IN",
                              "Milwaukee, WI", "Detroit, MI"],
}

# Every view a CoWork deep link can open (app-views.json + pack views).
VIEWS = None  # filled from app-views.json + pack-views.json at startup


def lit(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("\\", "\\\\").replace("'", "''") + "'"


def connect(conn_name):
    c = snowflake.connector.connect(connection_name=conn_name)
    cur = c.cursor()
    cur.execute("ALTER SESSION SET QUERY_TAG = %s", (QUERY_TAG,))
    cur.execute("USE ROLE ACCOUNTADMIN")
    return c


def call(conn, schema, verb, args, warehouse="FLEET_APPS_WH"):
    sql = "CALL %s.%s(%s)" % (schema, verb, ", ".join(lit(a) for a in args + [None]))
    cur = conn.cursor()
    cur.execute("USE WAREHOUSE %s" % warehouse)
    t0 = time.time()
    cur.execute(sql)
    row = cur.fetchone()
    ms = int((time.time() - t0) * 1000)
    val = row[0] if row else None
    if isinstance(val, str):
        try:
            val = json.loads(val)
        except ValueError:
            pass
    # Every synapse verb returns {"result": <payload>}; the payload may itself
    # be a JSON string.
    if isinstance(val, dict) and set(val) == {"result"}:
        val = val["result"]
        if isinstance(val, str):
            try:
                val = json.loads(val)
            except ValueError:
                pass
    return val, ms, sql


GEO_KEYS = ("coordinates", "geojson", "geometry", "path", "polygon", "lon", "lng",
            "longitude", "location", "features")


def geo_evidence(obj, depth=0):
    """Count map-plottable leaves: a key that names geometry and holds data."""
    if depth > 8 or obj is None:
        return 0
    n = 0
    if isinstance(obj, dict):
        for k, v in obj.items():
            kl = k.lower()
            if any(g in kl for g in GEO_KEYS) and v not in (None, "", [], {}):
                n += 1
            n += geo_evidence(v, depth + 1)
    elif isinstance(obj, list):
        for v in obj[:50]:
            n += geo_evidence(v, depth + 1)
    return n


def failure_of(res):
    """The verb envelope reports failure in-band; surface it."""
    if not isinstance(res, dict):
        return "non-object result: %r" % (str(res)[:200],)
    for key in ("error", "error_message"):
        if res.get(key):
            return "%s: %s" % (key, str(res[key])[:400])
    st = str(res.get("status", "")).upper()
    if st and st not in ("SUCCESS", "OK", "PARTIAL", "COMPLETE", "COMPLETED", "PENDING"):
        return "status=%s reason=%s msg=%s" % (st, res.get("reason"),
                                              str(res.get("message", ""))[:300])
    return None


def cases(region, vt, dataset_id):
    p = PROFILE.get(vt, "driving-car")
    a, b, c, d = PLACES[region]
    stops = "\n".join([b, c, d])
    out = [
        # name, schema, verb, args, needs_map, warehouse
        ("get_directions", ROUTING, "GET_DIRECTIONS", ["%s to %s" % (a, b), p, region], True),
        ("compute_isochrone", ROUTING, "COMPUTE_ISOCHRONE", [a, 10, p], True),
        ("find_poi", ROUTING, "FIND_POI", [a, 10, "restaurant", p, 20], True),
        ("catchment", ROUTING, "CATCHMENT", [a, 10, p], True),
        # vrp_simulator page Run button: args [stops, depot, vehicles, profile, null]
        ("vrp_simulator.optimize_routes", ROUTING, "OPTIMIZE_ROUTES", [stops, a, 2, p, None], True),
        ("delivery_optimization", ROUTING, "DELIVERY_OPTIMIZATION", [p, region], True),
        ("network_optimization", ROUTING, "NETWORK_OPTIMIZATION", [p, region], True),
        ("query_overture_places", ROUTING, "QUERY_OVERTURE_PLACES",
         [region, "restaurant", None, 50, None, None, None, None], True),
        ("query_overture_addresses", ROUTING, "QUERY_OVERTURE_ADDRESSES",
         [region, None, 50, None, None, None, None], True),
        # backload_proposals Run: [strat, 20, 120, region, 200, 'pair', null, 600]
        ("backload_proposals.backload_solve", ROUTING, "BACKLOAD_SOLVE",
         ["ensemble", 20, 120, region, 200, "pair", None, 600], False, "ROUTING_ANALYTICS"),
        # triangle_proposals load (great_circle) and Cost-on-road button (road)
        ("triangle_proposals.chain_gc", ROUTING, "BACKLOAD_CHAIN_SOLVE",
         [region, "great_circle", None, None, 200, "raw"], False, "ROUTING_ANALYTICS"),
        ("triangle_proposals.chain_road", ROUTING, "BACKLOAD_CHAIN_SOLVE",
         [region, "road", None, None, 200, "raw"], False, "ROUTING_ANALYTICS"),
        # emergency_response Seed button: [region, 'WILDFIRE', 15, 60]
        ("emergency_response.evac_seed", ROUTING, "EVAC_SEED",
         [region, "WILDFIRE", 15, 60], True, "ROUTING_ANALYTICS"),
        # ops_console load + buttons
        ("ops.service_inventory", OPS, "SERVICE_INVENTORY", [], False),
        ("ops.healthcheck", OPS, "HEALTHCHECK", [], False),
        ("ops.recent_verb_attempts", OPS, "RECENT_VERB_ATTEMPTS", [100, None, None], False),
        ("ops.service_status", OPS, "SERVICE_STATUS",
         ["OPENROUTESERVICE_APP.CORE.ORS_SERVICE_%s" % region.upper()], False),
        ("ops.list_datasets", OPS, "LIST_DATASETS", [region, None, False], False),
        ("describe_deployment", ROUTING, "DESCRIBE_DEPLOYMENT", [], False),
    ]
    for vid in VIEWS:
        out.append(("show_view." + vid, ROUTING, "SHOW_VIEW",
                    [vid, region, vt, dataset_id, None], False))
        out.append(("deep_link." + vid, ROUTING, "DEEP_LINK",
                    ["sa", None, vid, region, vt, dataset_id, None], False))
    return [c if len(c) == 6 else c + ("FLEET_APPS_WH",) for c in out]


def evac_challenge(seed, centers, vans=4, cap=6, level=3):
    """Build the Plan-evacuation challenge the way emergency-response.tsx does:
    care centers (loaded on page mount) x vans, one pickup job per participant
    at or above the default wildfire risk level."""
    parts = [p for p in (seed.get("participants") or []) if (p.get("wf_lvl") or 0) >= level]
    if not parts or not centers:
        return None, "participants>=L%d=%d centers=%d" % (level, len(parts), len(centers))
    trips = max(1, -(-len(parts) // (len(centers) * vans * cap)))
    per_center = min(vans * trips, max(vans, 190 // len(centers)))
    vehicles, vid = [], 1
    for lon, lat in centers:
        for _ in range(per_center):
            vehicles.append({"id": vid, "start": [lon, lat], "end": [lon, lat],
                             "profile": "driving-car", "capacity": [cap]})
            vid += 1
    jobs = [{"id": i + 1, "location": [p["lon"], p["lat"]], "pickup": [1],
             "description": str(p.get("pid", i))} for i, p in enumerate(parts)]
    return json.dumps({"vehicles": vehicles, "jobs": jobs}), None


def run_case(conn_name, case, region):
    name, schema, verb, args, needs_map, wh = case
    rec = {"region": region, "case": name, "verb": verb}
    try:
        conn = connect(conn_name)
        try:
            res, ms, sql = call(conn, schema, verb, args, wh)
            rec.update(ms=ms, sql=sql[:600])
            fail = failure_of(res)
            geo = geo_evidence(res)
            rec["geo"] = geo
            rec["keys"] = sorted(res.keys())[:30] if isinstance(res, dict) else None
            if fail:
                rec.update(status="FAIL", detail=fail)
            elif needs_map and geo == 0:
                rec.update(status="NO_MAP", detail="result has no plottable geometry")
            else:
                rec.update(status="OK")
            if name == "emergency_response.evac_seed" and rec["status"] == "OK":
                cur = conn.cursor()
                cur.execute("SELECT LON, LAT FROM FLEET_APP.EMERGENCY_RESPONSE.VW_CARE_CENTERS "
                            "WHERE REGION = %s LIMIT 200", (region,))
                centers = [(float(a), float(b)) for a, b in cur.fetchall() if a is not None]
                ch, why = evac_challenge(res, centers)
                if not ch:
                    rec2 = {"region": region, "case": "emergency_response.evac_solve",
                            "status": "FAIL", "detail": "cannot build challenge: " + why}
                else:
                    r2, ms2, _ = call(conn, ROUTING, "EVAC_SOLVE", [ch, region], "ROUTING_ANALYTICS")
                    f2 = failure_of(r2)
                    g2 = geo_evidence(r2)
                    rec2 = {"region": region, "case": "emergency_response.evac_solve", "ms": ms2, "geo": g2,
                            "status": "FAIL" if f2 else ("NO_MAP" if g2 == 0 else "OK"), "detail": f2}
                rec["follow"] = rec2
        finally:
            conn.close()
    except Exception as e:  # noqa: BLE001 - the harness reports, never aborts
        rec.update(status="ERROR", detail=str(e)[:600])
    return rec


TRANSIENT = ("http_5xx", "all_chunks_failed", "service_unreachable", "timed out", "busy")


def run_case_retry(conn_name, case, region):
    """One retry for engine-load transients; a pass on retry is recorded as FLAKY."""
    rec = run_case(conn_name, case, region)
    if rec["status"] != "OK" and any(t in (rec.get("detail") or "").lower() for t in TRANSIENT):
        time.sleep(20)
        again = run_case(conn_name, case, region)
        if again["status"] == "OK":
            again["flaky"] = rec.get("detail")
        return again
    return rec


def main():
    global VIEWS
    ap = argparse.ArgumentParser()
    ap.add_argument("-c", "--connection", default="TIB")
    ap.add_argument("--region", required=True)
    ap.add_argument("--only", action="append", default=[])
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--report", required=True)
    a = ap.parse_args()

    import pathlib
    app = pathlib.Path(__file__).resolve().parents[2] / ".cortex/skills/install-fleet-apps/fleet_sa_app"
    VIEWS = list(json.load(open(app / "app/app-views.json")).keys())
    pv = json.load(open(app / "ui/src/lib/packs/fleet/pack-views.json"))
    VIEWS += [k for k in (pv.keys() if isinstance(pv, dict) else []) if k not in VIEWS]

    conn = connect(a.connection)
    cur = conn.cursor()
    cur.execute("SELECT DATASET_ID, VEHICLE_TYPE FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS "
                "WHERE REGION = %s ORDER BY IS_ACTIVE DESC, CREATED_AT DESC LIMIT 1", (a.region,))
    ds, vt = cur.fetchone()
    conn.close()

    todo = [c for c in cases(a.region, vt, ds) if not a.only or any(o in c[0] for o in a.only)]
    with ThreadPoolExecutor(a.workers) as ex:
        results = list(ex.map(lambda c: run_case_retry(a.connection, c, a.region), todo))
    flat = []
    for r in results:
        follow = r.pop("follow", None)
        flat.append(r)
        if follow:
            flat.append(follow)
    bad = [r for r in flat if r["status"] != "OK"]
    for r in flat:
        print("%-7s %-45s %6s ms geo=%-4s %s" % (r["status"], r["case"], r.get("ms", ""),
                                                  r.get("geo", ""), (r.get("detail") or "")[:160]))
    print("\n%s: %d cases, %d not OK" % (a.region, len(flat), len(bad)))
    json.dump(flat, open(a.report, "w"), indent=1, default=str)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
