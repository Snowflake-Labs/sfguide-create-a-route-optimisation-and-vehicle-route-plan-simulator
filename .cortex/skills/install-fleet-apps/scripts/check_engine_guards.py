#!/usr/bin/env python3
"""Fail when installer SQL creates an object that needs the routing engine.

Why this exists
---------------
`analytic_layer.sql` used to define its live-routing UDTFs inline. A `LANGUAGE SQL`
UDTF body is resolved at CREATE time, so on a deployment without the routing engine
the first of them was a hard error - and because `snow sql -f` is
stop-on-first-error, that aborted the file at line 1072 of 2722 and silently
discarded ~129 later statements. Most of the casualties needed no engine at all:
the six FLEET_INTELLIGENCE.SOURCING tables, the nine FLEET_APP.SOURCING views, the
FLEET_APP.LOCATION passthrough views and the closing validation SELECT. The
installer reported only "dependent views will be empty", and three consecutive
installs were signed off as clean while whole schemas were missing.

The fix was to move every engine-dependent CREATE into
`analytic_layer_live_routing.sql`, which the installer runs separately and is
allowed to fail as a unit. This gate keeps it that way: adding an engine-dependent
CREATE back into an engine-free file reintroduces the abort, and the symptom
(missing objects two schemas away, three steps later) is nowhere near the cause.

Note the wrapper escape hatch used elsewhere in these files -
`EXECUTE IMMEDIATE <dollar-quoted> BEGIN ... EXCEPTION ... END` - is NOT available
here: these statements carry dollar-quoted function bodies and Snowflake
dollar-quotes do not nest, so the wrapper terminates on the body's own delimiter.
Splitting the file is the only correct fix, hence a gate rather than a lint hint.

What it deliberately does NOT do
-------------------------------
* It does not flag engine TABLE references. A `REGION_CATALOG` stub is created by
  seed_data.sql, so naming a table resolves on an engine-less account.
* It does not flag references inside a dollar-quoted body. A procedure body is
  resolved when CALLED, not when the file loads, so it cannot abort the load. This
  is why the guarded builder CALLs in analytic_layer.sql are legitimate.
* It does not flag comments, which routinely name the function they discuss.
* It does not police the engine's own modules, or the live-routing file itself.

Usage:  python3 check_engine_guards.py
Exit:   0 clean, 1 an engine-free file creates an engine-dependent object
"""
from __future__ import annotations

import pathlib
import re
import sys

SKILL = pathlib.Path(__file__).resolve().parent.parent
MODULES = SKILL / "openrouteservice_app" / "app" / "modules"

# Files the installer applies with a bare `snow sql -f`, where one error abandons
# every later statement. These must stay engine-free.
ENGINE_FREE = (
    "scripts/analytic_layer.sql",
    "scripts/delivery_sync_layer.sql",
    "scripts/seed_data.sql",
    "scripts/projection_views.sql",
    "scripts/vehicle_profile_catalog.sql",
    "fleet_sa_app/app/scoped_contract.sql",
    "fleet_sa_app/app/semantic_views.sql",
    "fleet_sa_app/app/view_catalog.sql",
    "fleet_sa_app/app/deployment_facts.sql",
    "fleet_sa_app/app/role_binding.sql",
)

# Allowed to reference the engine: it is applied separately and may fail as a unit.
LIVE_ROUTING = "scripts/analytic_layer_live_routing.sql"

COMMENT_RE = re.compile(r"--[^\n]*")
# A dollar-quoted body is DEFERRED - resolved on CALL, not on load - so it cannot
# abort the file. Same rule check_install_order.py uses, and the reason the guarded
# builder CALLs in analytic_layer.sql are fine.
DOLLAR_BODY_RE = re.compile(r"\$\$.*?\$\$", re.S)
# Only a CREATE can bake an unresolvable reference into a stored object.
CREATE_RE = re.compile(
    r"\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:SECURE\s+)?"
    r"(?:FUNCTION|VIEW|TABLE|PROCEDURE|MATERIALIZED\s+VIEW)"
    r"(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Z_0-9]+(?:\.[A-Z_0-9]+){0,2})",
    re.I,
)


def engine_functions() -> set[str]:
    """Names of OPENROUTESERVICE_APP.CORE FUNCTIONS, read from the engine modules.

    Derived rather than hardcoded so the gate cannot drift: a routing function added
    to the engine is covered the moment it is committed. Only FUNCTIONS matter -
    a missing PROCEDURE is a runtime CALL failure, and a missing TABLE resolves
    against the seed_data.sql stub.
    """
    found: set[str] = set()
    pat = re.compile(
        r"\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:SECURE\s+)?FUNCTION\s+"
        r"(?:OPENROUTESERVICE_APP\.)?CORE\.([A-Z_0-9]+)",
        re.I,
    )
    for path in sorted(MODULES.glob("*.sql")) if MODULES.is_dir() else []:
        for name in pat.findall(path.read_text(errors="ignore")):
            found.add(name.upper())
    return found


def statements(body: str):
    """Yield (line_no, text) for each top-level statement, dollar-quote aware."""
    lines = body.split("\n")
    i, n = 0, len(lines)
    starter = re.compile(
        r"^(CREATE|DROP|GRANT|EXECUTE IMMEDIATE|ALTER|MERGE|INSERT|CALL|SELECT|USE)\b",
        re.I,
    )
    while i < n:
        if starter.match(lines[i]):
            depth, j = 0, i
            while j < n:
                depth += lines[j].count("$$")
                if depth % 2 == 0 and lines[j].rstrip().endswith(";"):
                    break
                j += 1
            yield i + 1, "\n".join(lines[i : j + 1])
            i = j + 1
        else:
            i += 1


def check(path: pathlib.Path, fns: set[str]) -> list[str]:
    if not path.exists():
        return []
    raw = path.read_text(errors="ignore")
    # Comments first: prose about this very defect names ISOCHRONES repeatedly.
    body = COMMENT_RE.sub("", raw)
    ref = re.compile(
        r"\bOPENROUTESERVICE_APP\.CORE\.(" + "|".join(sorted(fns, key=len, reverse=True)) + r")\b",
        re.I,
    )
    problems = []
    for line_no, stmt in statements(body):
        m = CREATE_RE.match(stmt)
        if not m:
            continue
        # Strip deferred bodies, then see if the engine is still named.
        top = DOLLAR_BODY_RE.sub(" ", stmt)
        hit = ref.search(top)
        if not hit:
            # A SQL UDTF body is NOT deferred - it resolves at CREATE - so for a
            # FUNCTION the dollar-quoted body counts as top-level too.
            if re.match(r"\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:SECURE\s+)?FUNCTION", stmt, re.I):
                hit = ref.search(stmt)
        if hit:
            problems.append(
                f"{path.relative_to(SKILL)}:{line_no} creates {m.group(1)} which calls "
                f"OPENROUTESERVICE_APP.CORE.{hit.group(1).upper()} - move this statement to "
                f"{LIVE_ROUTING} (a SQL function body resolves at CREATE time, so on an "
                f"engine-less install this aborts the whole file and silently drops every "
                f"later statement)"
            )
    return problems


def main() -> int:
    fns = engine_functions()
    if not fns:
        print("FAILED: engine-guards check")
        print(f"  - no OPENROUTESERVICE_APP.CORE functions found under {MODULES}")
        print("    The gate derives its function list from the engine modules; an empty")
        print("    list would silently pass every file, so this is an error not a skip.")
        return 1
    print(f"  engine functions discovered: {len(fns)}")

    problems: list[str] = []
    for rel in ENGINE_FREE:
        path = SKILL / rel
        found = check(path, fns)
        state = f"{len(found)} problem(s)" if found else "clean"
        if not path.exists():
            state = "absent"
        print(f"  {rel:52s} {state}")
        problems.extend(found)

    print()
    if problems:
        print("FAILED: engine-guards check")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("PASSED: no engine-free installer SQL creates an object that needs the routing engine")
    return 0


if __name__ == "__main__":
    sys.exit(main())
