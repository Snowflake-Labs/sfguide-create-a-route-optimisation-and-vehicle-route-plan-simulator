#!/usr/bin/env python3
"""Negative tests for check_chart_source_constraint.py - each case removes or
blurs the sentence that tells an agent data_to_chart accepts only a SQL or
Cortex Analyst result (the missing sentence behind the 125 s turn that ended
with no prose), and the gate must name the missing piece."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

APP = ".cortex/skills/install-fleet-apps/fleet_sa_app/app"
SECTION = "CHARTING (data_to_chart):\n"
NEXT_SECTION = "VISUAL HANDOVER ("
MCP_SENTENCE = ("An MCP tool result - backload_solve, backload_chain_solve, get_directions, "
                "or any synapse verb - is NOT accepted. Do not attempt it. ")
MAP_SENTENCE = "data_to_map accepts ONLY two sources as tool_result_id:"
OLD_MAP_SENTENCE = "data_to_map accepts ONLY a SQL/analyst tool result as tool_result_id:"

h = Harness("check_chart_source_constraint.py")


def spec_case(name: str, spec: str, fn, expect: str) -> None:
    p = h.path(f"{APP}/{spec}")
    original = p.read_text()

    def apply():
        d = json.loads(original)
        fn(d)
        changed = json.dumps(d, indent=2, ensure_ascii=False) + "\n"
        assert changed != original, f"mutation leaves {spec} unchanged"
        p.write_text(changed)

    h.custom(name, apply, lambda: p.write_text(original), expect)


def description(text: str):
    def fn(d):
        for t in d["tools"]:
            if t["tool_spec"]["name"] == "data_to_chart":
                t["tool_spec"]["description"] = text
    return fn


def orch(old: str, new: str):
    def fn(d):
        o = d["instructions"]["orchestration"]
        assert old in o, f"anchor not found: {old[:60]!r}"
        d["instructions"]["orchestration"] = o.replace(old, new, 1)
    return fn


def drop_charting_section(d):
    o = d["instructions"]["orchestration"]
    start = o.index(SECTION)
    d["instructions"]["orchestration"] = o[:start] + o[o.index(NEXT_SECTION, start):]


# The tool description: the shipped vague wording, then no sources at all.
spec_case("description reverts to 'the analytics tools' (shipped)", "agent-spec.json",
          description("Generates visualizations from tabular data returned by the analytics tools."),
          expect="the data_to_chart description still says 'tabular data returned by the analytics tools'")
spec_case("description names no accepted source", "ops-agent-spec.json",
          description("Generates visualizations from tabular data."),
          expect="ops-agent-spec.json: the data_to_chart description does not name its accepted sources")

# The orchestration rule beside the tool.
spec_case("CHARTING section deleted (distant verb-scoped sentence must not count)", "agent-spec.json",
          drop_charting_section,
          expect="agent-spec.json: the orchestration offers data_to_chart but no single passage")
# Consumer spec: its CHARTING section is the only full statement. (The super
# spec legitimately carries a second one, lifted from the ops spec.)
spec_case("MCP-rejected sentence removed from the CHARTING section", "agent-spec.json",
          orch(MCP_SENTENCE, ""),
          expect="agent-spec.json: the orchestration offers data_to_chart but no single passage")
spec_case("CHARTING header renamed, 'see CHARTING' pointers left dangling", "agent-spec.json",
          orch(SECTION, "CHART TOOL (data_to_chart):\n"),
          expect="points at a CHARTING section that does not exist")

# The sibling map rule the chart rule was copied from.
spec_case("sibling data_to_map source constraint deleted", "agent-spec.json",
          orch(MAP_SENTENCE, "data_to_map draws a prior tool result."),
          expect="agent-spec.json: the sibling data_to_map source constraint is gone")
# The pre-rows sentence coming back (as a revert would bring it) is its own failure.
spec_case("old 'accepts ONLY a SQL/analyst result' map sentence restored", "agent-spec.json",
          orch(MAP_SENTENCE, OLD_MAP_SENTENCE),
          expect="agent-spec.json: the orchestration still says data_to_map accepts only a SQL/analyst result")
spec_case("query_routing_results source dropped from the map sentence", "agent-spec.json",
          orch("a query_routing_results result for the result_id", "a routing verb result"),
          expect="agent-spec.json: the sibling data_to_map source constraint is gone")

h.add(f"{APP}/negtest-agent-spec.json", "{ not json",
      expect="negtest-agent-spec.json: is not valid JSON", name="unparseable agent spec")

sys.exit(h.finish())
