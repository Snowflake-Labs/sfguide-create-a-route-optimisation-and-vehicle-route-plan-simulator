#!/usr/bin/env python3
"""Guard: a legacy column backfill must be a real no-op when the column exists,
and must not ask Snowflake for something it rejects.

What happened (wgb26798, fresh-machine install on dev): the engine modules
backfilled nine columns with

    ALTER TABLE ... ADD COLUMN IF NOT EXISTS ROAD_FILTER BOOLEAN DEFAULT FALSE;

wrapped in `EXCEPTION WHEN OTHER THEN RETURN 'skipped'`. With a DEFAULT clause
Snowflake raises "ambiguous column name" when the column already exists; the
same ALTER WITHOUT a DEFAULT is a no-op (both measured). A fresh install creates
every column in its CREATE TABLE, so each block took the handler and printed a
`skipped` row into 03_region_management.sql.log / 05_matrix_pipeline.sql.log -
9 per install - while the same handler would have swallowed a real failure. One
migration (IS_DEFAULT) had been disabled outright over it, and the admin boot
DDL ran the same pattern behind a regex that downgraded the error to INFO.

Removing the handler exposed a second defect it had always hidden: the admin's
JOB_EVENTS backfill used `DEFAULT SYSDATE()`, which Snowflake rejects on an
existing table ("Invalid column default expression", measured), so that column
could never have been added to a legacy table at all.

Rules (SQL `--` comments and whole-line `//` / `#` comments are stripped first,
so a comment documenting the trap does not trip the gate):
  A  no `ADD COLUMN IF NOT EXISTS <col> <type> ... DEFAULT ...` - guard the add
     on INFORMATION_SCHEMA.COLUMNS (see 05_matrix_pipeline.sql), or drop the
     DEFAULT when NULL is acceptable for legacy rows
  B  no `ADD COLUMN ... DEFAULT <function or CURRENT_*>` - a non-constant
     default cannot be added to an existing table
Scope: tracked .sql/.ts/.tsx/.js/.mjs/.mts/.py/.sh files outside node_modules
and logs/, minus this gate and its negative test.

Usage:  python3 .cortex/skills/install-fleet-apps/scripts/check_add_column_default.py
Exit:   0 clean, 1 violation
"""
from __future__ import annotations

import os
import pathlib
import re
import subprocess
import sys

REPO = pathlib.Path(os.environ.get("GATE_REPO") or pathlib.Path(__file__).resolve().parents[4])
SELF = {"check_add_column_default.py", "check_add_column_default_negative.py"}
EXT = re.compile(r"\.(sql|ts|tsx|js|mjs|mts|py|sh)$")
# A column definition up to its DEFAULT, never crossing a statement or list boundary.
COLDEF = r"(\"?[A-Za-z_][\w$]*\"?)\s+[^;,`'\"]*?\bDEFAULT\b"
RULE_A = re.compile(r"ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+" + COLDEF, re.I | re.S)
RULE_B = re.compile(r"ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?" + COLDEF
                    + r"\s+(?:[A-Za-z_][\w$.]*\s*\(|CURRENT_\w+|LOCALTIMESTAMP|SYSDATE)", re.I | re.S)


def strip_comments(text: str) -> str:
    text = re.sub(r"--[^\n]*", "", text)
    return re.sub(r"(?m)^\s*(//|#)[^\n]*", "", text)


def main() -> int:
    files = subprocess.run(["git", "-C", str(REPO), "ls-files", "--cached", "--others",
                            "--exclude-standard"], capture_output=True, text=True,
                           check=True).stdout.split("\n")
    failures: list[str] = []
    scanned = with_add = 0
    for rel in files:
        if (not rel or not EXT.search(rel) or "node_modules/" in rel or rel.startswith("logs/")
                or "/logs/" in rel or pathlib.PurePosixPath(rel).name in SELF):
            continue
        p = REPO / rel
        if not p.is_file():
            continue
        text = strip_comments(p.read_text(errors="ignore"))
        scanned += 1
        if re.search(r"ADD\s+COLUMN", text, re.I):
            with_add += 1
        for rule, pat, why in (
                ("A", RULE_A, "ADD COLUMN IF NOT EXISTS with a DEFAULT raises \"ambiguous column "
                              "name\" when the column exists - guard on INFORMATION_SCHEMA.COLUMNS "
                              "or drop the DEFAULT"),
                ("B", RULE_B, "a non-constant DEFAULT cannot be added to an existing table "
                              "(\"Invalid column default expression\")")):
            for m in pat.finditer(text):
                line = text.count("\n", 0, m.start()) + 1
                failures.append(f"{rule} {rel}:{line} column {m.group(1)}: {why}")
    if with_add < 5:
        failures.append(f"only {with_add} scanned file(s) contain ADD COLUMN (of {scanned}) - "
                        "the scan is not seeing the modules it exists for")
    if failures:
        print("FAILED: column backfills that are not a clean no-op")
        for f in failures:
            print("  - " + f)
        return 1
    print(f"PASSED: {with_add} of {scanned} scanned files add columns; none uses IF NOT EXISTS "
          "with a DEFAULT or a non-constant DEFAULT.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
