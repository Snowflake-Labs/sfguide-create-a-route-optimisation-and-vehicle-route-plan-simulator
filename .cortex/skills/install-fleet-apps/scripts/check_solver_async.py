#!/usr/bin/env python3
"""Enforce that solver verbs go through the ASYNC solve runner, not a plain query.

WHY THIS GATE EXISTS
--------------------
Solves outlive what a single HTTP request can wait for. Measured server-side
(`ensemble`, SanFrancisco, TOTAL_ELAPSED_TIME):

    20 vehicles / 120 loads (the DEFAULTS) ...  38.1s
    40 / 200 ................................   54.8s
    60 / 300 ................................   78.8s
    100 / 300 ...............................   89.2s
    100 / 500 ...............................  168.6s

The SA app's synchronous transport cannot wait that long, and the ceiling is built
from three independent limits: `pollResult` gives up at 30x2s = 60s, the statement
carries `timeout: 80`, and that 80 exists to stay under the ~90s SPCS ingress
limit. So the DEFAULT configuration already spent 63% of the budget and anything
past roughly 40 vehicles / 200 loads returned "Statement timed out after 60s"
instead of a plan.

Raising the bound cannot fix it - ingress caps the request below the measured
168.6s - so solver routes submit asynchronously (`runSolve`) and hand back a
`solve_key` to poll when the solve outlives a 45s inline wait.

The failure mode this gate prevents is subtle: a solver route that reverts to a
plain `query`/`queryBatch` still WORKS for small inputs. It only breaks past ~40
vehicles, and it breaks as a timeout that reads like an infrastructure problem
rather than a regression. Nothing else would catch that.

WHAT IT CHECKS
--------------
1. Every verb in SOLVER_VERBS (app/api/tool/route.ts) is dispatched through
   `runSolve`, not `query`/`queryBatch`.
2. The solver routes still import `runSolve`.
3. `runSolve` / `collectSolve` remain exported, and `submitAsync` does NOT set a
   `timeout` field - adding one reinstates the ceiling the async path exists to
   escape.
4. /api/solve-status still exists, since every 202 the routes emit points at it.

Exit 0 clean, 1 on any finding. Read-only.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
SA_SRC = SKILL_DIR / "fleet_sa_app" / "ui" / "src"

TOOL_ROUTE = SA_SRC / "app" / "api" / "tool" / "route.ts"
BACKLOAD_ROUTE = SA_SRC / "app" / "api" / "backload" / "solve" / "route.ts"
STATUS_ROUTE = SA_SRC / "app" / "api" / "solve-status" / "route.ts"
RUNNER = SA_SRC / "lib" / "solve-runner.ts"
TRANSPORT = SA_SRC / "lib" / "snowflake.ts"

SOLVER_ROUTES = [TOOL_ROUTE, BACKLOAD_ROUTE]


def strip_comments(text: str) -> str:
    """Blank comments, preserving newlines so line numbers stay accurate.

    Load-bearing: these files document the defect in prose and legitimately
    mention `query(` and `timeout` inside explanations of what NOT to do.
    """
    text = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.DOTALL)
    return re.sub(r"//[^\n]*", "", text)


def main() -> int:
    findings: list[str] = []

    # --- 0. the async machinery must exist, else every rule below is vacuous ---
    if not RUNNER.exists():
        print("FAIL: lib/solve-runner.ts is missing. The async solve path is gone; "
              "solves past ~40 vehicles cannot complete.")
        return 1
    runner_src = RUNNER.read_text(encoding="utf-8", errors="replace")
    for fn in ("runSolve", "collectSolve"):
        if f"export async function {fn}" not in runner_src:
            findings.append(f"lib/solve-runner.ts: `{fn}` is no longer exported.")
    if not STATUS_ROUTE.exists():
        findings.append(
            "app/api/solve-status/route.ts is missing, but the solver routes return "
            "202 responses pointing clients at it."
        )

    # --- 1. submitAsync must NOT carry a statement timeout ---
    if TRANSPORT.exists():
        tsrc = strip_comments(TRANSPORT.read_text(encoding="utf-8", errors="replace"))
        m = re.search(r"export async function submitAsync\b(.*?)\n}", tsrc, re.DOTALL)
        if not m:
            findings.append("lib/snowflake.ts: `submitAsync` not found - the async "
                            "submission path is gone.")
        elif re.search(r"\btimeout\s*:", m.group(1)):
            findings.append(
                "lib/snowflake.ts: `submitAsync` sets a `timeout` field. That 80s cap "
                "is an INGRESS guard for the synchronous path; applying it to an async "
                "submission reinstates the ~60-80s ceiling and kills any solve past "
                "~40 vehicles (measured: 100/500 needs 168.6s)."
            )

    # --- 2. SOLVER_VERBS must be dispatched through runSolve ---
    if not TOOL_ROUTE.exists():
        findings.append("app/api/tool/route.ts is missing.")
    else:
        raw = TOOL_ROUTE.read_text(encoding="utf-8", errors="replace")
        code = strip_comments(raw)
        sv = re.search(r"const SOLVER_VERBS\s*=\s*new Set\(\[(.*?)\]\)", code, re.DOTALL)
        if not sv:
            findings.append(
                "app/api/tool/route.ts: SOLVER_VERBS set not found. Without it every "
                "solver verb falls back to the synchronous path."
            )
        else:
            verbs = re.findall(r"'([a-z_]+)'", sv.group(1))
            if len(verbs) < 7:
                findings.append(
                    f"app/api/tool/route.ts: SOLVER_VERBS lists only {len(verbs)} verb(s) "
                    f"({', '.join(verbs)}). All seven solver verbs must be classified; a "
                    f"missing one silently keeps the 60s ceiling."
                )
            if "runSolve" not in code:
                findings.append(
                    "app/api/tool/route.ts: does not call `runSolve`. Solver verbs are "
                    "back on the synchronous transport and will time out past ~40 vehicles."
                )
            # The solver branch must not fall through to query()/queryBatch().
            if re.search(r"SOLVER_VERBS\.has\([^)]*\)\s*\?\s*queryBatch", code):
                findings.append(
                    "app/api/tool/route.ts: solver verbs are dispatched to `queryBatch`. "
                    "That fixes STARVATION but not the CEILING - use `runSolve`."
                )

    # --- 3. the backload solve route must use the runner too ---
    if BACKLOAD_ROUTE.exists():
        bcode = strip_comments(BACKLOAD_ROUTE.read_text(encoding="utf-8", errors="replace"))
        if "runSolve" not in bcode:
            findings.append(
                "app/api/backload/solve/route.ts: does not call `runSolve`. This page "
                "allows 180s client-side (BM_SOLVE_TIMEOUT_MS) but the synchronous "
                "server path gives up at 60s."
            )
        if re.search(r"\bawait\s+(query|queryBatch)\s*\(", bcode):
            findings.append(
                "app/api/backload/solve/route.ts: still awaits a synchronous "
                "`query`/`queryBatch` for the solve."
            )

    if findings:
        print("FAIL: solver verbs are not on the async solve path\n")
        for f in findings:
            print(f"  {f}")
        print(f"\n{len(findings)} finding(s). A synchronous solve cannot exceed ~60s, "
              f"and the DEFAULT parameters already take 38.1s.")
        return 1

    print("PASS: solver verbs dispatch through runSolve; submitAsync carries no "
          "statement timeout; /api/solve-status present")
    return 0


if __name__ == "__main__":
    sys.exit(main())
