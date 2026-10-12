#!/usr/bin/env python3
"""Add the query_plan_standards tool to the consumer agent spec.

Three coordinated edits, all idempotent:
  1. a `tools[]` entry (cortex_analyst_text_to_sql)
  2. a matching `tool_resources` block naming SV_PLAN_STANDARDS
  3. one routing bullet in `instructions.orchestration`

The bullet is not optional decoration. Verbs and Analyst tools are VISIBLE to the
agent as soon as they are attached, and visible is not used well: with no routing
line the model either ignores the tool or prefers run_sql over it, silently
bypassing the governed semantic-view path. check_agent_verb_coverage.py exists
because four verbs already shipped unguided.

Written as a script for the same reason as the app-views one: agent-spec.json is
hand-owned and lives on a working tree shared by parallel sessions, so the edit
is surgical and re-runnable rather than a whole-file rewrite.
"""
import json
import pathlib
import sys

SPEC = pathlib.Path(__file__).resolve().parent / "agent-spec.json"
TOOL = "query_plan_standards"

# Mirrors the framing SV_PLAN_STANDARDS carries, because the agent reads this
# description when CHOOSING the tool and the view comment only after it has. Kept
# near the length of the longest existing tool description (query_labor, 1,103
# chars) rather than restating the whole view comment: a description that carries
# every caveat dilutes the selection signal it exists to provide, and the caveats
# are already on the semantic view where they are read at answer time. What stays
# here is only what changes WHICH TOOL gets picked, or what would be wrong in the
# first sentence of an answer.
DESCRIPTION = (
    "Route-plan standardization and planner variance: how consistently each route"
    " planner builds routes against a written planning standard, which standard"
    " each route breaks, and whether plans are released early enough for the"
    " warehouse to start building sessions. Use for 'which planners are least"
    " consistent', 'are our planners following the standard', 'who builds routes"
    " that run past the shift limit', 'why do our route plans vary so much',"
    " 'which depots cannot start picking on time', 'what is our route plan"
    " compliance'. This scores the PLANNER who built the route, not the driver who"
    " drove it. CRITICAL: compliance and consistency are DIFFERENT questions that"
    " do not move together - compliance_pct asks whether a planner follows the"
    " standard, consistency_sd_km_per_stop asks whether they plan the same way"
    " twice - so say which one you answered, and name the breached standard rather"
    " than only quoting a score. Use service_date for operational questions, never"
    " plan_date: on SanFrancisco plan_date sits 40 days earlier, so a"
    " recent-window filter on it returns nothing without erroring. Planner"
    " attribution and plan release time are DERIVED, so qualify any release or"
    " lateness figure as a bound; route, stop, distance and hour figures come from"
    " the planning record and need no such qualification. Only dense urban regions"
    " have multi-stop plans, and each region has its own bands, so group by region"
    " and do not compare breach counts across regions."
)

BULLET = (
    "- Route PLAN quality and planner consistency questions ('are our planners"
    " following the standard', 'which planners are least consistent', 'who plans"
    " routes past the shift limit', 'why do plans vary between planners', 'what is"
    " our plan compliance', 'which depots wait for plans', 'can the warehouse"
    " start building sessions on time') -> use query_plan_standards. Prefer it"
    " over run_sql: it models the whole standards layer. This scores the PLANNER"
    " who built the route; query_route_deviation scores how closely the DRIVER"
    " followed it, and responsible_party_performance ranks operators - do not"
    " substitute one for another. Compliance and consistency are separate measures"
    " and must not be conflated; name the breached standard rather than only a"
    " score. To price one route against the optimizer call"
    " FLEET_APP.PLAN_STANDARDS.F_ROUTE_RESOLVE_GAP, which is a LIVE engine call"
    " for a SINGLE route (it takes the depot and stop coordinates as arrays, so"
    " read them from VW_ROUTE_STOPS in a SEPARATE query first - a statement that"
    " calls an ORS function and also reads the scoped contract views fails on"
    " privileges) and cannot be aggregated across routes."
)


def main() -> int:
    doc = json.loads(SPEC.read_text())

    tools = doc.setdefault("tools", [])
    entry = {
        "tool_spec": {
            "type": "cortex_analyst_text_to_sql",
            "name": TOOL,
            "description": DESCRIPTION,
        }
    }
    existing = [
        i
        for i, t in enumerate(tools)
        if t.get("tool_spec", {}).get("name") == TOOL
    ]
    if existing:
        tools[existing[0]] = entry
        print(f"tools: replaced {TOOL}")
    else:
        tools.append(entry)
        print(f"tools: appended {TOOL}")

    # Same warehouse as every other Analyst tool here; a different one would make
    # this view's credits attribute somewhere nothing else does.
    doc.setdefault("tool_resources", {})[TOOL] = {
        "semantic_view": "FLEET_INTELLIGENCE.SEMANTIC.SV_PLAN_STANDARDS",
        "execution_environment": {
            "type": "warehouse",
            "warehouse": "ROUTING_ANALYTICS",
        },
    }
    print(f"tool_resources: set {TOOL} -> SV_PLAN_STANDARDS")

    orch = doc["instructions"]["orchestration"]
    if TOOL in orch:
        print("orchestration: already routed, leaving as is")
    else:
        # Anchored on the labour bullet so the new line lands inside the same
        # routing list rather than at the end of a 38k-character string, where a
        # rule is satisfiable by the gate but far from what the model is reading.
        anchor = "- Labour, hours worked, overtime"
        idx = orch.find(anchor)
        if idx < 0:
            print("ERROR: routing-list anchor not found", file=sys.stderr)
            return 1
        doc["instructions"]["orchestration"] = (
            orch[:idx] + BULLET + "\n" + orch[idx:]
        )
        print("orchestration: inserted routing bullet")

    SPEC.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
