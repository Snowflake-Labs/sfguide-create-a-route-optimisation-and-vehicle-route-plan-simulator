#!/usr/bin/env python3
"""Register the query_delivery_sync Cortex Analyst tool on FLEET_AGENT.

Adds the tool_spec + tool_resource bound to SV_DELIVERY_SYNC, and extends the
orchestration routing text with a line for it. Idempotent - re-running replaces
the existing entries rather than duplicating them.

agent-spec.json is machine-generated-looking but hand-maintained; it is a flat
JSON doc with no hand-formatted compact arrays, so a json.dumps round-trip is
safe here (unlike app-views.json, which needs a textual splice).
"""
import collections
import json
import pathlib
import sys

SPEC = (pathlib.Path(__file__).resolve().parents[1]
        / "fleet_sa_app" / "app" / "agent-spec.json")

TOOL_NAME = "query_delivery_sync"

TOOL_SPEC = {
    "tool_spec": {
        "type": "cortex_analyst_text_to_sql",
        "name": TOOL_NAME,
        "description": (
            "Analytics over geofence-detected site arrivals and departures: when a "
            "vehicle reached a delivery site, when it left (the moment the load is "
            "available to the receiving crew), how long it was on site, and which "
            "sites or accounts were served. Use for questions like 'has the vehicle "
            "left site X', 'how long did unloading take', 'which sites were served', "
            "'how many deliveries yesterday'. Filter source_status_hint = "
            "DWELL_DESTINATION for deliveries as distinct from pickups or idling. "
            "This tool is HISTORICAL only: it has no ETA, no predicted arrival and no "
            "minutes-out column, so forward-looking questions ('how far out is the "
            "vehicle', 'who arrives in the next 15 minutes') must go to the live "
            "routing tools or the Delivery Sync page instead."
        ),
    }
}

TOOL_RESOURCE = {
    "semantic_view": "FLEET_INTELLIGENCE.SEMANTIC.SV_DELIVERY_SYNC",
    "execution_environment": {"type": "warehouse", "warehouse": "MY_WH"},
}

# Inserted into the orchestration routing block, right after the query_dwell line
# so the analytics routing list stays grouped and ordered.
ANCHOR = "- dwell time, facility utilization, congestion, SLA breaches -> query_dwell.\n"
ROUTING_LINE = (
    "- site arrival/departure, time on site, whether a load has been delivered yet, "
    "which sites/accounts were served -> query_delivery_sync (historical; for "
    "'how far out is the vehicle' or approach-ring questions use the routing tools "
    "or the Delivery Sync page, which compute ETA live).\n"
)


def main() -> int:
    spec = json.loads(SPEC.read_text(), object_pairs_hook=collections.OrderedDict)

    # --- tools ---
    tools = spec.get("tools") or []
    tools = [t for t in tools
             if ((t.get("tool_spec") or {}).get("name")) != TOOL_NAME]
    # Insert directly after query_dwell to keep analyst tools adjacent.
    idx = next((i + 1 for i, t in enumerate(tools)
                if (t.get("tool_spec") or {}).get("name") == "query_dwell"),
               len(tools))
    tools.insert(idx, json.loads(json.dumps(TOOL_SPEC),
                                 object_pairs_hook=collections.OrderedDict))
    spec["tools"] = tools

    # --- tool_resources ---
    res = spec.get("tool_resources")
    if res is None:
        res = collections.OrderedDict()
        spec["tool_resources"] = res
    res[TOOL_NAME] = json.loads(json.dumps(TOOL_RESOURCE),
                                object_pairs_hook=collections.OrderedDict)

    # --- orchestration routing text ---
    instr = spec.get("instructions") or {}
    orch = instr.get("orchestration")
    if isinstance(orch, str):
        # Drop any prior copy first so re-running does not duplicate the line.
        orch = orch.replace(ROUTING_LINE, "")
        if ANCHOR in orch:
            orch = orch.replace(ANCHOR, ANCHOR + ROUTING_LINE, 1)
        else:
            print("WARN: orchestration anchor not found; routing line not added",
                  file=sys.stderr)
        instr["orchestration"] = orch

    SPEC.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n")

    names = [(t.get("tool_spec") or {}).get("name") for t in spec["tools"]]
    print("tools now: %d" % len(names))
    print("%s registered: %s" % (TOOL_NAME, TOOL_NAME in names))
    print("resource bound: %s" % spec["tool_resources"][TOOL_NAME]["semantic_view"])
    print("routing line present: %s"
          % (ROUTING_LINE.strip()[:40] in (instr.get("orchestration") or "")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
