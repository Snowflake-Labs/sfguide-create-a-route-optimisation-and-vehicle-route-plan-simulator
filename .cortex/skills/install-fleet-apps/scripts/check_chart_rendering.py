#!/usr/bin/env python3
"""Fail when the SA app cannot render an agent-produced chart.

Why this exists
---------------
Every chart the Fleet agent produced rendered as a collapsed ``> Tool result``
JSON blob, for months, and nothing anywhere failed. The agent side was healthy:
``data_to_chart`` ran, the server-side ``vega_template`` was applied, and a valid
Vega-Lite spec arrived. The client threw it away.

The mechanism is worth stating exactly, because it is the same one that hid the
``routing_mcp_render_map`` separator bug. ``inlineRegistry.get`` resolves a
streamed tool name to a component, and an UNREGISTERED tool is a legal state - it
falls through to the raw JSON viewer. The registry knew ``render_chart``, a name
produced only by the ``response.chart`` SSE branch that this host never emits;
the real result streams as ``data_to_chart``. Neither name is a suffix of the
other, so ``matchesTool`` could not bridge them. No exception, no warning, no
empty state - a tidy collapsed blob that looks like a debug affordance.

Maps escaped this by luck: ``render_map`` happens to be registered under the
name it actually arrives with.

What it checks
--------------
1. RULE A - every chart tool name the stream can emit is registered in the inline
   registry, via the shared constant in ``lib/tool-names.ts``. Hardcoding
   ``'data_to_chart'`` at the registration site would pass a string check while
   letting the stream drift; requiring the shared constant is what keeps the two
   ends bound together.
2. RULE B - the chart component reads the ``charts`` ARRAY key. The measured
   payload is ``{charts: [spec, ...]}``; a component that only reads ``chartSpec``
   renders nothing, and one that reads ``charts[0]`` drops every chart after the
   first in a multi-chart answer.
3. RULE C - the theme is merged UNDER the spec. Three parties style one chart
   (this app, the agent's spec, the server template already baked into that
   spec), and an override-direction merge silently discards the agent's chosen
   sort, colours and axis formats. Direction is invisible at runtime: the chart
   still draws, just not as asked.
4. RULE D - citation tags are stripped before markdown rendering. react-markdown
   carries no rehype-raw, so an unhandled ``<chart>ID</chart>`` is dropped by the
   parser - which is why the tag was never noticed and charts sat before their
   prose instead of beside it.
5. RULE E - vega is imported ONLY behind the lazy boundary. vega + vega-lite is a
   deck.gl-sized dependency and the chat tree imports the inline barrel eagerly,
   so a direct import in the barrel puts all of it in the initial bundle of an
   app where most turns produce no chart. Cost, not correctness, and invisible in
   any functional test.

Run with no arguments; exits non-zero naming the rule and the file.
"""

from __future__ import annotations

import pathlib
import re
import sys

UI = pathlib.Path(__file__).resolve().parent.parent / "fleet_sa_app" / "ui" / "src"

TOOL_NAMES = UI / "lib" / "tool-names.ts"
REGISTRY_SITE = UI / "components" / "inline" / "index.ts"
CHART_COMPONENT = UI / "components" / "inline" / "chart-inline.tsx"
CHART_DEFERRED = UI / "components" / "inline" / "chart-deferred.tsx"
CHART_SPEC = UI / "lib" / "chart-spec.ts"
THEME = UI / "lib" / "vega-theme.ts"
CITATIONS = UI / "lib" / "chart-citations.ts"
MARKDOWN_SITE = UI / "components" / "chat" / "message-part.tsx"

# The name measured on a live turn. Present here as well as in the TS constant so
# a rename has to be deliberate in two places rather than silent in one.
HOST_CHART_TOOL = "data_to_chart"

VEGA_IMPORT = re.compile(r"""from\s+['"]vega(-lite|-interpreter)?['"]""")
# The vega-LITE compiler specifically. Matching bare `vega` is not enough: the
# component legitimately imports `vega` and `vega-interpreter` for the runtime, so
# a build that dropped the compiler import still satisfied the loose pattern.
VEGA_LITE_IMPORT = re.compile(r"""from\s+['"]vega-lite['"]""")
# The assignment, not a mention. An earlier draft searched for the literal
# 'data_to_chart' ANYWHERE in tool-names.ts and passed a tree where the constant
# had been renamed to 'render_chart', because the docstring above it still spelled
# the real name out in prose.
CHART_NAME_ASSIGN = re.compile(
    r"""CHART_TOOL_NAME\s*=\s*['"]""" + HOST_CHART_TOOL + r"""['"]""")


def read(path: pathlib.Path, problems: list[str], rule: str) -> str:
    """File text, or '' with a problem recorded - a missing file must FAIL, not
    vacuously pass every rule that greps it."""
    if not path.exists():
        problems.append(f"{rule}: {path} is missing")
        return ""
    return path.read_text()


def main() -> int:
    problems: list[str] = []

    names_src = read(TOOL_NAMES, problems, "RULE A")
    registry_src = read(REGISTRY_SITE, problems, "RULE A")
    spec_src = read(CHART_SPEC, problems, "RULE B")
    component_src = read(CHART_COMPONENT, problems, "RULE C")
    theme_src = read(THEME, problems, "RULE C")
    citations_src = read(CITATIONS, problems, "RULE D")
    markdown_src = read(MARKDOWN_SITE, problems, "RULE D")
    deferred_src = read(CHART_DEFERRED, problems, "RULE E")

    # ---- RULE A: the host's real tool name is registered, from one source ----
    if not CHART_NAME_ASSIGN.search(names_src):
        problems.append(
            f"RULE A: lib/tool-names.ts does not assign CHART_TOOL_NAME = "
            f"{HOST_CHART_TOOL!r}. That name is what the stream receives; without it "
            f"the inline registry cannot match a chart result and every chart falls "
            f"through to the collapsed JSON viewer.")
    if "CHART_TOOL_ALIASES" not in names_src:
        problems.append(
            "RULE A: lib/tool-names.ts does not export CHART_TOOL_ALIASES. The stream "
            "and the registry must read the chart tool names from one constant, or "
            "they drift apart again.")
    # Imported AND iterated. Checking only that the identifier appears in the file
    # passed a tree whose registration loop had been hardcoded back to
    # ['render_chart'] while the now-unused import sat at the top.
    if not re.search(r"of\s+CHART_TOOL_ALIASES", registry_src):
        problems.append(
            "RULE A: components/inline/index.ts does not register FROM "
            "CHART_TOOL_ALIASES. A hardcoded name here passes a grep while letting "
            "cortex-stream.ts emit something else.")
    if "inlineRegistry.register" not in registry_src:
        problems.append("RULE A: components/inline/index.ts registers nothing")

    # ---- RULE B: the array payload key is read ----
    if "charts" not in spec_src:
        problems.append(
            "RULE B: lib/chart-spec.ts never reads the `charts` key. The measured "
            "data_to_chart payload is {charts: [spec, ...]} - an array of spec "
            "strings, not a single `chartSpec`.")
    elif not re.search(r"Array\.isArray\(\s*payload\.charts\s*\)", spec_src):
        problems.append(
            "RULE B: lib/chart-spec.ts does not treat `charts` as an array. Reading "
            "only the first entry drops every additional chart in an answer the agent "
            "deliberately split across several data_to_chart calls.")

    # ---- RULE C: theme merges UNDER the spec ----
    if "mergeThemeUnder" not in theme_src:
        problems.append("RULE C: lib/vega-theme.ts does not define mergeThemeUnder")
    else:
        # The spec must be the FIRST argument (the winning side). Asserted on the
        # signature, because reversing the two arguments is a one-word edit that
        # still compiles, still renders, and silently overrides the agent.
        # `[^(]*` skips any generic parameter list, whose own angle brackets defeat
        # a naive `<[^>]*>` (Record<string, unknown> closes it early).
        sig = re.search(r"function\s+mergeThemeUnder[^(]*\(\s*(\w+)\s*:", theme_src)
        if not sig or sig.group(1) != "spec":
            problems.append(
                "RULE C: mergeThemeUnder must take the SPEC first, so spec values win "
                "over theme values. Reversed, the app's theme overrides the agent's "
                "deliberate encodings and the server-side vega_template - the chart "
                "still draws, just not as asked.")
    # A CALL, not the import line - `import { themeSpec }` alone satisfied a bare
    # substring check on a component that had stopped theming its specs.
    if not re.search(r"themeSpec\s*\(", component_src):
        problems.append(
            "RULE C: the chart component does not CALL themeSpec, so charts render "
            "in Vega's stock palette instead of the app's.")

    # ---- RULE D: citation tags stripped ----
    if "stripCitationTags" not in citations_src or "resolveChartCitations" not in citations_src:
        problems.append(
            "RULE D: lib/chart-citations.ts must export both stripCitationTags and "
            "resolveChartCitations.")
    if "stripCitationTags" not in markdown_src:
        problems.append(
            "RULE D: components/chat/message-part.tsx renders markdown without "
            "stripping citation tags. react-markdown has no rehype-raw, so a "
            "<chart>ID</chart> tag is silently swallowed and the chart is never placed "
            "beside the prose that cites it.")

    # ---- RULE E: vega only behind the lazy boundary ----
    for path, src in ((REGISTRY_SITE, registry_src), (CHART_DEFERRED, deferred_src)):
        if VEGA_IMPORT.search(src):
            problems.append(
                f"RULE E: {path.name} imports vega directly. vega + vega-lite must be "
                f"reachable ONLY through the lazy chunk (chart-deferred -> chart-inline); "
                f"the chat tree imports this module eagerly, so a direct import puts the "
                f"whole renderer in the initial bundle.")
    if "lazy(" not in deferred_src or "chart-inline" not in deferred_src:
        problems.append(
            "RULE E: components/inline/chart-deferred.tsx must lazily import "
            "./chart-inline - that boundary is the only thing keeping vega out of the "
            "initial bundle.")
    if not VEGA_LITE_IMPORT.search(component_src):
        problems.append(
            "RULE E: chart-inline.tsx does not import the vega-lite compiler. The spec "
            "is Vega-Lite; a hand-rolled translation cannot express the pie, box plot, "
            "histogram and dual-axis charts the agent is instructed to produce.")

    if problems:
        print("FAIL: the SA app cannot reliably render an agent chart:")
        for p in problems:
            print(f"  - {p}")
        return 1

    print("OK: chart tool registered from a shared constant, charts[] read, theme "
          "merged under the spec, citations stripped, vega behind the lazy boundary")
    return 0


if __name__ == "__main__":
    sys.exit(main())
