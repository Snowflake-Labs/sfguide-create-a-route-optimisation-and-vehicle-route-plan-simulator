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
6. RULE G - the stream DEDUPLICATES chart specs. Measured in
   ``SEMANTIC_OPS.AGENT_TURN.TOOLS_USED``: this host sends the same chart twice,
   once as a ``data_to_chart`` tool_result and again as a ``response.chart``
   event (one turn records both). That was harmless while neither path rendered;
   with both names now bound to a working renderer it draws the chart TWICE.
   Nothing about a duplicated chart raises an error, so it is gate-only.
7. RULE H - every tool the agent spec declares is HANDLED by the client: rendered
   by a registered inline component, suppressed, or named in the allowlist below
   as intentionally raw. This is the rule that generalises the other six. Four
   separate instances of the same defect shipped before it existed:

     data_to_chart      registered under the wrong name  -> JSON blob
     query_* (x13)      suppressed by tool TYPE, never by NAME -> whole semantic
                        model dumped into the transcript, every analytics turn
     system_execute_sql neither registered nor suppressed -> JSON blob
     server_skill       neither registered nor suppressed -> the skill's entire
                        markdown body dumped as a JSON blob

   Each was invisible: an unhandled tool result is a LEGAL state that renders as a
   tidy collapsed row. The analyst tools are covered by PAYLOAD SHAPE rather than
   by name (13 names in a list go stale the moment a semantic view is added), so
   this rule also asserts that the shape test exists and keys on
   ``semantic_model_key``.

Run with no arguments; exits non-zero naming the rule and the file.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

UI = pathlib.Path(__file__).resolve().parent.parent / "fleet_sa_app" / "ui" / "src"

STREAM = UI / "lib" / "cortex-stream.ts"
VISIBILITY = UI / "lib" / "tool-visibility.ts"
AGENT_SPEC = pathlib.Path(__file__).resolve().parent.parent / "fleet_sa_app" / "app" / "agent-spec.json"
APP_CONFIG = pathlib.Path(__file__).resolve().parent.parent / "fleet_sa_app" / "app" / "app-config.json"

# Tool names OBSERVED reaching this client, which is NOT the same set as the tools
# the agent spec declares - and the difference is why an earlier draft of RULE H was
# nearly vacuous. The spec declares 17 tools (13 analyst, 2 search, data_to_chart,
# code_execution); `system_execute_sql` and `server_skill` are HOST-INJECTED and
# appear nowhere in it, so a rule reading only the spec could not see two of the
# four defects it exists to catch.
#
# Ground truth is the turn record. Refresh with:
#
#   SELECT DISTINCT F.VALUE::STRING
#   FROM FLEET_INTELLIGENCE.SEMANTIC_OPS.AGENT_TURN T,
#        LATERAL FLATTEN(INPUT => T.TOOLS_USED) F;
#
# Add a name here when it shows up there. Adding one is cheap; the point is that an
# unhandled name FAILS instead of quietly rendering as a blob.
OBSERVED_HOST_TOOLS = {
    "system_execute_sql",   # host SQL executor: {query_id, sql, result_set}
    "server_skill",         # a fired agent skill: {skill_name, content}
    "data_to_chart",        # host chart tool: {charts: [spec, ...]}
    "render_table",         # client-side, emitted by cortex-stream
    "render_chart",         # client-side, the duplicate response.chart event
}

# The two names the chart tool can arrive under, registered via CHART_TOOL_ALIASES
# rather than spelled literally at the registration site.
CHART_ALIAS_NAMES = {"data_to_chart", "render_chart"}

# Declared tools whose raw JSON in the transcript is INTENTIONAL. Keep this short
# and justified: every entry is a tool whose result a user is expected to read as
# data. An entry here is a decision, not a default - the default is that an
# unhandled tool is a bug.
RAW_JSON_ALLOWLIST = {
    # Handed to the browser as a navigation instruction / link, narrated by the
    # agent's own prose; there is no payload worth drawing.
    "deep_link",
    "show_view",
    # Read-only descriptors the agent quotes back in prose.
    "describe_data",
    "describe_deployment",
    "search_solution_catalog",
    "list_use_cases",
    "search_sap_binding",
    "introspect_sap",
    "run_sql",
    # Host tools with their own host-side rendering.
    "data_to_map",
    "code_execution",
}
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
    stream_src = read(STREAM, problems, "RULE G")

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

    # ---- RULE G: the duplicate response.chart event is not drawn twice ----
    if "seenChartSpecs" not in stream_src or "claimChartSpecs" not in stream_src:
        problems.append(
            "RULE G: cortex-stream.ts does not deduplicate chart specs. This host sends "
            "the same chart twice - as a data_to_chart tool_result AND as a "
            "response.chart event (measured in AGENT_TURN.TOOLS_USED, one turn records "
            "both) - so with both names registered the chart is drawn TWICE. A "
            "duplicated chart raises no error, so nothing else can catch it.")
    else:
        # The response.chart branch must CONSULT the dedupe, not merely populate it.
        chart_branch = re.search(
            r"case 'response\.chart':(.{0,900}?)break;", stream_src, re.S)
        if not chart_branch or "claimChartSpecs" not in chart_branch.group(1):
            problems.append(
                "RULE G: the response.chart branch does not check claimChartSpecs "
                "before emitting. Recording the spec without gating on it leaves the "
                "duplicate in place.")
        elif "chart_spec" not in chart_branch.group(1):
            problems.append(
                "RULE G: the response.chart branch no longer reads chart_spec. Emitting "
                "{charts: [undefined]} trades a duplicated chart for a missing one.")

    # ---- RULE H: every declared tool is handled somewhere ----
    visibility_src = read(VISIBILITY, problems, "RULE H")

    # Every check below reads CODE, not prose. The first draft of this rule searched
    # the whole file for `isAnalystModelDump` and for `semantic_model_key`, and
    # PASSED on a tree where the function had been renamed away and the key deleted -
    # because both strings also appear in this module's own comments. Same mistake as
    # the first version of RULE A/C, made twice in one gate.
    dump_fn = re.search(
        r"export function isAnalystModelDump\s*\([^)]*\)\s*:\s*boolean\s*\{(.*?)\n\}",
        visibility_src, re.S)
    if not dump_fn:
        problems.append(
            "RULE H: lib/tool-visibility.ts does not EXPORT a function "
            "isAnalystModelDump. The 13 analyst tools are declared with query_* NAMES "
            "while the old suppression keyed on the tool TYPE "
            "(cortex_analyst_text_to_sql), so it never matched and every analytics "
            "turn dumped its whole semantic model into the transcript.")
    elif "semantic_model_key" not in dump_fn.group(1):
        problems.append(
            "RULE H: the BODY of isAnalystModelDump does not key on "
            "semantic_model_key. Matching on tool names instead goes stale the moment "
            "a semantic view is added - silently, which is the defect this prevents.")

    # The suppression LIST, parsed - not a substring search of the module, where a
    # name mentioned in a comment or in attributeTool() reads as suppressed.
    suppress_block = re.search(
        r"SUPPRESS_RESULT_SUFFIXES\s*=\s*\[(.*?)\]", visibility_src, re.S)
    suppressed_names = set(re.findall(r"['\"]([\w.]+)['\"]", suppress_block.group(1))) \
        if suppress_block else set()
    if not suppressed_names:
        problems.append(
            "RULE H: SUPPRESS_RESULT_SUFFIXES is missing or empty in "
            "lib/tool-visibility.ts")

    # The component must hand the PAYLOAD to the suppressor, or the shape-based
    # analyst check can never fire - the list would be back to name-only matching.
    if not re.search(r"isSuppressedTool\(\s*part\.toolName\s*,", markdown_src):
        problems.append(
            "RULE H: message-part.tsx calls isSuppressedTool without the payload. The "
            "analyst tools are recognised by SHAPE, so dropping the second argument "
            "silently restores the name-only matching that never matched.")

    # The inline registry registrations, parsed the same way.
    registered_names = set(re.findall(r"toolName:\s*['\"]([\w.]+)['\"]", registry_src))

    try:
        spec = json.loads(AGENT_SPEC.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        problems.append(f"RULE H: cannot read {AGENT_SPEC.name} ({exc})")
        spec = {}

    declared: list[tuple[str, str]] = []
    for tool in spec.get("tools", []):
        ts = tool.get("tool_spec", {})
        name, ttype = ts.get("name"), ts.get("type", "")
        if isinstance(name, str) and name:
            declared.append((name, ttype))
    # Host-injected names are not in the spec but DO reach the client (measured -
    # see OBSERVED_HOST_TOOLS). Without them this rule cannot see two of the four
    # defects it exists for.
    declared += [(n, "host") for n in sorted(OBSERVED_HOST_TOOLS)]

    if not declared:
        problems.append("RULE H: the agent spec declares no tools - cannot verify coverage")

    # Verbs app-config binds to the inline deck.gl map (registerToolMaps).
    map_tools: set[str] = set()
    try:
        app_cfg = json.loads(APP_CONFIG.read_text())
        map_tools = set((app_cfg.get("tools") or {}).get("mapTools") or [])
    except (OSError, json.JSONDecodeError) as exc:
        problems.append(f"RULE H: cannot read {APP_CONFIG.name} ({exc})")

    # A tool is handled when it is registered, name-suppressed, shape-suppressed, or
    # explicitly allowlisted as intentionally raw.
    shape_suppressed_types = {"cortex_analyst_text_to_sql"}
    unhandled: list[str] = []
    for name, ttype in declared:
        if name in RAW_JSON_ALLOWLIST:
            continue
        if ttype in shape_suppressed_types:
            continue  # covered by isAnalystModelDump, asserted above
        registered = name in registered_names
        # The chart names are registered by iterating CHART_TOOL_ALIASES rather
        # than spelled literally, deliberately (one source of truth with the
        # stream), so a literal search cannot see EITHER of them.
        if not registered and name in CHART_ALIAS_NAMES and "CHART_TOOL_ALIASES" in registry_src:
            registered = True
        suppressed = name in suppressed_names or ttype in shape_suppressed_types
        # An MCP verb counts as handled only when app-config actually binds it to
        # the inline map. `type == generic` alone would auto-pass every verb and
        # make this rule vacuous - the whole point is default-DENY, so a NEW verb
        # has to be a deliberate decision (register it, suppress it, or allowlist
        # it) rather than silently rendering as a blob.
        mapped = name in map_tools and "registerToolMaps" in registry_src
        if not (registered or suppressed or mapped):
            unhandled.append(f"{name} (type {ttype or 'unknown'})")

    if unhandled:
        problems.append(
            "RULE H: these declared tools are neither rendered by a registered inline "
            "component, nor suppressed, nor in RAW_JSON_ALLOWLIST, so their results "
            "render as a collapsed JSON blob - a legal, silent state that has already "
            "shipped four times: " + ", ".join(sorted(unhandled)))

    if problems:
        print("FAIL: the SA app cannot reliably render an agent chart:")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("OK: chart tool registered from a shared constant, charts[] read, theme "
          "merged under the spec, citations stripped, vega behind the lazy boundary, "
          "duplicate response.chart deduplicated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
