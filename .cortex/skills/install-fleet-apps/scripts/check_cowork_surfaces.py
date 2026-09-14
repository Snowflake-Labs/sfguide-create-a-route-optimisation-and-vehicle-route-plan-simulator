#!/usr/bin/env python3
"""check_cowork_surfaces.py - assert the CoWork-facing surfaces are wired.

WHY A GATE
----------
Every failure in this class is SILENT. An agent with no sandbox tool answers
normally and simply cannot produce a file; a semantic view with no verified query
answers normally and just regenerates SQL every time; a skill whose stage path is
wrong is listed by the agent and fails only when a user picks it; a
chart_customization block with a broken vega_template is merged into every chart
and Vega-Lite reports nothing. Nothing fails, so nothing tells you.

WHAT IS CHECKED
---------------
RULE A  Every agent spec declares the code_execution tool AND its tool_resources
        entry. Declaring the tool without the resource entry does not enable it.
RULE B  Every spec's chart_customization block parses as JSON and uses only CSS
        generic font families. A named font (Arial, Georgia) is not installed in
        the server-side render container, so the chart silently falls back.
RULE C  The chart_customization block sits in its OWN section. Appending it to
        whichever section happens to be last is a real bug that has already
        happened twice here: it silently rewrote a neighbouring section and the
        super-spec twin assertion, not this gate, caught it.
RULE D  Every verified query in verified_queries.py appears in the DDL, and every
        semantic view named there carries an AI_VERIFIED_QUERIES clause.
RULE E  Every skill in the agent spec's `skills` array has a SKILL.md on disk at
        the path the array points at, and every SKILL.md on disk is referenced.
        A dangling reference fails per request; an unreferenced folder is dead
        weight nobody will notice.
RULE F  Each SKILL.md has YAML front matter that PARSES, carrying a non-empty name
        and description, with the name agreeing with the agent spec entry. The
        orchestrator matches on those two fields alone, so a skill missing either
        can never be selected.

        This rule used to substring-grep for "description:" and passed 26 files
        whose front matter did not parse at all: the generated description
        contains "Use for: ", and `: ` in an unquoted plain scalar is illegal
        YAML. The field name was spelled correctly in every broken file. Since
        the agent spec omits `description`, Snowflake reads it from the file - so
        the one signal the orchestrator selects on was unreadable for every
        CoWork skill, and only the skill evals noticed, as an unexplained empty
        `name`. Parse it; do not look for the word.

Read-only, no Snowflake connection needed. Run from anywhere.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

import yaml

SKILL = pathlib.Path(__file__).resolve().parents[1]
APP = SKILL / "fleet_sa_app" / "app"
SCRIPTS = SKILL / "scripts"

SPECS = ("agent-spec.json", "ops-agent-spec.json", "admin-agent-spec.json",
         "super-agent-spec.json")

# Only these resolve in BOTH the browser and the server-side Linux render
# container. A named font renders differently in each, or not at all.
GENERIC_FONTS = {"sans-serif", "serif", "monospace", "cursive", "fantasy",
                 "system-ui"}

CHART_SECTION = "CHART CUSTOMIZATION"


def load_spec(name: str) -> dict:
    return json.loads((APP / name).read_text())


def check_sandbox(problems: list[str]) -> None:
    for name in SPECS:
        spec = load_spec(name)
        tools = {
            t.get("tool_spec", {}).get("name")
            for t in spec.get("tools") or []
        }
        if "code_execution" not in tools:
            problems.append(
                f"RULE A {name}: no code_execution tool. CoWork document "
                f"generation (PDF, PowerPoint) requires a sandbox tool on the "
                f"agent; without it the agent cannot produce a file at all.")
        res = (spec.get("tool_resources") or {}).get("code_execution")
        if res is None:
            problems.append(
                f"RULE A {name}: code_execution has no tool_resources entry. "
                f"The tool is enabled by the resources block, not by the tool "
                f"declaration alone.")
        elif not (res.get("permission_policy") or {}).get("type"):
            problems.append(
                f"RULE A {name}: code_execution has no permission_policy.type. "
                f"State always_ask or always_allow explicitly rather than "
                f"relying on a default that could change.")


def chart_blocks(orch: str) -> list[str]:
    return re.findall(r"<chart_customization>(.*?)</chart_customization>", orch,
                      re.S)


def check_charts(problems: list[str]) -> None:
    for name in SPECS:
        orch = (load_spec(name).get("instructions") or {}).get("orchestration") or ""
        blocks = chart_blocks(orch)
        if not blocks:
            problems.append(
                f"RULE B {name}: no <chart_customization> block. CoWork then "
                f"picks its own palette and chart types, so the same question "
                f"looks different in the app and in CoWork.")
            continue
        if len(blocks) > 1:
            problems.append(
                f"RULE B {name}: {len(blocks)} chart_customization blocks. Each "
                f"is merged into every chart, so a duplicate applies twice.")
        for block in blocks:
            m = re.search(r"vega_template:\s*(\{.*\})\s*$", block.strip(), re.S)
            if not m:
                continue  # free-text only is legal
            try:
                tmpl = json.loads(m.group(1))
            except json.JSONDecodeError as e:
                problems.append(
                    f"RULE B {name}: vega_template is not valid JSON ({e}). The "
                    f"merge engine cannot apply it and says nothing.")
                continue
            for path, value in walk_fonts(tmpl.get("config") or {}):
                if value not in GENERIC_FONTS:
                    problems.append(
                        f"RULE B {name}: config.{path} = {value!r} is not a CSS "
                        f"generic family. Named fonts are absent from the "
                        f"server-side render container. Use one of "
                        f"{sorted(GENERIC_FONTS)}.")

        # RULE C: its own section, so an append cannot absorb it.
        for line in orch.split("\n"):
            if line.startswith(CHART_SECTION) and ":" in line:
                break
        else:
            problems.append(
                f"RULE C {name}: the chart_customization block has no "
                f"'{CHART_SECTION}...:' section header of its own, so it is part "
                f"of whichever section precedes it and any append to that "
                f"section edits it.")


def walk_fonts(node, prefix: str = ""):
    if isinstance(node, dict):
        for k, v in node.items():
            p = f"{prefix}.{k}" if prefix else k
            if isinstance(v, (dict, list)):
                yield from walk_fonts(v, p)
            elif "font" in k.lower() and isinstance(v, str) and not v.isdigit():
                # fontSize / fontWeight are not families; only *ont == family.
                if k.lower() in ("font", "labelfont", "titlefont"):
                    yield p, v


def check_verified_queries(problems: list[str]) -> None:
    sys.path.insert(0, str(SCRIPTS))
    try:
        from verified_queries import VQRS
    except Exception as e:  # noqa: BLE001
        problems.append(f"RULE D: cannot import verified_queries.py ({e})")
        return

    ddl = "\n".join(
        p.read_text() for p in APP.glob("semantic_views*.sql")
    )
    for view, (vqr_name, question, _onb, _sql) in VQRS.items():
        create = f"CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.SEMANTIC.{view}\n"
        if create not in ddl:
            problems.append(
                f"RULE D {view}: verified_queries.py names a view with no CREATE "
                f"in any semantic_views*.sql")
            continue
        start = ddl.index(create)
        end = ddl.index("\n;\n", start)
        body = ddl[start:end]
        if "AI_VERIFIED_QUERIES" not in body:
            problems.append(
                f"RULE D {view}: no AI_VERIFIED_QUERIES clause, so CoWork "
                f"regenerates SQL for its headline question on every ask")
        elif vqr_name.upper() not in body.upper():
            problems.append(
                f"RULE D {view}: AI_VERIFIED_QUERIES does not contain "
                f"{vqr_name!r} - verified_queries.py and the DDL have diverged")


def check_skills(problems: list[str]) -> None:
    spec = load_spec("agent-spec.json")
    arr = spec.get("skills") or []
    if not arr:
        problems.append(
            "RULE E agent-spec.json: no skills array. The use cases are then "
            "reachable only as prose in the orchestration string and cannot be "
            "invoked by name in CoWork.")
        return

    out_dir = APP / "cowork_skills"
    on_disk = {p.parent.name for p in out_dir.glob("*/SKILL.md")}
    referenced = set()

    for entry in arr:
        path = ((entry.get("source") or {}).get("path") or "")
        m = re.search(r"/skills/([A-Za-z0-9_-]+)/?$", path)
        if not m:
            problems.append(
                f"RULE E agent-spec.json: skill {entry.get('name')!r} has an "
                f"unparseable stage path {path!r}")
            continue
        folder = m.group(1)
        referenced.add(folder)
        md = out_dir / folder / "SKILL.md"
        if not md.exists():
            problems.append(
                f"RULE E {entry.get('name')}: spec points at /skills/{folder} "
                f"but {md.relative_to(SKILL)} does not exist. A dangling skill "
                f"reference fails only when a user picks it.")
            continue
        # Front matter is the FENCED block at the top of the file, matched as a
        # fence rather than `text.split("---")` - a body containing a horizontal
        # rule would otherwise silently shift which chunk is inspected.
        fence = re.match(r"^---\n(.*?)\n---", md.read_text(), re.S)
        if not fence:
            problems.append(
                f"RULE F {folder}: SKILL.md has no YAML front matter block. The "
                f"orchestrator matches on name and description alone, so this "
                f"skill can never be selected.")
            continue
        front = fence.group(1)
        # PARSED, not grepped. This rule used to test `"description:" in front`,
        # and it PASSED on 26 files whose front matter did not parse at all: the
        # generated description contains "Use for: ", and `: ` in an unquoted
        # plain scalar is illegal YAML. The field name was spelled correctly in
        # every broken file, so the substring form could not see it. Only the
        # skill evals noticed, as an unexplained empty `name`.
        try:
            fm = yaml.safe_load(front)
        except yaml.YAMLError as exc:
            first = str(exc).splitlines()[0]
            problems.append(
                f"RULE F {folder}: SKILL.md front matter is not valid YAML "
                f"({first}). Snowflake reads the description from this file "
                f"because the agent spec omits it, and the orchestrator selects "
                f"on name and description alone - so an unparseable block makes "
                f"the skill unselectable. A description containing ': ' must be "
                f"quoted; emit front matter with yaml.safe_dump, never an "
                f"f-string.")
            continue
        if not isinstance(fm, dict):
            problems.append(
                f"RULE F {folder}: SKILL.md front matter is not a YAML mapping "
                f"(got {type(fm).__name__}).")
            continue
        for field in ("name", "description"):
            value = fm.get(field)
            if not isinstance(value, str) or not value.strip():
                problems.append(
                    f"RULE F {folder}: SKILL.md front matter has no usable "
                    f"{field} - the orchestrator matches on name and "
                    f"description alone, so this skill can never be selected.")
        expected_name = entry.get("name")
        actual_name = fm.get("name")
        if isinstance(actual_name, str) and expected_name and actual_name != expected_name:
            problems.append(
                f"RULE F {folder}: SKILL.md name {actual_name!r} does not match "
                f"the agent spec entry {expected_name!r}. The spec name is what "
                f"a user picks from the CoWork '/' menu; a mismatch makes the "
                f"two surfaces disagree about what the skill is called.")

    for orphan in sorted(on_disk - referenced):
        problems.append(
            f"RULE E {orphan}: SKILL.md exists but no agent spec references it")


def main() -> int:
    problems: list[str] = []
    check_sandbox(problems)
    check_charts(problems)
    check_verified_queries(problems)
    check_skills(problems)

    if problems:
        print("FAIL: CoWork surfaces are not fully wired:\n  - "
              + "\n  - ".join(problems), file=sys.stderr)
        return 1

    spec = load_spec("agent-spec.json")
    sys.path.insert(0, str(SCRIPTS))
    from verified_queries import VQRS
    print(
        f"check_cowork_surfaces: OK ({len(SPECS)} spec(s) with a sandbox tool "
        f"and a chart_customization block, {len(VQRS)} verified query/queries, "
        f"{len(spec.get('skills') or [])} agent skill(s))"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
