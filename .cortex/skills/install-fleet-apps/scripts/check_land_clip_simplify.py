#!/usr/bin/env python3
"""Validate CORE.ENSURE_ROUTABLE_BOUNDARY against the five ways its land clip
fails SILENTLY on a continental region.

Found on 2026-09-18 from one Function Tester message: "Region has no land clip
yet ... [routable_boundary: UNAVAILABLE: land clip could not be computed for
Europe (GEOGRAPHY too large)]". Europe therefore drew its sample points from the
raw Geofabrik extract polygon - 21,110,196 km2 of which less than half is land -
and ORS answered code 2010 for every point that landed at sea. Nothing raised;
the proc reports its failure modes by RETURN value and the region simply kept
using the unclipped BOUNDARY.

RULE A - the decimation must be applied INSIDE the ST_UNION_AGG argument.
    ST_UNION_AGG, not ST_INTERSECTION, is the statement that overflows. MEASURED:
    Europe matches 1,324 Overture region polygons carrying 10,286,175 vertices
    and the union alone raises 'GEOGRAPHY too large'; the US, at 96 polygons and
    1,421,517 vertices, unions fine. So simplifying the union's OUTPUT - or the
    final clip - cannot help: that geometry is never built. This is the rule that
    a plausible fix gets wrong, because ST_SIMPLIFY placed on the intersection
    reads as "we simplify the land mask" and is present in the same file.

RULE B - that tolerance must be a bind, never a literal.
    A hardcoded 1,000 m would straighten SanFrancisco's coastline by a kilometre
    and push land points into water, which is the failure the mask exists to
    prevent. The tolerance is chosen per region from the measured input.

RULE C - the tolerance must be derived from a MEASURED vertex count.
    Area does not predict vertices: Europe's extract is two thirds the area of the
    US extract and carries seven times the vertices, almost all of it Norwegian
    fjords and Aegean islands. A tolerance keyed on area would decimate the wrong
    regions and leave Europe failing.

RULE D - the browser copy must be bounded by VERTICES, re-measured in the loop.
    ST_SIMPLIFY thins a ring but never drops one, so metres of tolerance do not
    bound an archipelago. MEASURED for Europe at the old 500 m cap: 92,079
    vertices and 4.28 MB of GeoJSON, against 3,510 and 165 KB for the US - shipped
    to the browser for every provisioned region on page load. Escalating the
    tolerance is only meaningful if the vertex count is re-read after each step,
    so this rule requires the measurement inside the loop, not merely a loop.

RULE E - every ST_NPOINTS read INTO a scripting variable must cast ::FLOAT.
    An uncast ST_NPOINTS assignment POISONS the variable: the SELECT INTO
    succeeds and the next READ of it raises EXPRESSION_ERROR "Numeric value '5'
    is out of range" - measured on a five-vertex square, so it is the binding and
    not the magnitude. The error is reported against the line that reads the
    variable rather than the line that assigned it, and an enclosing EXCEPTION
    handler does not catch it, so this aborts the whole procedure after the
    expensive clip has already been computed.

Exit 0 clean, 1 on any violation.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
MODULE_SQL = (
    REPO
    / ".cortex/skills/install-fleet-apps/openrouteservice_app/app/modules/03_region_management.sql"
)
PROC = "ENSURE_ROUTABLE_BOUNDARY"


def strip_comment_lines(sql: str) -> str:
    """Blank out whole-line comments, preserving line numbering.

    Load-bearing: this procedure's header DISCUSSES every pattern the rules below
    forbid - it names the 500 m cap, quotes 'GEOGRAPHY too large', and explains
    why the simplify may not sit on the intersection. An unstripped scan convicts
    the documentation and, worse, can PASS on prose after the code it describes
    has been deleted.
    """
    out = []
    for line in sql.split("\n"):
        s = line.lstrip()
        out.append("" if s.startswith(("--", "//", "#")) else line)
    return "\n".join(out)


def proc_body(sql: str) -> tuple[int, str] | None:
    """(start_line, body) for the ENSURE_ROUTABLE_BOUNDARY procedure."""
    m = re.search(
        r"CREATE\s+OR\s+REPLACE\s+PROCEDURE\s+[A-Z0-9_.]*\b" + PROC + r"\s*\(",
        sql,
        re.I,
    )
    if not m:
        return None
    # Bodies end at the dollar-quote terminator, so a later procedure in the same
    # module cannot be scanned as part of this one.
    end = sql.find("\n$$;", m.start())
    end = len(sql) if end == -1 else end
    return sql.count("\n", 0, m.start()) + 1, sql[m.start() : end]


def balanced_arg(text: str, open_idx: int) -> str:
    """Substring inside the parentheses starting at open_idx."""
    depth, out = 0, []
    for ch in text[open_idx:]:
        if ch == "(":
            depth += 1
            if depth == 1:
                continue
        elif ch == ")":
            depth -= 1
            if depth == 0:
                break
        out.append(ch)
    return "".join(out)


def split_args(arglist: str) -> list[str]:
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
    return parts


def union_simplify(body: str) -> tuple[list[str], str | None]:
    """RULE A + RULE B. Returns (violations, tolerance bind name)."""
    m = re.search(r"ST_UNION_AGG\s*\(", body, re.I)
    if not m:
        return (
            [
                f"RULE A: {PROC} contains no ST_UNION_AGG - the land union this "
                "gate exists to bound is gone, so every rule below would pass "
                "vacuously."
            ],
            None,
        )
    arg = balanced_arg(body, m.end() - 1)
    s = re.search(r"ST_SIMPLIFY\s*\(", arg, re.I)
    if not s:
        return (
            [
                f"RULE A: {PROC} aggregates raw geometries - no ST_SIMPLIFY inside "
                "the ST_UNION_AGG argument. The union is the statement that raises "
                "'GEOGRAPHY too large' (Europe: 1,324 polygons, 10,286,175 "
                "vertices), so decimating its output or the final ST_INTERSECTION "
                "cannot help - that geometry never gets built."
            ],
            None,
        )
    simp = split_args(balanced_arg(arg, s.end() - 1))
    if len(simp) < 2:
        return ([f"RULE A: ST_SIMPLIFY inside ST_UNION_AGG has no tolerance."], None)
    geom, tol = simp[0].strip(), simp[1].strip()
    bad = []
    if not re.search(r"\bd\.GEOMETRY\b", geom, re.I):
        bad.append(
            f"RULE A: the ST_SIMPLIFY inside ST_UNION_AGG decimates '{geom}' rather "
            "than the per-row division geometry. Only per-POLYGON decimation "
            "reduces what the aggregate has to assemble."
        )
    bind = re.fullmatch(r":([A-Za-z_][A-Za-z0-9_]*)", tol)
    if not bind:
        bad.append(
            f"RULE B: the pre-union tolerance is '{tol}', not a variable. A fixed "
            "tolerance is applied to every region, and a kilometre of it "
            "straightens a city-scale coastline into open water - the exact "
            "failure the land mask exists to prevent (SanFrancisco measures "
            "16,854 input vertices and needs none)."
        )
    return bad, (bind.group(1) if bind else None)


def measured_vars(body: str) -> set[str]:
    """Variables populated from an ST_NPOINTS aggregate."""
    out = set()
    for m in re.finditer(
        r"ST_NPOINTS\s*\(.*?INTO\s+:([A-Za-z_][A-Za-z0-9_]*)", body, re.S | re.I
    ):
        out.add(m.group(1))
    return out


def tolerance_is_measured(body: str, tol_var: str | None) -> list[str]:
    """RULE C."""
    if not tol_var:
        return []
    measured = measured_vars(body)
    if not measured:
        return [
            f"RULE C: nothing in {PROC} measures ST_NPOINTS into a variable, so the "
            f"pre-union tolerance ':{tol_var}' cannot be derived from this region's "
            "real vertex count."
        ]
    for m in re.finditer(
        re.escape(tol_var) + r"\s*:=\s*([^;]+);", body, re.S | re.I
    ):
        if any(v in m.group(1) for v in measured):
            return []
    return [
        f"RULE C: ':{tol_var}' is never assigned from a measured vertex count "
        f"({', '.join(sorted(measured))}). Area does not predict vertices - Europe's "
        "extract is two thirds the area of the US extract and carries seven times "
        "the vertices - so an area-keyed tolerance decimates the wrong regions and "
        "leaves the continent failing."
    ]


def simple_copy_budget(body: str) -> list[str]:
    """RULE D."""
    m = re.search(
        r"ROUTABLE_BOUNDARY_SIMPLE\s*=\s*ST_SIMPLIFY\s*\(", body, re.I
    )
    if not m:
        return [
            "RULE D: no ROUTABLE_BOUNDARY_SIMPLE = ST_SIMPLIFY(...) assignment - the "
            "browser copy is not being produced here, so its payload is unbounded."
        ]
    args = split_args(balanced_arg(body, m.end() - 1))
    if len(args) < 2:
        return ["RULE D: the ROUTABLE_BOUNDARY_SIMPLE ST_SIMPLIFY has no tolerance."]
    tol = args[1].strip()
    bind = re.fullmatch(r":([A-Za-z_][A-Za-z0-9_]*)", tol)
    if not bind:
        return [
            f"RULE D: the browser copy's tolerance is the expression '{tol}', which "
            "bounds METRES and not vertices. ST_SIMPLIFY thins a ring but never "
            "drops one, so an archipelago keeps its ring count at any tolerance: "
            "MEASURED for Europe at the 500 m cap, 92,079 vertices and 4.28 MB of "
            "GeoJSON shipped on page load, against 3,510 and 165 KB for the US."
        ]
    tol_var = bind.group(1)
    measured = measured_vars(body)
    for w in re.finditer(r"\bWHILE\s*\((.*?)\)\s*DO(.*?)END\s+WHILE", body, re.S | re.I):
        cond, loop = w.group(1), w.group(2)
        if not re.search(re.escape(tol_var) + r"\s*:=", loop, re.I):
            continue
        budget_vars = [v for v in measured if v in cond]
        if not budget_vars:
            return [
                f"RULE D: the loop that escalates ':{tol_var}' does not test a "
                "measured vertex count, so the escalation is not bounded by the "
                "payload it exists to bound."
            ]
        if not re.search(
            r"ST_NPOINTS\s*\(.*?INTO\s+:(" + "|".join(map(re.escape, budget_vars)) + r")\b",
            loop,
            re.S | re.I,
        ):
            return [
                f"RULE D: ':{tol_var}' is escalated in a loop that never RE-MEASURES "
                f"the vertex count it tests ({', '.join(sorted(budget_vars))}). The "
                "condition would hold at the first reading forever, so the loop "
                "either spins to the cap or exits at once - in both cases the "
                "budget is decorative."
            ]
        return []
    return [
        f"RULE D: ':{tol_var}' is never escalated in a loop, so whatever single "
        "tolerance it holds is the only one tried and the vertex budget cannot be "
        "met."
    ]


def npoints_casts(body: str) -> list[str]:
    """RULE E."""
    bad = []
    for m in re.finditer(
        r"(ST_NPOINTS\s*\(.*?)INTO\s+:([A-Za-z_][A-Za-z0-9_]*)", body, re.S | re.I
    ):
        expr, var = m.group(1), m.group(2)
        if not re.search(r"::\s*FLOAT", expr, re.I):
            bad.append(
                f"RULE E: ':{var}' is assigned an uncast ST_NPOINTS value. The "
                "assignment succeeds and the next READ of that variable raises "
                "EXPRESSION_ERROR 'Numeric value ... is out of range' (measured on a "
                "five-vertex square, so it is the binding and not the magnitude). "
                "The error points at the reading line, no EXCEPTION handler catches "
                "it, and it fires only after the expensive clip has been computed. "
                "Cast the aggregate ::FLOAT."
            )
    return bad


def main() -> int:
    if not MODULE_SQL.exists():
        print(f"FAIL: {MODULE_SQL} not found (gate cannot run)", file=sys.stderr)
        return 1
    raw = MODULE_SQL.read_text()
    found = proc_body(strip_comment_lines(raw))
    if not found:
        print(
            f"FAIL: {PROC} not found in {MODULE_SQL.name} - every rule would pass "
            "vacuously.",
            file=sys.stderr,
        )
        return 1
    line, body = found

    violations: list[str] = []
    rule_a_b, tol_var = union_simplify(body)
    violations += rule_a_b
    violations += tolerance_is_measured(body, tol_var)
    violations += simple_copy_budget(body)
    violations += npoints_casts(body)

    # Vacuity counter. Each number below must be non-zero for the pass to mean
    # anything: a gate that inspected nothing reports success identically to a
    # gate that inspected everything and found nothing.
    seen = {
        "ST_UNION_AGG": len(re.findall(r"ST_UNION_AGG\s*\(", body, re.I)),
        "ST_SIMPLIFY": len(re.findall(r"ST_SIMPLIFY\s*\(", body, re.I)),
        "ST_NPOINTS INTO": len(
            re.findall(r"ST_NPOINTS\s*\(.*?INTO\s+:", body, re.S | re.I)
        ),
        "WHILE loops": len(re.findall(r"\bWHILE\s*\(", body, re.I)),
    }
    empty = [k for k, v in seen.items() if v == 0]
    if empty and not violations:
        print(
            f"FAIL: {PROC} (line {line}) inspected but these constructs were absent: "
            f"{', '.join(empty)}. The rules found nothing to check, which is not a "
            "pass.",
            file=sys.stderr,
        )
        return 1

    if violations:
        print(f"FAIL: {PROC} at {MODULE_SQL.name}:{line}", file=sys.stderr)
        for v in violations:
            print(f"  - {v}", file=sys.stderr)
        return 1

    print(
        "check_land_clip_simplify: OK ("
        + ", ".join(f"{k}={v}" for k, v in seen.items())
        + ")"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
