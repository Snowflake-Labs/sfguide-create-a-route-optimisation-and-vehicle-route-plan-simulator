#!/usr/bin/env python3
"""Negative tests for check_solver_async.py - each case moves a solve back onto
the synchronous ~60s transport (or re-binds a NULL argument as '') the way the
real regressions looked, and the gate must name the specific breakage."""
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SRC = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src"
RUNNER = f"{SRC}/lib/solve-runner.ts"
TRANSPORT = f"{SRC}/lib/snowflake.ts"
TOOL = f"{SRC}/app/api/tool/route.ts"
OPS = f"{SRC}/app/api/ops/route.ts"
BACKLOAD = f"{SRC}/app/api/backload/solve/route.ts"
STATUS = f"{SRC}/app/api/solve-status/route.ts"
BODY_END = ("    parameters: { QUERY_TAG },\n  };\n  if (binds.length > 0) body.bindings = bindings;\n\n"
            "  const response = await fetch(`${auth.baseUrl}/api/v2/statements?async=true`")

h = Harness("check_solver_async.py")

# 0. the async machinery itself
h.delete(RUNNER, expect="lib/solve-runner.ts is missing", name="solve runner deleted")
h.replace(RUNNER, "export async function collectSolve", "async function collectSolve",
          expect="`collectSolve` is no longer exported", name="collectSolve no longer exported")
h.delete(STATUS, expect="app/api/solve-status/route.ts is missing", name="solve-status route deleted")

# 1. submitAsync shape
h.replace(TRANSPORT, BODY_END, BODY_END.replace("QUERY_TAG },\n", "QUERY_TAG },\n    timeout: 80,\n", 1),
          expect="`submitAsync` sets a `timeout` field", name="submitAsync carries the 80s ingress timeout")
h.replace(TRANSPORT, BODY_END, BODY_END.replace("QUERY_TAG },\n", "QUERY_TAG },\n    async: true,\n", 1),
          expect="sets an `async` field in the request BODY", name="async passed as a body field (400 391917)")
h.replace(TRANSPORT, "/api/v2/statements?async=true`", "/api/v2/statements`",
          expect="does not POST to `/api/v2/statements?async=true`",
          name="async query parameter dropped (silently synchronous)")

# 2. SOLVER_VERBS dispatch in /api/tool
h.replace(TOOL, "const SOLVER_VERBS = new Set([", "const SOLVE_VERBS = new Set([",
          expect="SOLVER_VERBS set not found", name="SOLVER_VERBS set renamed away")
h.replace(TOOL, "  'backload_chain_solve',\n]);", "]);",
          expect="SOLVER_VERBS lists only 6 verb(s)", name="a solver verb left unclassified")
tool = h.path(TOOL)
tool_original = tool.read_text()


def drop_solver_branch():
    """The historical shape: the async branch is gone, every verb falls through
    to the synchronous query(), and the runSolve IMPORT is left behind."""
    start = tool_original.index("    if (SOLVER_VERBS.has(verb)) {")
    depth, i = 0, tool_original.index("{", start)
    while True:
        c = tool_original[i]
        depth += c == "{"
        depth -= c == "}"
        i += 1
        if depth == 0:
            break
    text = tool_original[:start] + tool_original[i:].lstrip("\n")
    assert "import { runSolve }" in text and not re.search(r"\brunSolve\s*\(", text)
    tool.write_text(text)


h.custom("solver branch reverted to sync query (import left behind)", drop_solver_branch,
         lambda: tool.write_text(tool_original), expect="does not call `runSolve`")
h.replace(TOOL, "    const rows = await query(`CALL ${schema}.${verb}(${placeholders})`",
          "    const rows = await (SOLVER_VERBS.has(verb) ? queryBatch : query)(`CALL ${schema}.${verb}(${placeholders})`",
          expect="solver verbs are dispatched to `queryBatch`", name="solver verbs moved to queryBatch")

# 3. backload solve route
h.replace(BACKLOAD, "    const outcome = await runSolve(\n      'backload_dispatch',\n",
          "    const outcome = await query(\n",
          expect="still awaits a synchronous", name="backload solve back on a synchronous query")

# 4. NULL arguments sent as ''
h.replace(TRANSPORT, "value: v === null ? null : String(v),", "value: v === null ? '' : String(v),",
          expect="a null bind is sent as the empty string", name="null bind sent as ''")
h.replace(TRANSPORT, "toBindings(", "encodeBinds(", count=-1,
          expect="the shared `toBindings` helper is gone", name="shared bind helper renamed away")
h.replace(TRANSPORT, "export function buildCallArgs", "function buildCallArgs",
          expect="`buildCallArgs` is gone", name="buildCallArgs no longer exported")
ops = h.path(OPS)
ops_original = ops.read_text()


def hand_built_placeholders():
    old = re.search(r"  const \{ placeholders, binds \} = buildCallArgs\(\[\n.*?\n  \]\);\n", ops_original, re.S)
    assert old, "ops buildCallArgs block drifted"
    text = ops_original.replace("import { query, buildCallArgs } from", "import { query } from", 1)
    text = text.replace(old.group(0),
                        "  const binds = [...args.map((a) => (a == null ? '' : String(a))), idemKey];\n"
                        "  const placeholders = binds.map(() => '?').join(', ');\n", 1)
    ops.write_text(text)


h.custom("ops route builds CALL placeholders by hand", hand_built_placeholders,
         lambda: ops.write_text(ops_original), expect="app/api/ops/route.ts: builds its CALL placeholders")

sys.exit(h.finish())
