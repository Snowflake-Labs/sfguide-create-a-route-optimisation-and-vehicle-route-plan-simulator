#!/usr/bin/env python3
"""Fail when the dynamic read allowlist disagrees with itself.

WHY THIS EXISTS
---------------
The set of databases an agent-emitted query may read is encoded in FOUR places,
and nothing compared them:

  1. ALLOWED_DYNAMIC_DBS in fleet_sa_app/ui/src/app/api/query/route.ts
     - the runtime pre-filter that produces the user-visible error.
  2. ALLOWED_DYNAMIC_DBS in fleet_tools/user/src/codes.ts
     - the render_map verb's in-turn rejection (INVALID_MAP_SPEC_DB).
  3. FLEET_APP_DYNAMIC_READER's grants in fleet_sa_app/app/role_binding.sql
     - the AUTHORITATIVE boundary; an ungranted database is unreachable whatever
       the other three say.
  4. instructions.orchestration in agent-spec.json / super-agent-spec.json
     - what the agent actually believes.

They drifted, and the drift shipped: the specs told the agent "LIVE ROUTING
GEOMETRY IS MAPPABLE HERE: a layer query may call ROUTING_PLATFORM.CONTRACT..."
while (1) listed only FLEET_APP and SNOWFLAKE and (3) held no ROUTING_PLATFORM
grant at all. The agent obeyed the prose. Asked for a route it drew one correct
map from get_directions and one EMPTY map from render_map carrying "Dynamic query
may only reference FLEET_APP, SNOWFLAKE; found 'ROUTING_PLATFORM'".

None of the existing 22 gates could see it. The prose lives in a single-line
20,000-character JSON string, the grants in SQL, the lists in TypeScript; each
half is internally valid, compiles, deploys, and passes every test. The defect is
only visible by comparing them, which is what this does.

WHAT IT CHECKS
--------------
RULE A  route.ts and codes.ts declare the SAME set.

RULE B  every database in that set other than SNOWFLAKE has a
        `GRANT USAGE ON DATABASE <db> TO ROLE FLEET_APP_DYNAMIC_READER` in
        role_binding.sql. SNOWFLAKE is exempt: access there comes from the
        SNOWFLAKE.CORTEX_USER database role, not a USAGE grant.

RULE C  inside the map-authoring block of the orchestration prose, no database is
        named as queryable that the code refuses. Scoped to 3-part qualified names
        (DB.SCHEMA.OBJECT), the same shape the runtime filter matches.

        The SCOPE matters and is not a shortcut. Only render_map layer queries run
        through the dynamic boundary; the rest of the orchestration legitimately
        tells the agent to reach FLEET_INTELLIGENCE.SEMANTIC_OPS.* and other
        databases through run_sql and the ops verbs, which run as different roles
        entirely. Checking the whole string would flag those as violations and the
        gate would be turned off within a week.

RULE D  every allowed database appears in that same block. A capability the code
        permits and the map guidance never mentions is a capability the agent will
        not use, which is the mirror image of the shipped defect.

Deliberately NOT checked: that the grants cover the right SCHEMAS or functions
inside an allowed database. That is a much larger surface (the FLEET_APP LIVE_*
UDTFs are a known gap), it varies legitimately per database, and a coarse rule
there would produce noise rather than prevent this defect class.

Run with no arguments. Exits non-zero naming the file and the disagreement.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ROUTE_TS = ROOT / "fleet_sa_app" / "ui" / "src" / "app" / "api" / "query" / "route.ts"
CODES_TS = ROOT / "fleet_tools" / "user" / "src" / "codes.ts"
ROLE_SQL = ROOT / "fleet_sa_app" / "app" / "role_binding.sql"
SPECS = [
    ROOT / "fleet_sa_app" / "app" / "agent-spec.json",
    ROOT / "fleet_sa_app" / "app" / "super-agent-spec.json",
]

READER = "FLEET_APP_DYNAMIC_READER"
# Access to SNOWFLAKE comes from the CORTEX_USER database role, never a USAGE grant.
GRANT_EXEMPT = {"SNOWFLAKE"}

# Same shape /api/query matches: DB.SCHEMA.OBJECT.
QUALIFIED = re.compile(
    r"\b([A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*[A-Za-z_][A-Za-z0-9_$]*\s*\.\s*[A-Za-z_][A-Za-z0-9_$]*"
)

# The orchestration block that instructs render_map LAYER QUERIES - the only prose
# governed by the dynamic read boundary. Other blocks (run_sql, the ops verbs)
# legitimately name other databases and run as other roles.
MAP_BLOCK_HEAD = "DRAWING A MAP INLINE"
# A block ends at the next section header: a non-bullet line ending in ':'.
BLOCK_END = re.compile(r"^(?!-)[^\n]*:$")

failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


def parse_list(path: Path) -> set[str] | None:
    """Extract the string literals from `ALLOWED_DYNAMIC_DBS = ...` in a .ts file.

    Tolerates both forms in use: `new Set([...])` and a plain `[...] as const`.
    """
    text = path.read_text()
    m = re.search(r"ALLOWED_DYNAMIC_DBS\s*=\s*(?:new\s+Set\s*\(\s*)?\[(.*?)\]", text, re.S)
    if not m:
        fail(f"{path.name}: no ALLOWED_DYNAMIC_DBS declaration found")
        return None
    dbs = {s.upper() for s in re.findall(r"['\"]([A-Za-z0-9_$]+)['\"]", m.group(1))}
    if not dbs:
        fail(f"{path.name}: ALLOWED_DYNAMIC_DBS is empty")
        return None
    return dbs


def map_block(orch: str) -> str | None:
    """The render_map layer-query block, or None when the header is gone.

    A missing header is itself a failure: the rules below would otherwise pass
    vacuously on a spec that no longer documents inline maps at all.
    """
    lines = orch.split("\n")
    start = next((i for i, ln in enumerate(lines) if ln.strip().startswith(MAP_BLOCK_HEAD)), None)
    if start is None:
        return None
    out = [lines[start]]
    for ln in lines[start + 1:]:
        if BLOCK_END.match(ln.strip()):
            break
        out.append(ln)
    return "\n".join(out)


def main() -> int:
    route_dbs = parse_list(ROUTE_TS)
    codes_dbs = parse_list(CODES_TS)
    if route_dbs is None or codes_dbs is None:
        report()
        return 1

    # RULE A
    if route_dbs != codes_dbs:
        only_route = ", ".join(sorted(route_dbs - codes_dbs)) or "-"
        only_codes = ", ".join(sorted(codes_dbs - route_dbs)) or "-"
        fail(
            "RULE A: ALLOWED_DYNAMIC_DBS differs between the runtime filter and the verb.\n"
            f"  only in {ROUTE_TS.name}: {only_route}\n"
            f"  only in {CODES_TS.name}: {only_codes}\n"
            "  The verb would accept a spec the app then refuses (or the reverse)."
        )

    allowed = route_dbs | codes_dbs

    # RULE B
    sql = ROLE_SQL.read_text()
    for db in sorted(allowed - GRANT_EXEMPT):
        pat = re.compile(
            rf"GRANT\s+USAGE\s+ON\s+DATABASE\s+{re.escape(db)}\s+TO\s+ROLE\s+{READER}\b",
            re.I,
        )
        if not pat.search(sql):
            fail(
                f"RULE B: '{db}' is in the allowlist but {ROLE_SQL.name} never grants "
                f"USAGE ON DATABASE {db} to {READER}.\n"
                "  The allowlist would let the query through and the reader role would "
                "then fail with 'does not exist or not authorized' - which reads as a "
                "broken agent rather than a missing grant."
            )

    # RULES C and D
    for spec_path in SPECS:
        spec = json.loads(spec_path.read_text())
        orch = spec.get("instructions", {}).get("orchestration", "")
        if not orch:
            fail(f"{spec_path.name}: instructions.orchestration is missing or empty")
            continue
        block = map_block(orch)
        if block is None:
            fail(
                f"{spec_path.name}: no '{MAP_BLOCK_HEAD}' block in instructions.orchestration, "
                "so nothing tells the agent which databases a map layer may read."
            )
            continue
        for db in sorted({m.group(1).upper() for m in QUALIFIED.finditer(block)} - allowed):
            fail(
                f"RULE C: {spec_path.name} tells the agent a map layer may query '{db}.*', "
                "which the dynamic read boundary refuses.\n"
                f"  Allowed: {', '.join(sorted(allowed))}. Either remove the instruction or "
                "add the database to the allowlist AND grant the reader."
            )
        for db in sorted(allowed - GRANT_EXEMPT):
            if db not in block:
                fail(
                    f"RULE D: '{db}' is allowed by the code but the map-authoring block of "
                    f"{spec_path.name} never mentions it, so the agent will never use it "
                    "for a map."
                )

    report()
    return 1 if failures else 0


def report() -> None:
    if failures:
        print("check_dynamic_allowlist: FAILED\n")
        for f in failures:
            print(f"- {f}\n")
    else:
        print(
            "check_dynamic_allowlist: PASSED - the runtime filter, the verb, the reader's "
            "grants and both agent specs agree on one set of databases"
        )


if __name__ == "__main__":
    sys.exit(main())
