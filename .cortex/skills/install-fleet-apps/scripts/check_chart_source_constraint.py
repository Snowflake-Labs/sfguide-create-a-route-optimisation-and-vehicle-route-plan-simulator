#!/usr/bin/env python3
"""Fail when an agent spec offers data_to_chart without naming what it accepts.

Why this exists
---------------
`data_to_chart` and `data_to_map` are HOST-INJECTED tools, not synapse verbs, and
both accept only a SQL or Cortex Analyst result as `tool_result_id`. A result from
an MCP verb is rejected. The specs documented that constraint for `data_to_map` in
detail and said NOTHING about it for `data_to_chart`, whose description read
"Generates visualizations from tabular data returned by the analytics tools" - which
an orchestrator reasonably reads as including every analytics-shaped verb result.

The measured failure was a turn that produced NO ANSWER AT ALL. In
CORTEX_AGENT_USAGE_HISTORY, request 3716bbf0-ea86-406e-a5c2-e6131df7a8c2 ran 125 s
over about five orchestration steps for 299,169 input tokens and emitted 3,979
output tokens, none of them prose: `backload_solve` returned 20 graded proposals,
the host's chart guidance ("a chart is MANDATORY for 2+ rows with numeric metrics")
pushed the agent at `data_to_chart`, the only available `tool_result_id` belonged to
an MCP result, and the turn ended empty. The user saw a successful tool call and a
blank reply. A missing sentence, not a broken tool.

That is why this is a gate and not a review note. The constraint lives in prose
inside a single-line JSON string that four specs share and several workstreams edit;
`build_super_agent_spec.py --check` proves the super spec is CURRENT, not that it is
CORRECT, and nothing else reads these strings. Deleting the sentence breaks no test,
fails no build, and produces no error at runtime - it produces silence.

What it checks
--------------
For every ``*agent-spec.json`` in ``fleet_sa_app/app/`` that declares a
``data_to_chart`` tool:

1. The tool DESCRIPTION names the accepted sources, so a spec cannot go back to the
   vague "the analytics tools" wording that caused this.
2. The ORCHESTRATION states that an MCP verb result is not accepted.
3. Where the spec also offers a map tool, the sibling ``data_to_map`` source
   sentence is still present. The chart rule was written by copying it; a future
   edit must not be able to delete the original and leave the copy stranded.

Checks are keyed on normalised prose fragments rather than exact strings, so an
author may rewrite the surrounding sentence freely as long as the constraint
survives. Run with no arguments; exits non-zero with the offending file and a
description of what is missing.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

APP_DIR = pathlib.Path(__file__).resolve().parent.parent / "fleet_sa_app" / "app"

CHART_TOOL = "data_to_chart"
MAP_TOOL = "data_to_map"

# The vague description this gate exists to prevent coming back.
BANNED_DESCRIPTION = "tabular data returned by the analytics tools"


def norm(text: str) -> str:
    """Lowercase and collapse whitespace, so a rewrapped sentence still matches."""
    return re.sub(r"\s+", " ", (text or "")).lower()


def says_accepted_sources(text: str) -> bool:
    """True when the text names BOTH accepted sources by name."""
    t = norm(text)
    analyst = "query_*" in t or "cortex analyst" in t
    return analyst and "run_sql" in t


def says_mcp_rejected(text: str) -> bool:
    """True when the text states an MCP result is not accepted.

    Accepts the several honest phrasings ("is NOT accepted", "cannot be charted",
    "is rejected") so the wording can evolve, but requires the word `mcp` nearby
    rather than anywhere in a 20 KB string: a spec that merely mentions MCP servers
    elsewhere must not pass.
    """
    t = norm(text)
    for m in re.finditer(r"mcp", t):
        window = t[m.start(): m.start() + 400]
        if re.search(r"not accepted|cannot be charted|is rejected|not be attempted", window):
            return True
    return False


def states_rule_beside_the_tool(orchestration: str) -> bool:
    """True when ONE passage next to a data_to_chart mention carries the whole rule.

    Adjacency is the point. An earlier draft of this gate only asked whether the
    orchestration said "MCP ... is rejected" ANYWHERE, and it passed a spec whose
    dedicated chart section had been deleted, because a sentence about one specific
    verb ("this is an MCP verb result and charting one is rejected") satisfied it
    from several thousand characters away. A rule the reader has to assemble from
    two distant sentences, one of them scoped to a single verb, is not the rule.
    """
    t = norm(orchestration)
    for m in re.finditer(re.escape(CHART_TOOL), t):
        window = t[max(0, m.start() - 300): m.start() + 900]
        if says_accepted_sources(window) and says_mcp_rejected(window):
            return True
    return False


def dangling_chart_crossref(orchestration: str) -> bool:
    """True when the text points at a CHARTING section that no longer exists.

    Several passages say "see CHARTING" instead of restating the constraint. If the
    section is deleted those pointers go nowhere and the constraint is gone with it.
    """
    t = norm(orchestration)
    refers = re.search(r"see charting|\(see charting\b", t) is not None
    exists = re.search(r"^charting\b.*:", t, re.MULTILINE) is not None \
        or "charting (data_to_chart):" in t
    return refers and not exists


def main() -> int:
    specs = sorted(APP_DIR.glob("*agent-spec.json"))
    if not specs:
        print(f"FAIL: no agent specs found under {APP_DIR}")
        return 1

    problems: list[str] = []
    checked = 0

    for spec_path in specs:
        try:
            spec = json.loads(spec_path.read_text())
        except json.JSONDecodeError as exc:
            problems.append(f"{spec_path.name}: is not valid JSON ({exc})")
            continue

        tools = {
            t.get("tool_spec", {}).get("name"): t.get("tool_spec", {})
            for t in spec.get("tools", [])
        }
        if CHART_TOOL not in tools:
            continue

        checked += 1
        orchestration = spec.get("instructions", {}).get("orchestration", "")
        description = tools[CHART_TOOL].get("description", "")

        if BANNED_DESCRIPTION in norm(description):
            problems.append(
                f"{spec_path.name}: the {CHART_TOOL} description still says "
                f"{BANNED_DESCRIPTION!r}. That wording reads as 'any analytics-shaped "
                f"result', including MCP verb results, which the tool rejects. Name the "
                f"accepted sources instead.")
        elif not says_accepted_sources(description):
            problems.append(
                f"{spec_path.name}: the {CHART_TOOL} description does not name its "
                f"accepted sources. State that it charts results from the query_* "
                f"Cortex Analyst tools or run_sql.")

        if not states_rule_beside_the_tool(orchestration):
            problems.append(
                f"{spec_path.name}: the orchestration offers {CHART_TOOL} but no single "
                f"passage beside a {CHART_TOOL} mention both names its accepted sources "
                f"(query_* / run_sql) and says an MCP verb result is not accepted. "
                f"Without that the agent attempts the chart, the call is rejected, and "
                f"the turn can end with no prose at all.")

        if dangling_chart_crossref(orchestration):
            problems.append(
                f"{spec_path.name}: the orchestration points at a CHARTING section that "
                f"does not exist. Either restore the section or restate the constraint "
                f"where it is referenced.")

        if MAP_TOOL in tools or MAP_TOOL in orchestration:
            if not re.search(
                r"data_to_map accepts only a sql/analyst tool result", norm(orchestration)
            ):
                problems.append(
                    f"{spec_path.name}: the sibling {MAP_TOOL} source constraint is gone. "
                    f"The chart rule was derived from it; losing the original leaves maps "
                    f"open to exactly the failure the chart rule now prevents.")

    if problems:
        print("FAIL: agent specs offer data_to_chart without its source constraint:")
        for p in problems:
            print(f"  - {p}")
        return 1

    print(f"OK: {checked} spec(s) declaring {CHART_TOOL} state what it accepts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
