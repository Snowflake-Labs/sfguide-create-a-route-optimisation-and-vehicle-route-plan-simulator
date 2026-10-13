#!/usr/bin/env python3
"""Both backload solve paths must send the optimizer the SAME tour caps.

There are two `buildChallenge` implementations: the page's (backload-matching.tsx
+ helpers.vehicleTourCaps) and TOOL_BACKLOAD_SOLVE's (deploy-agent.sql). They
drifted silently. The agent path sent `max_tasks` ONLY, so a CoWork solve was
unbounded on tour length whatever the user asked for, and an answer claimed a
300 km deviation cap that had never been passed. VROOM on this deployment DOES
enforce `vehicle.max_distance` (measured: 10 km leaves a 700 km shipment
unassigned, 5,000 km assigns it), so a missing cap is a real behaviour change,
not a cosmetic one.

Rules (comments stripped first, predicates not topics):
  A. Each buildChallenge vehicle literal emits max_tasks, max_distance and
     max_travel_time.
  B. costs.fixed is not a numeric literal on either path (the proc hardcoded 140
     while the page read its control).
  C. The cap rule adds an absolute allowance and keeps no fixed floor. A
     percentage of a ZERO baseline (vehicle already at its end point, ~39% of the
     pool) collapsed to `Math.max(10_000, 0)` = 10 km whatever the slider said.
  D. The proc returns applied_caps on success, and the verb's returns contract
     tells the agent a constraint absent from it was NOT enforced.
  E. computeEmptyLegBaselines accepts a finite ZERO matrix cell (`>= 0`), not
     only a positive one. Rejecting 0/0 is what made at-end baselines fall to a
     floor in the first place.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent.parent.parent

PROC = REPO / ".cortex/skills/routing-agent/references/deploy-agent.sql"
PAGE = REPO / ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/components/views/areas/backload-matching.tsx"
HELP = REPO / ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/components/views/areas/backload-matching/helpers.ts"
VERB = REPO / ".cortex/skills/install-fleet-apps/fleet_tools/user/src/procs/backload_solve.ts"

CAPS = ("max_tasks", "max_distance", "max_travel_time")
failures: list[str] = []


def fail(rule: str, msg: str) -> None:
    failures.append(f"[{rule}] {msg}")


def strip_comments(src: str) -> str:
    # Block comments, then line comments that are not inside a string literal
    # on the common `x: '...//...'` shape (URLs). Good enough for these files.
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"(?m)(^|[^:'\"])//.*$", r"\1", src)


def balanced_from(src: str, start: int) -> str:
    """Text of the {...} block whose opening brace is at or after `start`."""
    i = src.index("{", start)
    depth = 0
    for j in range(i, len(src)):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                return src[i:j + 1]
    return src[i:]


def fn_body(src: str, sig_end: int) -> str:
    """Body of the function whose `(` is at or after sig_end.

    Matches the parameter parentheses first: a TS signature carries a
    function-typed parameter `(t: Trailer) => ...` and an object return type
    `: { max_distance: number }`, so the first `)` or `{` is not the body.
    """
    i = src.index("(", sig_end - 1) if src[sig_end - 1] == "(" else src.index("(", sig_end)
    depth = 0
    for j in range(i, len(src)):
        if src[j] == "(":
            depth += 1
        elif src[j] == ")":
            depth -= 1
            if depth == 0:
                break
    k = j + 1
    # Skip a return-type annotation, which may itself contain braces / generics.
    m = re.match(r"\s*:\s*", src[k:])
    if m:
        k += m.end()
        if src[k] == "{":
            k += len(balanced_from(src, k))
    return balanced_from(src, src.index("{", k))


def proc_body() -> str:
    s = PROC.read_text(encoding="utf-8")
    m = re.search(r"CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE\.ROUTING_TOOLS\.TOOL_BACKLOAD_SOLVE\(", s)
    if not m:
        fail("vacuity", "TOOL_BACKLOAD_SOLVE not found in deploy-agent.sql")
        return ""
    end = s.find("$$;", m.end())
    return strip_comments(s[m.end():end if end > 0 else len(s)])


def vehicle_literal(body: str, where: str) -> str:
    """The object pushed as a VROOM vehicle inside buildChallenge."""
    m = re.search(r"function buildChallenge\s*\(", body) or re.search(r"const buildChallenge\b", body)
    scope = body[m.end():] if m else body
    if not m and where == "proc":
        fail("vacuity", "proc has no buildChallenge")
        return ""
    vm = re.search(r"vehicles\.push\(\s*\{", scope) if where == "proc" else re.search(
        r"const veh\s*:\s*Record<string,\s*unknown>\s*=\s*\{", scope)
    if not vm:
        fail("vacuity", f"{where}: no vehicle literal found")
        return ""
    return balanced_from(scope, vm.end() - 1)


def main() -> int:
    checked = 0
    pb = proc_body()
    page = strip_comments(PAGE.read_text(encoding="utf-8")) if PAGE.exists() else ""
    helpers = strip_comments(HELP.read_text(encoding="utf-8")) if HELP.exists() else ""
    verb = VERB.read_text(encoding="utf-8") if VERB.exists() else ""

    pv = vehicle_literal(pb, "proc") if pb else ""
    av = vehicle_literal(page, "page") if page else ""
    for where, lit in (("proc", pv), ("page", av)):
        if not lit:
            continue
        checked += 1
        # A spread of the shared helper counts as emitting both distance caps.
        spread = re.search(r"\.\.\.\s*vehicleTourCaps\(", lit) is not None
        for cap in CAPS:
            if re.search(rf"\b{cap}\s*:", lit) or (spread and cap != "max_tasks"):
                continue
            fail("A", f"{where} buildChallenge vehicle does not set {cap}; the two solve "
                      "paths must send the same caps")
        fm = re.search(r"\bfixed\s*:\s*([^,}]+)", lit)
        if not fm:
            fail("B", f"{where} vehicle sets no costs.fixed")
        elif re.fullmatch(r"\s*\d+(\.\d+)?\s*(\*\s*COST_SCALE)?\s*", fm.group(1)):
            fail("B", f"{where} costs.fixed is the literal `{fm.group(1).strip()}`; read it from "
                      "MATCH_PARAMS / the page control so both paths price dispatch alike")

    # C. the rule itself, on both sides.
    for where, src, fn in (("proc", pb, r"function vehicleTourCaps\s*\("),
                           ("helpers", helpers, r"export function vehicleTourCaps\s*\(")):
        m = re.search(fn, src)
        if not m:
            fail("C", f"{where} has no vehicleTourCaps rule")
            continue
        checked += 1
        rule = fn_body(src, m.end())
        if not re.search(r"max_distance\s*:[^,\n]*\*\s*\(\s*1\s*\+[^,\n]*\+\s*[A-Za-z_.]*[aA]llowanceKm\s*\*\s*1000", rule):
            fail("C", f"{where} max_distance is not baseline*(1+pct/100) + allowanceKm*1000")
        if not re.search(r"max_travel_time\s*:[^\n]*[aA]llowanceKm", rule):
            fail("C", f"{where} max_travel_time ignores the allowance, so an at-end vehicle "
                      "is bounded by distance but not by time")
    for where, src in (("proc", pb), ("page", page), ("helpers", helpers)):
        if re.search(r"Math\.max\(\s*10_?000\s*,", src) or re.search(r"Math\.max\(\s*1800\s*,", src):
            fail("C", f"{where} still floors a cap with Math.max(10000|1800, ...); a floor on a zero "
                      "baseline is the defect, not the fix")

    # D. what was enforced is reported.
    if pb:
        if len(re.findall(r"\bapplied_caps\s*:\s*appliedCaps\b", pb)) < 2:
            fail("D", "proc does not return applied_caps on its SUCCESS paths")
        if not re.search(r"var appliedCaps\s*=\s*\{[^}]*max_deviation_pct[^}]*deviation_allowance_km", pb, re.S):
            fail("D", "appliedCaps does not report the deviation pct and allowance actually sent")
    if verb:
        checked += 1
        if not re.search(r"absent from applied_caps was\s*'\s*\+\s*'NOT enforced|absent from applied_caps was NOT enforced", verb):
            fail("D", "backload_solve returns contract does not say a constraint absent from "
                      "applied_caps was NOT enforced; the agent will narrate compliance it did not pass")

    # E. zero baseline is a measurement.
    if helpers:
        m = re.search(r"export async function computeEmptyLegBaselines\b", helpers)
        if not m:
            fail("vacuity", "helpers.ts has no computeEmptyLegBaselines")
        else:
            checked += 1
            fn = fn_body(helpers, m.end())
            line = re.search(r"if\s*\(\s*Number\.isFinite\(dur\)[^\n]*", fn)
            if not line:
                fail("E", "computeEmptyLegBaselines no longer tests the matrix cell")
            else:
                g = line.group(0)
                if re.search(r"\bdur\s*>\s*0|\bdist\s*>\s*0", g) or not (
                        re.search(r"\bdur\s*>=\s*0", g) and re.search(r"\bdist\s*>=\s*0", g)):
                    fail("E", "computeEmptyLegBaselines rejects a 0/0 matrix cell; a vehicle at its "
                              "end point then falls to a floor and every cap built on it collapses")

    if checked < 5:
        fail("vacuity", f"only {checked} surfaces inspected; expected at least 5")
    if failures:
        for f in failures:
            print(f)
        print(f"\n{len(failures)} finding(s).")
        return 1
    print(f"PASS: both buildChallenge paths send max_tasks/max_distance/max_travel_time with a "
          f"non-literal dispatch cost, caps add an absolute allowance with no floor, applied_caps is "
          f"reported, and a zero baseline is accepted ({checked} surfaces inspected)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
