#!/usr/bin/env python3
"""Negative tests for fleet_sa_app/ui/scripts/verify-chart-spec.mts - each case
re-introduces a SILENT chart failure the suite documents: an unmatched tool name,
a theme merged the wrong way round, a duplicated chart, a citation that drops its
chart, or a wrong-case column that draws empty axes without a word."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

UI = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui"
LIB = f"{UI}/src/lib"

h = Harness("verify-chart-spec.mts", path=f"{UI}/scripts/verify-chart-spec.mts", cwd=UI,
            cmd=["npx", "tsx"])

# An MCP-prefixed chart tool fell through to a collapsed JSON viewer for months.
h.replace(f"{LIB}/tool-names.ts", "return toolName === bare || toolName.endsWith('_' + bare);",
          "return toolName === bare;",
          expect="isChartTool tolerates a server prefix",
          name="tool-name match is exact only (prefix not tolerated)")

# Theme merged the wrong way round: still draws, just not as the agent asked.
h.replace(f"{LIB}/vega-theme.ts", "    } else {\n      out[k] = specVal;\n    }",
          "    } else {\n      out[k] = themeVal === undefined ? specVal : themeVal;\n    }",
          expect="spec value wins over theme",
          name="theme overrides the spec instead of filling under it")

# The host sends the same chart twice; without dedupe it is drawn twice.
h.replace(f"{LIB}/cortex-stream.ts", "      if (!seenChartSpecs.has(key)) {", "      if (true) {",
          expect="the duplicated chart is emitted ONCE",
          name="duplicate response.chart no longer deduplicated")

# An unmatched citation must change position only, never drop the chart.
h.replace(f"{LIB}/chart-citations.ts",
          "  for (const [id, chart] of chartsById) {\n    if (!placed.has(id)) out.push(chart);\n  }\n",
          "",
          expect="an unmatched citation still renders the chart",
          name="unplaced charts dropped after citation resolution")

# A case-tolerant lookup hides the wrong-case binding the renderer cannot draw.
h.replace(f"{LIB}/chart-encodings.ts", "name.length > 0 && name in row;",
          "name.length > 0 && Object.keys(row).some((k) => k.toLowerCase() === name.toLowerCase());",
          expect="a chart bound to a wrong-case column reports it",
          name="plot diagnostic matches columns case-insensitively")

# Losing groupBy silently collapses every row into one blank category.
h.replace(f"{LIB}/chart-encodings.ts",
          "const groupDrawable = !input.groupBy || present(first, input.groupBy);",
          "const groupDrawable = true;",
          expect="a grouped chart missing its groupBy column reports it",
          name="plot diagnostic ignores a missing groupBy column")

# The logger unplugged: vega-lite prints its warnings to stdout, so they land in
# the install log as bare WARN lines under a gate that PASSES.
h.replace(f"{UI}/scripts/verify-chart-spec.mts",
          "compile(prepared as any, { logger: capturingLogger(notices) })",
          "compile(prepared as any)",
          expect="compile notices are captured by the harness logger",
          name="compile warnings bypass the harness logger")

# A sizing change that raises a NEW warning must fail, not hide among the two
# expected ones: `pad` makes vega-lite warn that a container width needs fit.
h.replace(f"{LIB}/chart-spec.ts",
          "      ? { type: 'fit-x', contains: 'padding' }",
          "      ? { type: 'pad', contains: 'padding' }",
          expect="compiles without an unexpected vega-lite warning",
          name="step-height spec autosized to pad")

sys.exit(h.finish())
