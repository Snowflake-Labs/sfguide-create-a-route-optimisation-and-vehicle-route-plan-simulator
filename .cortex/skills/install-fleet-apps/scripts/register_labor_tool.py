#!/usr/bin/env python3
"""Register query_labor (SV_LABOR) on the agent specs that should see it.

Why a script and not a hand edit: the consumer spec is the INPUT to
build_super_agent_spec.py, its instructions block is a single long string that a
text edit corrupts easily, and check_agent_verb_coverage.py fails the build if a
tool is visible to an agent with no routing line telling it when to prefer that
tool. Doing all three in one place keeps them consistent.

Idempotent: re-running exits without changes once query_labor is present.
"""
import json
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "fleet_sa_app" / "app"

TOOL_NAME = "query_labor"
SEMANTIC_VIEW = "FLEET_INTELLIGENCE.SEMANTIC.SV_LABOR"

DESCRIPTION = (
    "Labour and overtime analytics: paid hours per operator per payroll week, the "
    "projection to week end, overtime hours and estimated overtime cost, plus "
    "productivity per paid hour (km and stops) and team/supervisor rollups. Use for "
    "'who is projected to exceed 60 hours this week', 'who is approaching overtime', "
    "'what will overtime cost us', 'which team or depot has the most overtime', "
    "'who should I call about overtime', 'how many hours has this operator worked', "
    "'is our overtime coming from one shift pattern', 'how productive are we per paid "
    "hour'. CRITICAL: use projected_week_hours for any 'will exceed' question, NOT "
    "hours_to_date - mid-week every operator is still under the limit, so hours_to_date "
    "can never surface anyone in time to act. Filter is_current_week = TRUE for the "
    "week a projection is meaningful for. Thresholds are DATA (ot_threshold_1/2/3), not "
    "a fixed 40/50/60, because the defaults are US FLSA and other jurisdictions differ. "
    "Hours are derived from real recorded trips, but pay rates, team and supervisor are "
    "synthesized, so qualify any MONEY figure and do not qualify the hours."
)

# One routing line per agent that can see the tool. check_agent_verb_coverage.py
# requires guidance to exist, and the documented failure this prevents is run_sql
# being preferred over a query_* tool, which silently bypasses the governed
# semantic-view path.
ORCHESTRATION = (
    "\n- Labour, hours worked, overtime, or workforce cost questions ('who is close to "
    "overtime', 'who will pass 50 or 60 hours', 'what is overtime costing', 'which depot "
    "has the most overtime', 'productivity per paid hour') -> use query_labor. Prefer it "
    "over run_sql: it models the whole labour layer. Answer 'will exceed' with "
    "projected_week_hours (not hours_to_date, which is mid-week and always under the "
    "limit) and filter is_current_week = TRUE. Read ot_threshold_1/2/3 from the data "
    "rather than assuming 40/50/60. State that overtime COST rests on synthesized pay "
    "rates; the HOURS come from real trips and need no caveat. For a visual, the "
    "Labour and Overtime view is the at-risk leaderboard - use deep_link to it."
)

SPECS = {
    # Consumer agent: the labour view is a consumer-facing analytics surface.
    "agent-spec.json": True,
    # Ops agent: a supervisor chasing overtime is an operational task.
    "ops-agent-spec.json": True,
    # Admin agent deliberately EXCLUDED. It exists for deployment and service
    # lifecycle work; adding an analytics tool there widens its surface for no
    # benefit and muddies the role split (Tenet 3).
}


def patch(path: Path) -> str:
    spec = json.loads(path.read_text())

    names = [t["tool_spec"]["name"] for t in spec.get("tools", [])]
    if TOOL_NAME in names:
        return "already present"

    # Insert next to the other analytics tools rather than appending after the
    # search/chart tools, so the spec stays readable.
    tool = {
        "tool_spec": {
            "type": "cortex_analyst_text_to_sql",
            "name": TOOL_NAME,
            "description": DESCRIPTION,
        }
    }
    last_analyst = max(
        (i for i, t in enumerate(spec["tools"])
         if t["tool_spec"]["type"] == "cortex_analyst_text_to_sql"),
        default=len(spec["tools"]) - 1,
    )
    spec["tools"].insert(last_analyst + 1, tool)

    # Mirror the execution environment of a sibling analyst tool rather than
    # hardcoding a warehouse name, so this follows the spec it is patching.
    sibling = None
    for t in spec["tools"]:
        n = t["tool_spec"]["name"]
        if t["tool_spec"]["type"] == "cortex_analyst_text_to_sql" and n in spec.get("tool_resources", {}):
            sibling = spec["tool_resources"][n]
            break
    if sibling is None:
        raise SystemExit(f"{path.name}: no sibling analyst tool_resources to mirror")

    res = {"semantic_view": SEMANTIC_VIEW}
    if "execution_environment" in sibling:
        res["execution_environment"] = json.loads(json.dumps(sibling["execution_environment"]))
    spec.setdefault("tool_resources", {})[TOOL_NAME] = res

    instr = spec.get("instructions", {})
    key = "orchestration" if "orchestration" in instr else None
    if key is None:
        raise SystemExit(f"{path.name}: no instructions.orchestration to extend")
    if "query_labor" not in instr[key]:
        instr[key] = instr[key].rstrip() + ORCHESTRATION
    spec["instructions"] = instr

    path.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n")
    return "patched"


def main() -> int:
    for name in SPECS:
        p = APP / name
        if not p.exists():
            print(f"SKIP {name} (not found)")
            continue
        print(f"{name}: {patch(p)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
