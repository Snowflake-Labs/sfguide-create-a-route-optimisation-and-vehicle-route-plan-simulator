#!/usr/bin/env python3
"""build_super_agent_spec.py - generate super-agent-spec.json from agent-spec.json.

WHY THIS IS GENERATED
---------------------
FLEET_SUPER_AGENT is the consumer agent PLUS the ops and admin tool bundles: the
same analytics tools, the same Cortex Search services, the same response and
orchestration instructions, with all three MCP servers attached and the
operator/installer guidance appended.

Hand-maintaining a second 12,000-character copy of those instructions guarantees
drift - the two would disagree within a release, and the disagreement would be
invisible until an agent answered differently depending on which one a user
picked. So the super spec is derived from the consumer spec at build time and the
consumer spec stays the single source for everything they share.

Tenet 3 is preserved where it matters: this only produces a SPEC. The isolation
boundary is the GRANT, and role_binding.sql grants FLEET_SUPER_AGENT to
FLEET_APP_ADMIN only - never to FLEET_APP_USER - so an app user still cannot
suspend a service or drop a region.

USAGE
  python3 build_super_agent_spec.py            # rewrite super-agent-spec.json
  python3 build_super_agent_spec.py --check    # fail if the committed file is stale
  python3 build_super_agent_spec.py --stdout
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

APP_DIR = pathlib.Path(__file__).resolve().parents[1] / "fleet_sa_app" / "app"
SOURCE = APP_DIR / "agent-spec.json"
OUT = APP_DIR / "super-agent-spec.json"

MCP_SERVERS = [
    "OPENROUTESERVICE_APP.ROUTING.ROUTING_MCP",
    "FLEET_INTELLIGENCE.SYNAPSE_OPS.FLEET_OPS_MCP",
    "FLEET_INTELLIGENCE.SYNAPSE_ADMIN.FLEET_ADMIN_MCP",
]

# Appended to instructions.response. Covers what the consumer agent never had to
# know: that it can now change the platform, and what that obliges it to do.
RESPONSE_SUFFIX = (
    " YOU ARE THE SUPERUSER ASSISTANT. Unlike the Fleet Intelligence assistant you also hold the "
    "OPERATOR and INSTALLER tools, so you can suspend and resume services, set the active region "
    "and dashboard context, activate a dataset, build and delete routing regions, change cost and "
    "hibernate settings, scale services, and verify the substrate. Never hand a user off to "
    "another assistant: you have every tool, so answer the whole question. "
    "CONFIRM BEFORE YOU CHANGE ANYTHING. For any action that suspends, deletes, scales, or "
    "commits hours of compute - service_control SUSPEND, cost_control cost_safe_mode, "
    "cost_control scale, drop_region, provision_region - first state in one line exactly which "
    "object you will act on and what the user will notice, then wait for explicit agreement. Do "
    "not infer agreement from an earlier turn or from enthusiasm; a user asking 'can you suspend "
    "things?' is asking about capability, not issuing an instruction. drop_region and provision "
    "additionally require you to name the cost of reversing it: a deleted region needs another "
    "multi-hour graph build. "
    "ASYNCHRONOUS WORK IS NOT FINISHED WORK. provision_region returns a job id and nothing more. "
    "Report that a build STARTED, give the job id and the expected duration, and say plainly that "
    "the region cannot be used for routing until it completes; then offer to check region_status. "
    "Never describe a launched build as ready, available, or done. "
    "SUSPENDED IS NORMAL. A service or region reading SUSPENDED is the ordinary idle state, not a "
    "fault - say so and offer to resume it rather than reporting a problem. A service showing "
    "AUTO_SUSPEND_SECS=0 while running is also expected: an active build or the keep-warm window "
    "is deliberately holding it up. "
    "PREFER THE GOVERNED PATH FOR DATA. When a question is answerable by one of the query_* "
    "Cortex Analyst tools, use that tool - it is the modelled, governed route. Reach for run_sql "
    "only when no semantic view covers the data (for example safety events, work items, region or "
    "dataset inventory), or for a precise lookup. run_sql is read-only and will refuse anything "
    "that writes; if it refuses, do not try to work around it. Call describe_data when you need "
    "to know what tables, views, semantic views or marketplace listings exist rather than "
    "guessing from memory. If run_sql reports truncated=true, say the result was capped instead of "
    "presenting a partial answer as complete. "
    "MAPS. You cannot render a map outside the app. For a question that is really about a map, a "
    "route, a catchment or a heatmap, give the numbers you can retrieve and then use deep_link to "
    "hand over a URL that opens the actual view with the region and selection applied. Never "
    "describe map contents as though you had seen them, and never assemble an app URL yourself. "
    "DATASET GENERATION IS NOT AVAILABLE AS A TOOL. It runs in the admin app Data Studio, not in "
    "SQL. If asked to generate one, say that and point at the admin app; use list_datasets and "
    "activate_dataset for the datasets that already exist."
)

ORCHESTRATION_SUFFIX = (
    "\n\nOPERATOR AND INSTALLER TOOL ROUTING (superuser only):\n"
    "- 'suspend/resume <service>', 'stop spend', 'wake the routing service' -> service_control "
    "(exact service name + SUSPEND|RESUME). Confirm first.\n"
    "- 'what is running', 'service status', 'list services and pools' -> service_inventory, or "
    "service_status for one named service.\n"
    "- 'is the platform healthy' -> healthcheck; 'what is installed / which regions / what is the "
    "active region' -> describe_deployment; 'is the substrate complete' -> check_substrate (report "
    "incomplete ONLY when it returns ok=false, and quote its notes).\n"
    "- 'switch the active region' -> set_active_region; 'switch the dashboard region or asset "
    "mode' -> set_active_context.\n"
    "- 'is region X ready', 'how is the build going', 'which regions do we have' -> region_status "
    "(read-only, never wakes a service).\n"
    "- 'add/build region X' -> provision_region. Confirm the region and compute size first, then "
    "report a STARTED job with its id and duration, never a ready region.\n"
    "- 'delete/remove region X' -> drop_region with confirm=true, only after explicit agreement. "
    "It refuses the active region; switch with set_active_region first.\n"
    "- 'what datasets exist', 'which dataset is active' -> list_datasets; 'make dataset X active' "
    "-> activate_dataset. There is NO generation tool.\n"
    "- 'what is this costing', 'hibernate settings' -> cost_control action=status (read-only). "
    "'stop all spend now' -> action=cost_safe_mode; 'bring it back' -> action=resume_fleet; "
    "'turn auto-hibernate on/off' -> action=set_hibernate; 'scale up/down' -> action=scale (all "
    "three counts required). Everything except status needs confirmation.\n"
    "- 'which verbs failed', 'show the audit trail' -> recent_verb_attempts.\n"
    "\nDATA ACCESS ROUTING:\n"
    "- 'what tables/data/listings/semantic views does this use', 'what columns are in X' -> "
    "describe_data (metadata only, always safe).\n"
    "- a question no semantic view models, or an exact lookup -> run_sql (read-only, single "
    "statement, capped). Prefer a query_* tool whenever one fits.\n"
    "- backload offers, idle trailers, accepted match decisions, deadhead and net benefit history "
    "-> query_backload. It does NOT hold a live solved plan.\n"
    "- marketplace offers, market-rate position, partner trust and lane reliability -> "
    "query_offers (only where the marketplace layer is installed).\n"
    "\nVISUAL HANDOVER:\n"
    "- any map/route/catchment/heatmap question when you have no panel context -> answer with "
    "figures, then deep_link(view_id, region, ...) for the link. Get the view_id from "
    "search_solution_catalog or list_use_cases; never invent one and never build the URL yourself."
)

SAMPLE_QUESTIONS = [
    {"question": "What use cases can you show me?"},
    {"question": "What tables, semantic views and marketplace listings does this deployment use?"},
    {"question": "Which services are running right now, and is anything suspended?"},
    {"question": "Is routing ready for the active region?"},
    {"question": "Which regions do we have, and is any build in flight?"},
    {"question": "What datasets exist, and which one is active?"},
    {"question": "What is this environment costing, and is auto-hibernate on?"},
    {"question": "Suspend everything so we stop accruing cost."},
    {"question": "Show me dwell time by facility for the active region."},
    {"question": "How many safety events were there by type? Use SQL if no semantic view has it."},
    {"question": "Give me a link to the Delivery Sync map for Europe."},
    {"question": "Which verb calls failed recently?"},
]


def build(source: pathlib.Path) -> dict:
    spec = json.loads(source.read_text())

    instructions = dict(spec.get("instructions") or {})
    response = str(instructions.get("response") or "").rstrip()
    orchestration = str(instructions.get("orchestration") or "").rstrip()

    instructions["response"] = response + " " + RESPONSE_SUFFIX.strip()
    instructions["orchestration"] = orchestration + ORCHESTRATION_SUFFIX
    instructions["sample_questions"] = SAMPLE_QUESTIONS

    out = {
        "models": spec.get("models") or {"orchestration": "auto"},
        "instructions": instructions,
        # Same native tools as the consumer agent: the analytics reach is
        # identical, only the MCP surface widens.
        "tools": spec.get("tools") or [],
        "tool_resources": spec.get("tool_resources") or {},
        "mcp_servers": [{"server_spec": {"name": n}} for n in MCP_SERVERS],
    }
    return out


def render(spec: dict) -> str:
    header = spec  # JSON has no comments; provenance lives in the generator + docs.
    return json.dumps(header, indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate super-agent-spec.json.")
    ap.add_argument("--source", default=str(SOURCE))
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--stdout", action="store_true")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    source = pathlib.Path(args.source)
    if not source.exists():
        print(f"FAIL: {source} does not exist", file=sys.stderr)
        return 1

    text = render(build(source))

    # ASCII hyphens only (AGENTS.md). Catch it here rather than in review.
    for dash, name in (("\u2013", "en dash"), ("\u2014", "em dash")):
        if dash in text:
            print(f"FAIL: generated spec contains a {name}", file=sys.stderr)
            return 1

    out_path = pathlib.Path(args.out)
    if args.stdout:
        sys.stdout.write(text)
        return 0
    if args.check:
        if not out_path.exists():
            print(f"FAIL: {out_path} does not exist - run build_super_agent_spec.py", file=sys.stderr)
            return 1
        if out_path.read_text() != text:
            print(
                f"FAIL: {out_path} is stale vs agent-spec.json - run "
                "python3 .cortex/skills/install-fleet-apps/scripts/build_super_agent_spec.py",
                file=sys.stderr,
            )
            return 1
        print("OK: super agent spec current")
        return 0

    out_path.write_text(text)
    print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
