#!/usr/bin/env python3
"""build_cowork_skills.py - generate one CoWork agent skill per SA app use case.

WHY THIS EXISTS
---------------
A Cortex Agent skill is a folder with a SKILL.md that the orchestrator matches by
name and description, retrieving the full instructions only when it fires. That
is exactly the shape of a demo use case: a named, repeatable workflow with a
business question, the right tool, the dimensions that must be filtered, and the
traps that make an answer wrong.

Before this, every one of those was reachable only as prose buried in one 26 KB
orchestration string. The agent had to carry all of it on every turn, and a user
in CoWork had no way to ASK for a use case by name. Skills invert that: 26 short
descriptions in the prompt, and the detail loaded on demand - and CoWork exposes
each one under the `/` menu.

DERIVED, NOT AUTHORED
---------------------
The content comes from the same `useCase` (Tenet 10, Channel D) and
`agentKnowledge` (Channel C) blocks that build_view_catalog.py reads, so a skill
cannot drift from the view it describes. Reuse that loader rather than a second
parser: a divergence between the catalog and the skills would be invisible.

`--check` proves the committed folders are CURRENT. It cannot prove they are
CORRECT, same as the catalog builder.

USAGE
  python3 build_cowork_skills.py           # (re)write the skill folders
  python3 build_cowork_skills.py --check   # fail if committed copies are stale
"""

from __future__ import annotations

import argparse
import collections
import json
import pathlib
import shutil
import sys

import yaml

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from build_view_catalog import (  # noqa: E402
    APP_DIR,
    DEFAULT_CONFIG,
    DEFAULT_PACK_VIEWS,
    DEFAULT_VIEWS,
    load_views,
    rows_from,
)

OUT_DIR = APP_DIR / "cowork_skills"

# Where deploy_cowork_skills.sh uploads the folders. The agent spec references
# this path, so the two must agree; keep them in one place.
SKILL_STAGE = "FLEET_INTELLIGENCE.SEMANTIC.COWORK_SKILLS"

# Agents that get the skills. The consumer spec is the source; the super spec is
# generated from it and inherits the array (build_super_agent_spec.py passes
# `skills` through). The ops and admin agents are deliberately excluded: every
# skill is an ANALYTICS use case routed at a query_* tool those agents do not
# hold, so offering them would produce 26 descriptions the agent can match and
# then fail to execute.
SKILL_SPECS = ("agent-spec.json",)

# Verbs that are NOT semantic-view tools, so a skill must not tell the agent to
# chart their output: data_to_chart rejects an MCP tool result.
VERB_TOOLS = {
    "catchment",
    "backload_solve",
    "backload_chain_solve",
    "search_sap_binding",
}

# Per-verb usage notes appended to step 1.
#
# These live HERE, in the generator, because they were previously hand-appended
# to the GENERATED SKILL.md files - which meant the next regeneration by anyone
# silently deleted them, and nothing would have reported the loss: the files
# still parse, still describe the use case, and only the hard-won operational
# detail is gone. Anything a skill must say about calling a verb belongs in this
# map, never in the artifact.
TOOL_NOTES = {
    "backload_solve": (
        " If the question is about ONE NAMED VEHICLE, pass `trailer_id` (e.g. "
        "`V-DRI-00033`) - never `max_vehicles=1`, which returns the longest-idle "
        "vehicle and quietly answers about a different truck. `VEHICLE_NOT_FOUND` "
        "means that id is not among the region's idle vehicles: report the id, do "
        "not substitute another vehicle. `TIME_BUDGET_EXCEEDED` means the solve ran "
        "out of wall clock, which is a size problem - offer `trailer_id`, a single "
        "strategy, or a higher `time_budget_s`, and never report it as \"no "
        "backloads exist\". A `trailer_id` result is an ISOLATED optimum: it "
        "optimises that one vehicle, while the regional plan optimises across the "
        "fleet and can give the same vehicle a worse load (measured: 46.4 empty km "
        "/ $1,432 alone versus 895.2 empty km / $824 in the 20-vehicle regional "
        "plan). Present it as the best case for that truck in isolation, not as the "
        "dispatch decision."
    ),
}


def bullets(items: list[str], indent: str = "- ") -> str:
    return "\n".join(f"{indent}{i}" for i in items if str(i).strip())


def has_map(view: dict) -> bool:
    """Does this view actually render a map?

    Load-bearing: the deep_link step used to be emitted for every view, which
    told the agent that a pure chart-and-table view like Labour and Overtime was
    "inherently visual" and that it could not draw the map. Overclaiming a
    limitation is the same defect as overclaiming a capability - it pushes the
    agent to hand over a link when it could simply have answered.

    Code-registered pack views declare no areas (their component is TypeScript),
    so they are treated as visual: every one of them is a map or solver cockpit.
    """
    areas = view.get("areas")
    if not areas:
        return True
    # `areas` is a MAPPING of area name -> spec, not a list.
    specs = areas.values() if isinstance(areas, dict) else areas
    return any(
        str((s or {}).get("component", "")).lower() == "map"
        for s in specs
        if isinstance(s, dict)
    )


def skill_md(row: dict, visual: bool) -> str:
    view_id = row["view_id"]
    label = row["label"]
    tool = (row["preferred_tool"] or "").strip()
    is_verb = tool in VERB_TOOLS
    is_analyst = bool(tool) and not is_verb

    # The description is the ONLY thing the orchestrator sees until the skill
    # fires, so it has to carry the business question, not a restatement of the
    # title. Kept to one sentence plus the question.
    desc = (
        f"{row['headline']} Use for: {row['business_question']} "
        f"Covers the {label} use case of the Fleet Intelligence accelerator."
    )

    lines: list[str] = [
        "---",
        # Dumped by the YAML library, NOT hand-assembled. Every description here
        # contains "Use for: ", and `: ` inside an unquoted plain scalar is
        # illegal YAML - so the previous f-string form produced 26 SKILL.md files
        # whose front matter raised `mapping values are not allowed here` on every
        # one. That matters because the agent spec omits `description`, so
        # Snowflake reads it from THIS file, and the orchestrator selects a skill
        # on name and description alone. RULE F of check_cowork_surfaces.py only
        # grepped for the string "description:", which is present in all 26
        # broken files, so nothing caught it; that rule now parses.
        # default_flow_style=False keeps it block style; the wide `width` stops
        # PyYAML line-wrapping a long description into a continuation the reader
        # has to reassemble.
        yaml.safe_dump(
            {"name": view_id.replace("_", "-"), "description": desc},
            sort_keys=False,
            allow_unicode=True,
            width=10 ** 6,
        ).rstrip("\n"),
        "---",
        "",
        f"# {label}",
        "",
        f"**Business question.** {row['business_question']}",
        "",
    ]

    if row["audience"]:
        lines += [f"**Who asks it.** {', '.join(row['audience'])}", ""]

    lines += ["## How to answer", ""]

    if is_analyst:
        lines += [
            f"1. Use the `{tool}` Cortex Analyst tool. It is the governed path "
            f"for this question - do NOT reach for `run_sql` unless {tool} "
            "cannot express what was asked.",
        ]
    elif is_verb:
        lines += [
            f"1. Call the `{tool}` tool. Its result is an MCP tool result, so it "
            "CANNOT be charted: `data_to_chart` accepts only a Cortex Analyst or "
            "`run_sql` result. Present the figures as a markdown table instead."
            + TOOL_NOTES.get(tool, ""),
        ]
    else:
        lines += [
            "1. No semantic view models this use case: it is computed live in the "
            "app. Answer with whatever `run_sql` and the routing tools can "
            "retrieve, then hand over the app view with `deep_link` rather than "
            "describing a screen you cannot see.",
        ]

    lines += [
        "2. Scope the question before aggregating. This deployment holds EVERY "
        "loaded region and asset mode at once, so an unfiltered aggregate mixes "
        "them. `region` is the key (for example SanFrancisco); `region_label` or "
        "`city` is the readable form a person types. Say which slice you used.",
    ]

    if row["key_metrics"]:
        lines += [
            "3. Lead with these measures rather than inventing your own:",
            bullets(row["key_metrics"], "   - "),
        ]

    step = 4 if row["key_metrics"] else 3
    if visual:
        lines += [
            f"{step}. This use case is inherently visual in the app. Outside the app "
            f"you cannot draw its map: give the figures, then call "
            f"`deep_link(view_id=\"{view_id}\", region=...)` and offer the link. "
            "Never describe map contents as if you had seen them.",
            "",
        ]
    else:
        lines += [
            f"{step}. Answer with figures and a chart - this view has no map, so "
            "there is nothing you are unable to draw. Offer "
            f"`deep_link(view_id=\"{view_id}\", region=...)` only when the user "
            "wants to explore interactively.",
            "",
        ]

    if row["method"]:
        lines += ["## How the numbers are produced", "", row["method"], ""]

    if row["caveats"]:
        lines += [
            "## Caveats you MUST state",
            "",
            row["caveats"],
            "",
        ]

    if row["example_questions"]:
        lines += [
            "## Questions this skill covers",
            "",
            bullets(row["example_questions"]),
            "",
        ]

    if row["value_drivers"]:
        lines += [
            "## What the answer is worth",
            "",
            bullets(row["value_drivers"]),
            "",
        ]

    return "\n".join(lines).rstrip() + "\n"


def build(rows: list[dict], views: dict) -> dict[str, str]:
    return {
        r["view_id"]: skill_md(r, has_map(views.get(r["view_id"]) or {}))
        for r in rows
    }


def skills_array(view_ids: list[str]) -> list[dict]:
    """The `skills` block for the agent specification.

    Generated rather than hand-maintained: 26 entries that must match 26 folder
    names is precisely the list that goes stale silently, and a skill referencing
    a path that does not exist is a per-request failure.
    """
    return [
        {
            "name": vid.replace("_", "-"),
            "source": {"type": "STAGE", "path": f"@{SKILL_STAGE}/skills/{vid}"},
        }
        for vid in sorted(view_ids)
    ]


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate CoWork agent skills.")
    ap.add_argument("--views", default=str(DEFAULT_VIEWS))
    ap.add_argument("--pack-views", default=str(DEFAULT_PACK_VIEWS))
    ap.add_argument("--config", default=str(DEFAULT_CONFIG))
    ap.add_argument("--out", default=str(OUT_DIR))
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    rows = rows_from(
        pathlib.Path(args.views),
        pathlib.Path(args.config),
        pathlib.Path(args.pack_views),
    )
    want = build(
        rows,
        load_views(pathlib.Path(args.views), pathlib.Path(args.pack_views)),
    )
    out = pathlib.Path(args.out)

    if args.check:
        problems = []
        have = {p.parent.name for p in out.glob("*/SKILL.md")} if out.exists() else set()
        for extra in sorted(have - set(want)):
            problems.append(f"{extra}: skill folder exists for no view (stale)")
        for view_id, text in sorted(want.items()):
            f = out / view_id / "SKILL.md"
            if not f.exists():
                problems.append(f"{view_id}: SKILL.md missing")
            elif f.read_text() != text:
                problems.append(f"{view_id}: SKILL.md stale vs its useCase block")
        want_arr = skills_array(list(want))
        for spec_name in SKILL_SPECS:
            p = APP_DIR / spec_name
            got = (json.loads(p.read_text()) or {}).get("skills")
            if got != want_arr:
                problems.append(
                    f"{spec_name}: skills array is stale "
                    f"({len(got or [])} entry/entries, expected {len(want_arr)})"
                )
        if problems:
            print(
                "FAIL: CoWork skills are stale - run\n"
                "  python3 .cortex/skills/install-fleet-apps/scripts/build_cowork_skills.py\n  - "
                + "\n  - ".join(problems),
                file=sys.stderr,
            )
            return 1
        print(f"OK: {len(want)} CoWork skill(s) current")
        return 0
    # Rewrite wholesale so a renamed or deleted view cannot leave an orphan skill
    # the agent would still match against.
    if out.exists():
        shutil.rmtree(out)
    for view_id, text in want.items():
        d = out / view_id
        d.mkdir(parents=True, exist_ok=True)
        (d / "SKILL.md").write_text(text)

    # Keep the agent spec's skills array in lockstep with the folders on disk.
    arr = skills_array(list(want))
    for spec_name in SKILL_SPECS:
        p = APP_DIR / spec_name
        spec = json.loads(p.read_text(), object_pairs_hook=collections.OrderedDict)
        spec["skills"] = arr
        p.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n")

    print(
        f"wrote {len(want)} CoWork skill(s) to {out} and "
        f"{len(arr)} skills entry/entries into {', '.join(SKILL_SPECS)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
