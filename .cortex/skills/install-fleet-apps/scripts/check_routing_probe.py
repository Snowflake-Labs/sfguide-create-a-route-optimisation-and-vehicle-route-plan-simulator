#!/usr/bin/env python3
"""Validate the routing TOOL_* procedures against four failure modes that are
each SILENT or indistinguishable from a slow engine.

All four were live on 2026-09-14, found by decomposing one hung "show me the
route from SF to LA" agent turn in QUERY_HISTORY. The parent CALL ran 840.6 s and
was killed; 839.7 s of it sat in a single statement that never routed anything.

RULE A - no live ORS_STATUS probe inside a TOOL_* procedure body.
    Every TOOL_* proc opened with
        BEGIN
          SELECT OBJECT_KEYS(CORE.ORS_STATUS(NULL):profiles) INTO :v_available;
        EXCEPTION WHEN OTHER THEN v_available := NULL;
        END;
    and its own comment called this "best-effort". It is not. EXCEPTION WHEN
    OTHER catches an ERROR, never a HANG, and ORS_STATUS is a service function
    whose call the platform retries past the SPCS ingress cut-off, so there is no
    bound at all - a procedure cannot even ALTER SESSION SET
    STATEMENT_TIMEOUT_IN_SECONDS to impose one. ORS_STATUS normally answers in
    0.3 s (measured across ~900 calls), which is exactly why this survived: it is
    invisible until the gateway restarts, and then it consumes the whole
    statement budget of every routing question at once. The profile list is a
    table read now (CORE.PROFILES_FOR_REGION); the probe lives in
    CORE.REFRESH_REGION_PROFILES, called from provisioning.

RULE B - TOOL_DIRECTIONS must pass a region to CORE.DIRECTIONS.
    CORE.DIRECTIONS(method, locations, region DEFAULT NULL) has always taken a
    region and TOOL_DIRECTIONS always omitted it, so the gateway resolved NULL to
    DEFAULT_REGION_NAME ('SanFrancisco') for EVERY call. That graph spans
    lat 37.71-37.81 / lon -122.51--122.37, so a Los Angeles coordinate is
    off-graph and the route could not have succeeded even had the probe returned.
    Nothing failed loudly: a 2-arg call compiles, and the sibling TOOL_ISOCHRONE
    already resolved a region, so the defect looked like a distance limit.

RULE C - the pre-flight leg check must cast the matrix duration ::FLOAT.
    ORS writes an unroutable matrix cell as a JSON null, and a VARIANT JSON null
    is NOT SQL NULL: `R:durations[0][1] IS NULL` returns FALSE for it (verified -
    IS_NULL_VALUE TRUE, ::FLOAT IS NULL TRUE). The first version of that gate ran
    on the very Maui-to-Boise pair it was written for and reported zero
    unroutable legs. A check that executes and cannot convict is worse than no
    check, because it is reported as a pass.

RULE D - the stale 2-arg TOOL_DIRECTIONS must be dropped BEFORE the CREATE.
    Snowflake keys procedures on full arity, so the old (VARCHAR, VARCHAR) body
    survives CREATE OR REPLACE of the 3-arg form and keeps serving every 2-arg
    caller - including the synapse get_directions verb - with exactly the code
    this fix removes. And because REGION is defaulted, both signatures accept two
    arguments, so ordering is not cosmetic: a DROP placed after the CREATE fails
    the install outright with "Cannot overload PROCEDURE TOOL_DIRECTIONS as it
    would cause ambiguous PROCEDURE overloading", and `snow sql -f` then abandons
    every statement below it.

Exit 0 clean, 1 on any violation.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
TOOLS_SQL = REPO / ".cortex/skills/routing-agent/references/deploy-agent.sql"
MODULE_SQL = (
    REPO
    / ".cortex/skills/install-fleet-apps/openrouteservice_app/app/modules/02_routing_functions.sql"
)

# The probe is legal in exactly these owners: the maintenance procedure whose
# whole purpose is to probe once, and the region-status/diagnostic procs that
# report engine state rather than route. Anything else is a routing path.
PROBE_ALLOWED_OWNERS = {
    "REFRESH_REGION_PROFILES",
    "TOOL_REGION_STATUS",
    "TOOL_REGION_DIAGNOSTICS",
}


def strip_comment_lines(sql: str) -> str:
    """Blank out whole-line comments, preserving line numbering.

    Load-bearing, and it is the rule that motivated it that proves why: these
    files DISCUSS the very patterns they must not contain. RULE A's own
    explanation names ORS_STATUS six times and RULE C's names
    `R:durations[0][1] IS NULL` verbatim, so an unstripped scan convicts
    RESOLVE_PROFILE (whose header comment mentions the probe) and the fixed
    TOOL_DIRECTIONS (whose comment quotes the uncast form). Only leading-comment
    lines are removed - `--`, `//`, `#`, `*` - never trailing text, because
    stripping mid-line would need a string-aware parser and the risk there runs
    the wrong way: a false NEGATIVE hides a live defect.
    """
    out = []
    for line in sql.split("\n"):
        s = line.lstrip()
        out.append("" if s.startswith(("--", "//", "#", "*")) else line)
    return "\n".join(out)


def split_procs(sql: str) -> list[tuple[str, int, str]]:
    """(owner_name, start_line, body) for each CREATE PROCEDURE/FUNCTION."""
    out: list[tuple[str, int, str]] = []
    pat = re.compile(
        r"CREATE\s+OR\s+REPLACE\s+(?:PROCEDURE|FUNCTION)\s+([A-Z0-9_.]+)\s*\(",
        re.I,
    )
    marks = [(m.start(), m.group(1).split(".")[-1].upper()) for m in pat.finditer(sql)]
    for idx, (pos, name) in enumerate(marks):
        end = marks[idx + 1][0] if idx + 1 < len(marks) else len(sql)
        out.append((name, sql.count("\n", 0, pos) + 1, sql[pos:end]))
    return out


def rule_a(sql: str) -> list[str]:
    bad = []
    for name, line, body in split_procs(sql):
        if name in PROBE_ALLOWED_OWNERS:
            continue
        for m in re.finditer(r"\bORS_STATUS\s*\(", body):
            hit_line = line + body.count("\n", 0, m.start())
            bad.append(
                f"RULE A: {name} (line ~{hit_line}) calls ORS_STATUS on a routing path. "
                f"An EXCEPTION handler cannot catch the hang; read "
                f"CORE.PROFILES_FOR_REGION instead."
            )
    return bad


def rule_b(sql: str) -> list[str]:
    procs = {n: (l, b) for n, l, b in split_procs(sql)}
    if "TOOL_DIRECTIONS" not in procs:
        return ["RULE B: TOOL_DIRECTIONS not found in " + TOOLS_SQL.name]
    line, body = procs["TOOL_DIRECTIONS"]
    calls = re.findall(
        r"OPENROUTESERVICE_APP\.CORE\.DIRECTIONS\s*\((.*?)\)\)\s*d", body, re.S
    )
    if not calls:
        return [
            "RULE B: TOOL_DIRECTIONS makes no recognisable CORE.DIRECTIONS call - "
            "the region-argument check cannot run, so this is a failure, not a skip."
        ]
    bad = []
    for arglist in calls:
        # Top-level commas only: OBJECT_CONSTRUCT(...) contains its own.
        depth, parts, cur = 0, [], ""
        for ch in arglist:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            if ch == "," and depth == 0:
                parts.append(cur)
                cur = ""
            else:
                cur += ch
        parts.append(cur)
        if len(parts) < 3 or not parts[2].strip():
            bad.append(
                f"RULE B: TOOL_DIRECTIONS (line ~{line}) calls CORE.DIRECTIONS with "
                f"{len(parts)} argument(s) and no region. The gateway then resolves "
                f"NULL to DEFAULT_REGION_NAME, so every route runs on the default "
                f"region's graph regardless of where the places are."
            )
    return bad


def rule_c(sql: str) -> list[str]:
    procs = {n: (l, b) for n, l, b in split_procs(sql)}
    if "TOOL_DIRECTIONS" not in procs:
        return []
    line, body = procs["TOOL_DIRECTIONS"]
    cells = re.findall(r"durations\[[^\]]+\]\[[^\]]+\]\s*(::[A-Z]+)?", body, re.I)
    if not cells:
        return [
            f"RULE C: TOOL_DIRECTIONS (line ~{line}) indexes no matrix durations cell. "
            f"The unroutable-leg pre-flight is missing, so an unroutable pair falls "
            f"through to DIRECTIONS and burns the statement timeout."
        ]
    bad = []
    for cast in cells:
        if (cast or "").upper() != "::FLOAT":
            bad.append(
                f"RULE C: TOOL_DIRECTIONS (line ~{line}) reads a matrix durations cell "
                f"without ::FLOAT (found {cast or 'no cast'}). ORS writes an unroutable "
                f"cell as a JSON null and `IS NULL` is FALSE for that, so the leg check "
                f"passes vacuously on exactly the pairs it exists to reject."
            )
    return bad


def rule_d(sql: str) -> list[str]:
    drop = re.search(
        r"DROP\s+PROCEDURE\s+IF\s+EXISTS\s+FLEET_INTELLIGENCE\.ROUTING_TOOLS\."
        r"TOOL_DIRECTIONS\s*\(\s*VARCHAR\s*,\s*VARCHAR\s*\)",
        sql,
        re.I,
    )
    create = re.search(
        r"CREATE\s+OR\s+REPLACE\s+PROCEDURE\s+FLEET_INTELLIGENCE\.ROUTING_TOOLS\."
        r"TOOL_DIRECTIONS",
        sql,
        re.I,
    )
    if not create:
        return ["RULE D: no CREATE for TOOL_DIRECTIONS found"]
    sig = re.search(
        r"CREATE\s+OR\s+REPLACE\s+PROCEDURE\s+FLEET_INTELLIGENCE\.ROUTING_TOOLS\."
        r"TOOL_DIRECTIONS\s*\((.*?)\)\s*RETURNS",
        sql,
        re.S | re.I,
    )
    arity = len(re.findall(r"\bVARCHAR\b", sig.group(1))) if sig else 0
    if arity < 3:
        return []  # 2-arg form is current; nothing stale to drop.
    if not drop:
        return [
            "RULE D: TOOL_DIRECTIONS now takes 3 arguments but the stale "
            "(VARCHAR, VARCHAR) signature is never dropped. It survives CREATE OR "
            "REPLACE and keeps serving 2-arg callers, including get_directions."
        ]
    if drop.start() > create.start():
        return [
            "RULE D: the DROP of TOOL_DIRECTIONS(VARCHAR, VARCHAR) sits AFTER the "
            "CREATE. With REGION defaulted both signatures accept two arguments, so "
            "the CREATE fails with 'Cannot overload PROCEDURE ... ambiguous PROCEDURE "
            "overloading' and every later statement in the file is abandoned."
        ]
    return []


def rule_e(module_sql: str) -> list[str]:
    """The replacement lookup must be table-only. A PROFILES_FOR_REGION that
    itself called ORS_STATUS would satisfy RULE A everywhere and reintroduce the
    hang one level down, with the gate reporting a pass."""
    body = None
    for name, _line, b in split_procs(module_sql):
        if name == "PROFILES_FOR_REGION":
            body = b
            break
    if body is None:
        return [
            "RULE E: CORE.PROFILES_FOR_REGION not found - the routing procs have no "
            "table-only profile source to read."
        ]
    if re.search(r"\bORS_STATUS\s*\(", body):
        return [
            "RULE E: CORE.PROFILES_FOR_REGION calls ORS_STATUS. The routing path would "
            "be back to an unboundable service call, one indirection further down."
        ]
    return []


def main() -> int:
    problems: list[str] = []
    for path in (TOOLS_SQL, MODULE_SQL):
        if not path.exists():
            print(f"FAILED: missing {path}")
            return 1
    tools = strip_comment_lines(TOOLS_SQL.read_text())
    module = strip_comment_lines(MODULE_SQL.read_text())

    problems += rule_a(tools)
    problems += rule_b(tools)
    problems += rule_c(tools)
    problems += rule_d(tools)
    problems += rule_e(module)

    n_procs = len(split_procs(tools))
    print(f"  scanned {n_procs} procedures/functions in {TOOLS_SQL.name}")
    print(f"  scanned CORE.PROFILES_FOR_REGION in {MODULE_SQL.name}")

    if problems:
        print()
        for p in problems:
            print("  " + p)
        print(f"\nFAILED: {len(problems)} routing-probe violation(s)")
        return 1
    print("\nPASSED: no unboundable probe on a routing path, DIRECTIONS is "
          "region-scoped, and the leg check can convict")
    return 0


if __name__ == "__main__":
    sys.exit(main())
