#!/usr/bin/env python3
"""build_super_agent_spec.py - generate super-agent-spec.json from agent-spec.json.

WHY THIS IS GENERATED
---------------------
FLEET_SUPER_AGENT is the consumer agent PLUS the ops and admin tool bundles: the
same analytics tools, the same Cortex Search services, the same response and
orchestration instructions, with all three MCP servers attached and the
operator/installer guidance appended.

Native tools are UNIONED across all three specs, not copied from the consumer
spec alone. The ops/admin specs carry a Cortex Analyst tool the consumer does not
(query_deployment over SV_FLEET_DEPLOYMENT, which models deployment history), and
a superuser that could not answer an operator's own question about the platform
would be a hole rather than a superset.

Hand-maintaining a second 12,000-character copy of those instructions guarantees
drift - the two would disagree within a release, and the disagreement would be
invisible until an agent answered differently depending on which one a user
picked. So the super spec is derived from the consumer spec at build time and the
consumer spec stays the single source for everything they share.

THE OPS/ADMIN ROUTING IS DERIVED TOO
------------------------------------
The operator and installer routing used to be a hand-written THIRD copy inside
this generator's ORCHESTRATION_SUFFIX, restating what the role specs already
said. That is the same drift trap the consumer half was built to avoid, and worse
here because `--check` only compares the generated file against this generator:
it can prove the output is current while the text itself has silently diverged
from ops-agent-spec.json. An edit to a role spec simply did not reach the super
agent, which is how `recent_verb_attempts` came to be documented in the SUPER
agent and not in the OPS agent that owns the verb.

So the per-verb routing sections are now lifted VERBATIM from the role specs by
section header (DERIVED_SECTIONS). What stays literal here is only what is
specific to being a superuser and exists in no role spec.

WHOLESALE CONCATENATION WOULD BE WRONG
--------------------------------------
A role spec is written for an agent with a NARROWER tool set, so some of its
sections are actively FALSE for the superuser and must not be inherited:

* ops and admin both end with "MAPS: you have no geospatial tool ... point them
  at the Fleet Intelligence assistant". The super agent HAS all 21 routing verbs
  and is that assistant, so inheriting this would make it refuse work it can do.
* admin's "HANDOFF (you cannot do these)" lists building regions, suspending
  services and changing cost settings as somebody else's job. The super agent
  holds every one of those verbs.

EXCLUDED_SECTIONS records each of those with its reason, and `derive_sections`
asserts that EVERY section in a role spec is either derived or excluded. A new
section added to a role spec therefore FAILS this build until someone decides
which it is - which is the property the old hand-written copy could never have.

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
import re
import sys

APP_DIR = pathlib.Path(__file__).resolve().parents[1] / "fleet_sa_app" / "app"
SOURCE = APP_DIR / "agent-spec.json"
OUT = APP_DIR / "super-agent-spec.json"

OPS_SPEC = "ops-agent-spec.json"
ADMIN_SPEC = "admin-agent-spec.json"

# Role-scoped specs whose NATIVE tools are folded in on top of the consumer spec.
EXTRA_TOOL_SOURCES = (OPS_SPEC, ADMIN_SPEC)

# A section header: a line beginning with a fully capitalised word and carrying a
# colon. Deliberately narrow so a continuation paragraph ("Known services live in
# ...") is treated as part of the section above it rather than starting a new one.
SECTION_RE = re.compile(r"^[A-Z]{2,}")

# Ops/admin orchestration sections lifted VERBATIM into the super spec, in this
# order. Keyed by the header text before its first colon.
DERIVED_SECTIONS: list[tuple[str, str]] = [
    (OPS_SPEC, "TOOL ROUTING (Ops verbs via FLEET_OPS_MCP)"),
    (ADMIN_SPEC, "ADMIN verbs (via FLEET_ADMIN_MCP)"),
    (OPS_SPEC, "REGION LIFECYCLE"),
    (OPS_SPEC, "DATASETS"),
    (OPS_SPEC, "COST AND SCALE"),
    (OPS_SPEC, "AUDIT TRAIL"),
    (OPS_SPEC, "DEPLOYMENT HISTORY (Cortex Analyst over SV_FLEET_DEPLOYMENT)"),
]

# Sections deliberately NOT inherited, each with the reason. Every section in a
# role spec must appear here or in DERIVED_SECTIONS, so adding a new one to a role
# spec fails the build until it is classified.
EXCLUDED_SECTIONS: dict[tuple[str, str], str] = {
    (OPS_SPEC, "MAPS"):
        "FALSE for the superuser: it says 'you have no geospatial tool' and hands "
        "off to the Fleet Intelligence assistant, but the super agent attaches "
        "ROUTING_MCP and IS that assistant. The VISUAL HANDOVER section below "
        "gives the correct rule.",
    (ADMIN_SPEC, "MAPS"):
        "Identical to the ops MAPS section and false for the same reason.",
    (ADMIN_SPEC, "HANDOFF (you cannot do these)"):
        "FALSE for the superuser: it routes region builds, service suspension, "
        "cost changes and dataset activation to another assistant, all of which "
        "the super agent can do itself. The response instructions tell it never "
        "to hand off.",
    (ADMIN_SPEC, "DEPLOYMENT HISTORY (Cortex Analyst over SV_FLEET_DEPLOYMENT)"):
        "Byte-identical to the ops copy, which is derived above; inheriting both "
        "would duplicate it in the prompt.",
    (ADMIN_SPEC, "TOOL ROUTING"):
        "A bare label with no body - it only introduces the ADMIN verbs section, "
        "which is derived above under its own header.",
    (ADMIN_SPEC, "SHARED READ-ONLY FACTS"):
        "describe_deployment routing that the derived ops TOOL ROUTING section "
        "already covers, and its closing 'resuming it is a Fleet Operations "
        "action' is a handoff the super agent must not make.",
    (ADMIN_SPEC, "CATALOG"):
        "search_solution_catalog is already routed by the consumer spec's own "
        "CATALOG section, which the super spec inherits wholesale.",
    (ADMIN_SPEC, "DATA INVENTORY"):
        "describe_data is routed by the DATA ACCESS ROUTING section below, which "
        "can state it unconditionally - the admin wording hedges with 'if it is "
        "available to you' because the admin bundle may lack the verb.",
}

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

ORCHESTRATION_PREAMBLE = (
    "\n\nOPERATOR AND INSTALLER TOOL ROUTING (superuser only). You hold the ops "
    "and installer verbs in addition to everything above, so the rules below "
    "apply to you directly - never hand any of them to another assistant:\n"
)

# Super-specific routing that exists in no role spec, so it stays literal here.
ORCHESTRATION_SUFFIX = (
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


def union_tools(spec: dict, extra_paths: list[pathlib.Path]) -> tuple[list, dict]:
    """Union native tools + tool_resources across the consumer and role specs.

    First definition wins, so the consumer spec's wording is authoritative for any
    tool the role specs also declare (search_solution_catalog, data_to_chart).
    """
    tools = list(spec.get("tools") or [])
    resources = dict(spec.get("tool_resources") or {})
    seen = {t["tool_spec"]["name"] for t in tools if "tool_spec" in t}

    for path in extra_paths:
        if not path.exists():
            continue
        extra = json.loads(path.read_text())
        for tool in extra.get("tools") or []:
            name = tool.get("tool_spec", {}).get("name")
            if not name or name in seen:
                continue
            tools.append(tool)
            seen.add(name)
            if name in (extra.get("tool_resources") or {}):
                resources[name] = extra["tool_resources"][name]
    return tools, resources


def split_sections(text: str) -> dict[str, str]:
    """Split an orchestration string into {header-before-colon: full section}.

    Order is preserved (dicts are insertion-ordered) so a caller can report the
    sections it found in the order an author wrote them.
    """
    sections: dict[str, list[str]] = {}
    key: str | None = None
    for line in text.split("\n"):
        if SECTION_RE.match(line) and ":" in line:
            key = line.split(":", 1)[0]
            sections[key] = [line]
        elif key is not None:
            sections[key].append(line)
    return {k: "\n".join(v).strip() for k, v in sections.items()}


def derive_sections(app_dir: pathlib.Path) -> str:
    """Lift the ops/admin routing sections verbatim, asserting full coverage."""
    parsed = {
        name: split_sections(
            json.loads((app_dir / name).read_text())
            .get("instructions", {})
            .get("orchestration", "")
        )
        for name in (OPS_SPEC, ADMIN_SPEC)
    }

    problems: list[str] = []

    # Every section in a role spec must be classified. This is the check that
    # makes the derivation trustworthy: without it, a new section added to a role
    # spec would be silently dropped from the super agent - the exact failure the
    # hand-written copy had.
    for name, sections in parsed.items():
        for key in sections:
            derived = (name, key) in DERIVED_SECTIONS
            excluded = (name, key) in EXCLUDED_SECTIONS
            if derived and excluded:
                problems.append(
                    f"{name}: section {key!r} is both derived and excluded")
            elif not derived and not excluded:
                problems.append(
                    f"{name}: section {key!r} is neither derived into the super "
                    f"spec nor excluded from it. Add it to DERIVED_SECTIONS (so "
                    f"the superuser inherits the guidance) or to "
                    f"EXCLUDED_SECTIONS with a reason (if it is false or "
                    f"redundant for an agent that holds every tool).")

    # And every classified section must still exist, so a renamed or deleted
    # header cannot leave the super spec quietly missing a block.
    for name, key in DERIVED_SECTIONS:
        if key not in parsed[name]:
            problems.append(
                f"{name}: DERIVED_SECTIONS names section {key!r}, which no "
                f"longer exists - it was renamed or removed, and the super "
                f"agent has lost that routing guidance.")
    for (name, key), reason in EXCLUDED_SECTIONS.items():
        if not str(reason).strip():
            problems.append(f"{name}: exclusion of {key!r} has no reason")
        if key not in parsed[name]:
            problems.append(
                f"{name}: EXCLUDED_SECTIONS names section {key!r}, which no "
                f"longer exists - drop the stale exclusion.")

    if problems:
        raise SystemExit(
            "FAIL: build_super_agent_spec cannot classify the role-spec "
            "orchestration:\n  - " + "\n  - ".join(problems))

    return "\n".join(parsed[name][key] for name, key in DERIVED_SECTIONS)


def build(source: pathlib.Path) -> dict:
    spec = json.loads(source.read_text())
    tools, resources = union_tools(
        spec, [source.parent / name for name in EXTRA_TOOL_SOURCES]
    )

    instructions = dict(spec.get("instructions") or {})
    response = str(instructions.get("response") or "").rstrip()
    orchestration = str(instructions.get("orchestration") or "").rstrip()

    instructions["response"] = response + " " + RESPONSE_SUFFIX.strip()
    instructions["orchestration"] = (
        orchestration
        + ORCHESTRATION_PREAMBLE
        + derive_sections(source.parent)
        + ORCHESTRATION_SUFFIX
    )
    instructions["sample_questions"] = SAMPLE_QUESTIONS

    out = {
        "models": spec.get("models") or {"orchestration": "auto"},
        "instructions": instructions,
        # Consumer tools plus any native tool only the ops/admin specs declare
        # (today: query_deployment). The MCP surface widens too, below.
        "tools": tools,
        "tool_resources": resources,
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
                f"FAIL: {out_path} is stale vs agent-spec.json, "
                f"{OPS_SPEC} or {ADMIN_SPEC} - run "
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
