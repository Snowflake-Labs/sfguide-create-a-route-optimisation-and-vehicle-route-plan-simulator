#!/usr/bin/env python3
"""Guard: matrix-builder API routes must allowlist the routing profile and the
H3 resolution before either reaches SQL.

What happened (PR 160, CWE-89): /api/matrix/build built TRAVEL_MATRIX table
names and job ids from `profile.replace(/-/g, '_').toUpperCase()`, and kept any
resolution that compared `>= 5 && <= 10` (so "6e0" or 7.5 passed). `runSql` has
no bind parameters, and escapeString only protects quoted literals - a profile
inside an unquoted identifier like `<REGION>_<PROFILE>_LIST_RES7` was raw SQL.
The DELETE, restore, existing, cost-estimate and status routes had the same
shape.

Rules (TypeScript comments are stripped first, so a comment that MENTIONS a
symbol cannot satisfy a rule):
  A  no matrix route derives SQL from a raw profile/resolution: no
     `profile.replace(`, `escapeString(profile)`, `sanitizeIdentifier(resolution)`,
     `(resolutions as number[]).filter`, or `String(j.profile ...)`
  B  every route that takes a profile / resolution(s) calls the matching
     validator, and calls it BEFORE its first runSql/submitSqlAsync/callProcedure
     (status/route.ts validates stored rows, so there it must precede the per-row
     `SELECT COUNT(*)` instead of the jobs query that produced the rows)
  C  sanitizeProfile checks ROUTING_PROFILES; sanitizeResolutions requires
     Number.isInteger within MIN_RES=5..MAX_RES=10; sanitizeResolution bounds
     by the same constants

Usage:  python3 .cortex/skills/install-fleet-apps/scripts/check_admin_sql_inputs.py
Exit:   0 clean, 1 violation
"""
from __future__ import annotations

import os
import pathlib
import re
import sys

REPO = pathlib.Path(os.environ.get("GATE_REPO") or pathlib.Path(__file__).resolve().parents[4])
UI = REPO / ".cortex/skills/install-fleet-apps/fleet_admin_app/ui/src"
MATRIX = UI / "app/api/matrix"
SANITIZE = UI / "server/lib/sanitize.ts"

# route (relative to MATRIX) -> validators it must call before any SQL
ROUTES = {
    "build/route.ts": ["sanitizeProfile", "sanitizeResolutions"],
    "existing/route.ts": ["sanitizeProfile"],
    "cost-estimate/route.ts": ["sanitizeResolutions"],
    "status/route.ts": ["sanitizeProfile", "sanitizeResolution"],
    "[region]/[profile]/[resolution]/route.ts": ["sanitizeProfile", "sanitizeResolution"],
    "[region]/[profile]/[resolution]/restore/route.ts": ["sanitizeProfile", "sanitizeResolution"],
}

FORBIDDEN = [
    (r"\bprofile\s*\.\s*replace\s*\(", "`profile.replace(` builds an identifier from a raw profile"),
    (r"escapeString\(\s*profile\s*\)", "`escapeString(profile)` on a raw profile (escaping is not validation)"),
    (r"sanitizeIdentifier\(\s*resolution\s*\)", "`sanitizeIdentifier(resolution)` accepts any identifier as a resolution"),
    (r"as\s+number\[\]\s*\)\s*\.\s*filter", "`(resolutions as number[]).filter` trusts an unchecked array"),
    (r"String\(\s*j\.profile", "`String(j.profile ...)` turns a stored row into a table name unchecked"),
]

SQL_CALL = re.compile(r"\b(runSql|submitSqlAsync|callProcedure)\s*\(")

failures: list[str] = []


def code(p: pathlib.Path) -> str:
    """Source with /* */ and // comments removed (string contents kept)."""
    text = p.read_text()
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"(?<![:'\"`])//[^\n]*", "", text)


def fail(msg: str) -> None:
    failures.append(msg)


for rel, validators in ROUTES.items():
    p = MATRIX / rel
    if not p.exists():
        fail(f"B {rel} is missing - update ROUTES if it moved")
        continue
    src = code(p)
    for pat, why in FORBIDDEN:
        if re.search(pat, src):
            fail(f"A {rel}: {why}")
    first_sql = SQL_CALL.search(src)
    if rel == "status/route.ts":
        first_sql = re.search(r"\b(runSql)\s*\(\s*`SELECT COUNT", src)
    for v in validators:
        call = re.search(rf"\b{v}\s*\(", src)
        if not call:
            fail(f"B {rel} does not call {v}")
        elif first_sql and call.start() > first_sql.start():
            fail(f"B {rel} calls {v} after its first {first_sql.group(1)}")

lib = code(SANITIZE)


def body(name: str) -> str:
    m = re.search(rf"export function {name}\b.*?\n}}", lib, flags=re.S)
    if not m:
        fail(f"C sanitize.ts has no {name}")
        return ""
    return m.group(0)


if "ROUTING_PROFILES" not in body("sanitizeProfile"):
    fail("C sanitizeProfile does not check ROUTING_PROFILES")
many = body("sanitizeResolutions")
if "Number.isInteger" not in many:
    fail("C sanitizeResolutions does not require Number.isInteger")
for b, n in ((many, "sanitizeResolutions"), (body("sanitizeResolution"), "sanitizeResolution")):
    if not ("MIN_RES" in b and "MAX_RES" in b):
        fail(f"C {n} is not bounded by MIN_RES..MAX_RES")
if not re.search(r"const MIN_RES = 5;", lib) or not re.search(r"const MAX_RES = 10;", lib):
    fail("C MIN_RES/MAX_RES are not 5/10")

if failures:
    print("check_admin_sql_inputs: FAIL")
    for f in failures:
        print(f"  {f}")
    sys.exit(1)
print(f"check_admin_sql_inputs: ok ({len(ROUTES)} matrix routes allowlist profile/resolution before SQL)")
