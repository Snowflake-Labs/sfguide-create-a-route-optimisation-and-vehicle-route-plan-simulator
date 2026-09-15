#!/usr/bin/env python3
"""Enforce that BATCH workloads use the batch SQL transport, not the interactive one.

WHY THIS GATE EXISTS
--------------------
The apps run two warehouses (scripts/warehouses.sql): FLEET_APPS_WH for
interactive reads, ROUTING_ANALYTICS for batch. The admin app expresses that split
through two transports in server/lib/sql.ts - `runSql` (interactive) and
`runSqlBatch` (batch) - and the SA app through `query` vs `queryBatch`.

The split shipped looking complete and was not. Both `submitSqlAsync` call sites
were correctly on the batch warehouse, so the seam appeared finished, and NOTHING
verified that the callers of the SYNCHRONOUS transport had been classified at all.
Three whole subsystems were still interactive:

  * the entire server/studio/** generation pipeline, from ONE argument at
    app/api/studio/generate/route.ts - `startGeneration(config, name, runSql)` -
    closed over by the detached job IIFE and reaching ~60 functions, every
    2000-row telemetry INSERT, every ORS DIRECTIONS call, a 6-minute
    waitForOrsReady poll loop and two 60s-per-job timers, at 13-15 concurrent
    statements against MAX_CONCURRENCY_LEVEL 8;
  * all of instrumentation.ts - boot DDL plus a permanent 5-minute reconciler
    (measured 544 statements / 24h, 272 wake-ups/day);
  * heavy routes: refreshRegionCatalog (~5,200-row MERGE), deleteJobData
    (17 DELETEs), deleteDataset, cancelJob, activateDataset, INGEST_ORS_METRICS.

The lesson is that a batch workload is invisible at the transport: it is an
ordinary-looking synchronous call. So the check has to know WHICH ENTRY POINTS are
batch, by name, and assert they never receive the interactive function.

WHAT IT CHECKS
--------------
1. For each known batch entry point, every call site passes the batch transport.
   A call like `startGeneration(config, name, runSql)` fails.
2. instrumentation.ts issues no bare `runSql(` at all - it is entirely batch.
3. The batch transports still exist and are exported (so a rename cannot quietly
   turn every rule below into a no-op that passes).

Exit 0 clean, 1 on any finding. Read-only: parses files, touches no account.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
ADMIN_SRC = SKILL_DIR / "fleet_admin_app" / "ui" / "src"
SA_SRC = SKILL_DIR / "fleet_sa_app" / "ui" / "src"

INTERACTIVE_FN = "runSql"
BATCH_FN = "runSqlBatch"

# Batch entry points that take an injected SQL function. Each is here because its
# body does bulk writes, DDL, or a long poll loop - never because of its name.
BATCH_ENTRY_POINTS = [
    "startGeneration",                        # the whole studio generation pipeline
    "reconcileStaleJobs",                     # background reconciler
    "refreshRegionCatalog",                   # ~5,200-row MERGE in 50-row batches
    "deleteJobData",                          # 17 DELETEs across fact tables
    "deleteDataset",                          # delegates to deleteJobData
    "cancelJob",                              # cancel + dataset registry repair
    "activateDataset",                        # probe + UPDATE + CONFIG sync per schema
    "ensureBackloadAndAssetVelocityObjects",  # thousands of CREATE OR REPLACE
    "ensureObservabilityObjects",             # boot DDL
    "ensureTables",                           # studio DDL set
]

# Files that must contain NO interactive call at all.
BATCH_ONLY_FILES = [ADMIN_SRC / "instrumentation.ts"]


def strip_comments(text: str) -> str:
    """Blank comments, preserving newlines so line numbers stay accurate.

    Load-bearing: this repo documents its own defects in prose, so the files below
    legitimately contain the string `runSql` inside explanations of why they no
    longer call it. Two previous gates here failed on exactly that.
    """
    text = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.DOTALL)
    return re.sub(r"//[^\n]*", "", text)


def iter_sources(root: Path):
    if not root.exists():
        return
    for path in sorted(root.rglob("*")):
        if path.suffix not in {".ts", ".tsx"} or not path.is_file():
            continue
        if "node_modules" in path.parts or ".next" in path.parts:
            continue
        yield path


def main() -> int:
    findings: list[str] = []
    checked = 0

    # --- 0. the transports must exist, or every rule below is vacuous ---
    sql_ts = ADMIN_SRC / "server" / "lib" / "sql.ts"
    if not sql_ts.exists() or f"export async function {BATCH_FN}" not in sql_ts.read_text():
        print(f"FAIL: {BATCH_FN} is not exported from server/lib/sql.ts. Either the "
              f"batch transport was removed or renamed - this gate would silently "
              f"pass everything.")
        return 1
    sa_sf = SA_SRC / "lib" / "snowflake.ts"
    if sa_sf.exists() and "export async function queryBatch" not in sa_sf.read_text():
        print("FAIL: queryBatch is not exported from fleet_sa_app lib/snowflake.ts.")
        return 1

    # --- 1. batch entry points must receive the batch transport ---
    # Matches `name(` ... `)` on one logical call, then inspects the argument list
    # for a bare interactive function reference.
    for root in (ADMIN_SRC, SA_SRC):
        for path in iter_sources(root):
            code = strip_comments(path.read_text(encoding="utf-8", errors="replace"))
            rel = path.relative_to(SKILL_DIR)
            for fn in BATCH_ENTRY_POINTS:
                for m in re.finditer(rf"\b{fn}\s*\(([^;]{{0,400}}?)\)\s*[;,)]", code, re.DOTALL):
                    # Skip the function's own DECLARATION. These modules take the
                    # SQL fn by dependency injection and the parameter is
                    # legitimately named `runSql` - which warehouse it targets is
                    # the CALLER's decision, and the caller is what this gate
                    # checks. Without this, every batch entry point failed on its
                    # own signature.
                    preceding = code[max(0, m.start() - 40):m.start()]
                    if re.search(r"\b(function|const|let|var)\s+$", preceding):
                        continue
                    args = m.group(1)
                    # A type annotation in the arg list means this is a signature,
                    # not a call (e.g. `runSql: (sql: string, ...) => Promise<...>`).
                    if re.search(rf"{INTERACTIVE_FN}\s*:", args):
                        continue
                    # A bare `runSql` argument, not `runSqlBatch`.
                    if re.search(rf"(^|[\s,(]){INTERACTIVE_FN}(?![A-Za-z0-9_])", args):
                        line = code[: m.start()].count("\n") + 1
                        findings.append(
                            f"{rel}:{line}: {fn}(...) receives `{INTERACTIVE_FN}`. "
                            f"{fn} is a BATCH entry point - pass `{BATCH_FN}` so its "
                            f"work lands on the batch warehouse, not the one dashboard "
                            f"reads depend on."
                        )
                    checked += 1

    # --- 2. batch-only files must not call the interactive transport ---
    for path in BATCH_ONLY_FILES:
        if not path.exists():
            continue
        code = strip_comments(path.read_text(encoding="utf-8", errors="replace"))
        rel = path.relative_to(SKILL_DIR)
        for m in re.finditer(rf"\b{INTERACTIVE_FN}\s*\(", code):
            line = code[: m.start()].count("\n") + 1
            findings.append(
                f"{rel}:{line}: calls `{INTERACTIVE_FN}(`. This file is entirely "
                f"boot-time DDL and a background reconciler - nothing here is "
                f"interactive. Use `{BATCH_FN}`."
            )
        # Importing it is equally wrong and is what makes the call possible.
        if re.search(rf"\b{INTERACTIVE_FN}\b\s*}}\s*=\s*await import", code) or \
           re.search(rf"{{\s*{INTERACTIVE_FN}\s*}}", code):
            findings.append(
                f"{rel}: imports `{INTERACTIVE_FN}`. Import `{BATCH_FN}` instead."
            )

    if findings:
        print("FAIL: batch work routed to the interactive warehouse\n")
        for f in findings:
            print(f"  {f}")
        print(f"\n{len(findings)} finding(s). A batch workload on FLEET_APPS_WH starves "
              f"the dashboard reads it shares the warehouse with.")
        return 1

    print(f"PASS: {checked} call site(s) of {len(BATCH_ENTRY_POINTS)} batch entry "
          f"point(s) use the batch transport; instrumentation.ts is batch-only")
    return 0


if __name__ == "__main__":
    sys.exit(main())
