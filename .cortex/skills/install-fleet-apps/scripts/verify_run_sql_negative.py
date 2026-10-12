#!/usr/bin/env python3
"""Negative tests for fleet_tools/user/verify_run_sql.mts - each case weakens one
of run_sql's read-only guards (or the governed-path nudge) the way a plausible
refactor would, and the suite must name the exact case that slipped through."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

USER = ".cortex/skills/install-fleet-apps/fleet_tools/user"
PROC = f"{USER}/src/procs/run_sql.ts"

h = Harness("verify_run_sql.mts", path=f"{USER}/verify_run_sql.mts", cwd=USER,
            cmd=["npx", "tsx"])

# Guard 3: an allowlist, never a denylist. The denylist shape lets every
# writing verb it forgot straight through.
h.replace(PROC, "if (!ALLOWED_LEADING.includes(leading)) {",
          "if (['DROP', 'DELETE', 'TRUNCATE'].includes(leading)) {",
          expect="expected=SQL_NOT_READ_ONLY got=null  (insert)",
          name="leading-keyword allowlist reverted to a denylist")

# Guard 2: the multi-statement check is what stops a piggybacked DROP.
h.replace(PROC, "if (withoutTrailing.includes(';')) {", "if (false) {",
          expect="expected=SQL_MULTI_STATEMENT got=null  (piggybacked statement)",
          name="multi-statement guard removed")

# Literals must be blanked, or a semicolon inside 'a;b' reads as a separator.
h.replace(PROC, """if (ch === "'" || ch === '"') {""", """if (ch === '"') {""",
          expect="expected=null got=SQL_MULTI_STATEMENT  (semicolon inside a literal is not a separator)",
          name="single-quoted literals no longer blanked")

# max_rows must be a positive INTEGER.
h.replace(PROC, "m <= 0 || Math.floor(m) !== m", "m <= 0",
          expect="max_rows=1.5 expected=INVALID_MAX_ROWS got=null",
          name="fractional max_rows accepted")

# Nudge: the schema-qualified short form (after a USE) must still match.
h.replace(PROC, "if (!upper.includes(fqn) && !upper.includes(shortName)) continue;",
          "if (!upper.includes(fqn)) continue;",
          expect="nudge expected=true got=false  (schema-qualified short form (after a USE))",
          name="governed nudge matches only fully qualified names")

# Nudge: matching must be case-insensitive.
h.replace(PROC, "const upper = sql.toUpperCase();", "const upper = sql;",
          expect="nudge expected=true got=false  (lower case must still match)",
          name="governed nudge became case-sensitive")

sys.exit(h.finish())
