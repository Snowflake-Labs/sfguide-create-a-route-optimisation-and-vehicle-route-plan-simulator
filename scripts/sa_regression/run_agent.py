#!/usr/bin/env python3
"""Ask every CoWork skill's question on both agent surfaces, per region, and
prove each map the agent emitted would actually draw.

SA surface     : FLEET_AGENT with the SA chat route's active-context prefix.
CoWork surface : FLEET_SUPER_AGENT (what CoWork binds) with no SA prefix.

Both surfaces are judged the same way: a map ask must produce a render_map (or
a routing map tool) call, and every render_map layer query is executed with the
context binds and must return rows. The CoWork HOST tool data_to_map is not
injected under DATA_AGENT_RUN, so the super agent correctly falls back to
render_map here; the live CoWork data_to_map branch cannot be exercised from
SQL and is reported as untested, not passed.

Usage: run_agent.py -c TIB --region UsTexas --report ...json [--surface sa|cowork]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import snowflake.connector

QUERY_TAG = ('{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps",'
             '"version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,'
             '"source":"sql","module":"sa-regression-agent"}}')
AGENTS = {"sa": "FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_AGENT",
          "cowork": "FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_SUPER_AGENT"}
PROFILE = {"ebike": "cycling-electric", "hgv": "driving-hgv", "car": "driving-car"}
MAP_TOOLS = {"get_directions", "optimize_routes", "compute_isochrone", "find_poi", "catchment",
             "delivery_optimization", "network_optimization", "evac_seed", "evac_solve",
             "vrp_solve", "query_overture_places", "query_overture_addresses"}

# (skill, question, wants_map)
ASKS = [
    ("catchment", "If we put a site in the busiest area, how many people can reach it by road, and who is already competing for them?", True),
    ("site_impact", "If we open a new site, how much revenue is incremental versus taken from existing stores?", True),
    ("closure_impact", "If we close our weakest site, how much revenue do we keep versus lose?", True),
    ("space_time_density", "Where does activity cluster, and at what times of day?", True),
    ("dwell_overview", "How much paid time do we lose standing still, and are we meeting turnaround commitments?", False),
    ("dwell_sla", "Which dwell SLA breaches happened, how bad, and where should we intervene first?", True),
    ("dwell_facilities", "Which facilities cost the most turnaround time?", True),
    ("dispatch_execution_board", "Will we complete today's committed work, and which jobs are late or missed?", True),
    ("responsible_party_performance", "Which drivers need coaching, and which are our benchmark?", False),
    ("safety_risk_scorecard", "Where is safety risk concentrated, and what do we fix first?", True),
    ("journey_inspector", "Pick the longest recent trip: what actually happened on it and why did it take longer?", True),
    ("plan_vs_actual_performance", "How closely does execution match plan, and where is margin leaking?", True),
    ("live_asset_operations", "Where is every vehicle right now?", True),
    ("asset_velocity", "Which vehicles are idle, what does it cost, and where should they go next?", True),
    ("fleetops_origins", "Which origins generate most work, and is our network positioned against them?", True),
    ("labor_overtime", "Which drivers will exceed weekly hours and at what cost?", False),
    ("vrp_simulator", "What is the cheapest set of routes covering today's stops with the vehicles we have?", True),
    ("route_plan_standards", "Are planners working to the same standard, and what does inconsistency cost?", False),
    ("backload_matching", "Our vehicles run back empty: which waiting loads could they carry, and what is it worth?", True),
    ("backload_proposals", "Which backhaul should our longest-idle vehicle take, and why?", False),
    ("triangle_proposals", "No direct return load: is there a two-load chain home that beats running empty?", True),
    ("sourcing_optimizer", "Where do we ship from the wrong plant, and what would re-sourcing save per year?", False),
    ("mix_sourcing", "For multi-product orders, should we ship from each plant or consolidate through a hub?", False),
    ("delivery_sync", "Has the latest delivery arrived and left, so the receiving crew can be sent now?", True),
    ("emergency_response", "If a wildfire hazard escalates, who do we collect first and with which vehicles?", True),
]
MAP_SUFFIX = " Show it on a map."


def connect(name):
    c = snowflake.connector.connect(connection_name=name)
    cur = c.cursor()
    cur.execute("ALTER SESSION SET QUERY_TAG = %s", (QUERY_TAG,))
    cur.execute("USE ROLE ACCOUNTADMIN")
    cur.execute("USE WAREHOUSE FLEET_APPS_WH")
    return c


def sa_prefix(ctx):
    return ("[Active context: region = %s, vehicle type = %s (routing profile: %s), dataset_id = %s] "
            % (ctx["region"], ctx["vehicle_type"], PROFILE.get(ctx["vehicle_type"], "driving-car"),
               ctx["dataset_id"]))


def lit(v):
    return "NULL" if v in (None, "") else "'" + str(v).replace("'", "''") + "'"


def bind(query, params, ctx):
    """render_map params bind only context.* or literals."""
    vals = {}
    for k, v in (params or {}).items():
        if isinstance(v, str) and v.startswith("context."):
            vals[k] = ctx.get(v.split(".", 1)[1])
        else:
            vals[k] = v
    for k in ctx:
        vals.setdefault(k, ctx[k])
    return re.sub(r"(?<!:):([A-Za-z_]\w*)", lambda m: lit(vals.get(m.group(1))) if m.group(1) in vals
                  else m.group(0), query)


def parse_parts(resp):
    content = resp.get("content", []) if isinstance(resp, dict) else []
    tools, results, text = [], [], []
    for p in content:
        t = p.get("type")
        if t == "tool_use":
            tools.append(p["tool_use"])
        elif t == "tool_result":
            results.append(p["tool_result"])
        elif t == "text":
            text.append(p.get("text", ""))
    return tools, results, "\n".join(text)


def short(name):
    return re.sub(r"^(routing_mcp_|fleet_ops_mcp_|fleet_admin_mcp_)", "", name or "")



def check_render_map(conn, tool, ctx):
    try:
        spec = json.loads(tool["input"].get("spec_json") or "{}")
    except ValueError as e:
        return "spec_json not JSON: %s" % e
    layers = spec.get("layers") or []
    if not layers:
        return "render_map with no layers"
    for i, layer in enumerate(layers):
        q = (layer.get("data") or {}).get("query")
        if not q:
            return "layer %d has no query" % i
        sql = bind(q, (layer.get("data") or {}).get("params"), ctx)
        cur = conn.cursor()
        try:
            cur.execute(sql.rstrip().rstrip(";"))
            row = cur.fetchone()
        except Exception as e:  # noqa: BLE001
            return "layer %d query failed: %s" % (i, str(e)[:300])
        if not row:
            return "layer %d query returned 0 rows" % i
    return None


def run_one(conn_name, surface, ctx, skill, question, wants_map):
    q = question + (MAP_SUFFIX if wants_map else "")
    text = (sa_prefix(ctx) + q) if surface == "sa" else (
        q + " (Region: %s, vehicle type: %s.)" % (ctx["region"], ctx["vehicle_type"]))
    body = json.dumps({"messages": [{"role": "user", "content": [{"type": "text", "text": text}]}]})
    rec = {"surface": surface, "region": ctx["region"], "skill": skill, "wants_map": wants_map}
    t0 = time.time()
    try:
        conn = connect(conn_name)
        try:
            cur = conn.cursor()
            cur.execute("SELECT SNOWFLAKE.CORTEX.DATA_AGENT_RUN(%s, %s)", (AGENTS[surface], body))
            resp = json.loads(cur.fetchone()[0])
            rec["ms"] = int((time.time() - t0) * 1000)
            tools, results, answer = parse_parts(resp)
            names = [short(t.get("name")) for t in tools]
            rec["tools"] = names
            rec["answer"] = answer[:600]
            errs = [short(r.get("name")) + ": " + json.dumps(r.get("content"))[:300]
                    for r in results if str(r.get("status", "")).lower() not in ("success", "")]
            if errs:
                rec["tool_errors"] = errs
            problems = []
            if not answer.strip():
                problems.append("empty answer")
            maps = [t for t in tools if short(t.get("name")) == "render_map"]
            for t in maps:
                p = check_render_map(conn, t, ctx)
                if p:
                    problems.append("render_map: " + p)
            has_map = bool(maps) or any(n in MAP_TOOLS for n in names)
            if wants_map and not has_map:
                problems.append("no map produced (tools=%s)" % names)
            # A verb that failed on the MCP transport (not on its own logic)
            # is a platform defect regardless of whether the agent recovered.
            nil = [e for e in rec.get("tool_errors", []) if "unsupported parameter type" in e]
            if nil:
                problems.append("MCP rejected a null arg: " + nil[0][:160])
            rec["status"] = "FAIL" if problems else "OK"
            rec["detail"] = "; ".join(problems)
        finally:
            conn.close()
    except Exception as e:  # noqa: BLE001
        rec.update(status="ERROR", detail=str(e)[:500], ms=int((time.time() - t0) * 1000))
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-c", "--connection", default="TIB")
    ap.add_argument("--region", required=True)
    ap.add_argument("--surface", action="append", default=[])
    ap.add_argument("--only", action="append", default=[])
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--report", required=True)
    a = ap.parse_args()
    surfaces = a.surface or ["sa", "cowork"]
    conn = connect(a.connection)
    cur = conn.cursor()
    cur.execute("SELECT DATASET_ID, VEHICLE_TYPE FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS "
                "WHERE REGION = %s ORDER BY IS_ACTIVE DESC, CREATED_AT DESC LIMIT 1", (a.region,))
    ds, vt = cur.fetchone()
    conn.close()
    ctx = {"region": a.region, "vehicle_type": vt, "dataset_id": ds,
           "date_range_start": None, "date_range_end": None}
    jobs = [(s, sk, q, m) for s in surfaces for sk, q, m in ASKS if not a.only or sk in a.only]
    with ThreadPoolExecutor(a.workers) as ex:
        res = list(ex.map(lambda j: run_one(a.connection, j[0], ctx, j[1], j[2], j[3]), jobs))
    for r in res:
        print("%-6s %-6s %-30s %6s ms %s | %s" % (r["status"], r["surface"], r["skill"], r.get("ms"),
                                                 ",".join(r.get("tools", []))[:80], r.get("detail", "")[:200]))
    bad = [r for r in res if r["status"] != "OK"]
    print("\n%s: %d asks, %d not OK" % (a.region, len(res), len(bad)))
    json.dump(res, open(a.report, "w"), indent=1, default=str)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
