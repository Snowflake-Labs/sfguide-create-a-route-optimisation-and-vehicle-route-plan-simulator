#!/usr/bin/env python3
"""Negative tests for check_batch_transport.py - each case routes a real batch
workload back onto the interactive transport (or removes the transport the gate
keys on) and the gate must name the entry point, file or export at fault.

The headline case is the original defect verbatim: the whole Data Studio
pipeline reached the interactive warehouse through ONE argument at the generate
route. The multi-line case matters because the call-site regex spans newlines,
and a call reformatted across lines is exactly what a later edit produces."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

UI = ".cortex/skills/install-fleet-apps/fleet_admin_app/ui/src"
SA = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src"
INSTR = f"{UI}/instrumentation.ts"

h = Harness("check_batch_transport.py")

h.replace(f"{UI}/app/api/studio/generate/route.ts",
          "startGeneration(config, name, runSqlBatch)",
          "startGeneration(config, name, runSql)",
          expect="startGeneration(...) receives `runSql`",
          name="studio pipeline handed the interactive transport (original defect)")
h.replace(f"{UI}/app/api/studio/datasets/[id]/activate/route.ts",
          "activateDataset(runSqlBatch, id)",
          "activateDataset(runSql, id)",
          expect="activateDataset(...) receives `runSql`",
          name="heavy route handler passes runSql to a batch entry point")
h.replace(INSTR,
          "reconcileStaleJobs(runSqlBatch, null)",
          "reconcileStaleJobs(\n        runSql,\n        null)",
          expect="reconcileStaleJobs(...) receives `runSql`",
          name="interactive transport on a call reformatted across lines")
h.replace(INSTR,
          "await runSqlBatch(`CALL OPENROUTESERVICE_APP.CORE.RECONCILE_AUTO_SUSPEND()`)",
          "await runSql(`CALL OPENROUTESERVICE_APP.CORE.RECONCILE_AUTO_SUSPEND()`)",
          expect="calls `runSql(`. This file is entirely",
          name="bare interactive call in the batch-only instrumentation file")
h.replace(INSTR,
          "const { runSqlBatch } = await import('@/server/lib/sql');",
          "const { runSql } = await import('@/server/lib/sql');",
          expect="imports `runSql`. Import `runSqlBatch` instead",
          name="batch-only file imports the interactive transport")
h.replace(f"{UI}/server/lib/sql.ts",
          "export async function runSqlBatch(",
          "export async function runSqlBulk(",
          expect="runSqlBatch is not exported from server/lib/sql.ts",
          name="admin batch transport renamed (every rule would go vacuous)")
h.replace(f"{SA}/lib/snowflake.ts",
          "export async function queryBatch",
          "export async function queryBulk",
          expect="queryBatch is not exported from fleet_sa_app lib/snowflake.ts",
          name="SA batch transport renamed")
sys.exit(h.finish())
