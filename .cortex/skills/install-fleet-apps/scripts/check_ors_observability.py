#!/usr/bin/env python3
"""Validate the ORS observability + gateway-resilience fixes against five
failure modes that are each SILENT: every one of them produces a plausible
response, a populated log, and no error anywhere.

All five were live on 2026-09-17, found by reading
OPENROUTESERVICE_APP.OBSERVABILITY.ORS_REQUEST_LOG after an Observability page
showing a wall of 404/2010 and 500/6099 events.

RULE A - the metrics windows must not be computed with SYSDATE().
    ORS_REQUEST_LOG.REQUEST_TS is TIMESTAMP_LTZ; SYSDATE() returns the UTC wall
    clock as TIMESTAMP_NTZ. Comparing them reads that UTC time AS IF it were
    local and shifts every cutoff FORWARD by the session's UTC offset. Measured:
    DATEADD(hour,-1,SYSDATE()) evaluated to 20:02 -0700 while CURRENT_TIMESTAMP()
    was 14:02 -0700, so the "last hour" cutoff sat 360 minutes in the FUTURE and
    that window was unconditionally EMPTY however fresh the events - which is
    what printed "No metrics yet. Make a few routing / matrix calls" above a
    populated 24h event list. "Last 24h" really covered 17h.

    Scoped to this table on purpose. Every other SYSDATE() comparison in the app
    is against a TIMESTAMP_NTZ column and is correct; all 20 timestamp columns
    were checked and REQUEST_TS is the only LTZ one used this way. A blanket ban
    on SYSDATE() would be wrong and would be silenced within a release.

RULE B - a deterministic ORS code must not be retried.
    get_ors_response keyed its retry off the HTTP status alone, so ORS codes that
    describe the REQUEST were re-sent at full size twice more. Measured over
    4.5 minutes: 44 logical cycling-electric matrix calls produced 119 error
    events (36 first attempts, 42 .retry1, 41 .retry2) for code 6099, whose only
    remedy is the chunked fallback in post_matrix_tabular - and that fallback is
    reachable only AFTER get_ors_response returns, so every 6099 paid for three
    full-size matrix computations before the one thing that helps was tried.

RULE C - a 5xx that ENDS the retry loop must count as a breaker failure.
    The retry branch is guarded by `attempt < ORS_RETRY_MAX_ATTEMPTS`, so on the
    final attempt control fell through to _breaker_on_success: the attempt that
    proved the host unwell cleared the counter the previous two had built. A host
    failing every call could never trip the breaker, which is why 119 recorded
    5xx events are accompanied by ZERO status-503 circuit_open events in the
    entire table. The breaker had never opened in production.

RULE D - the matrix search radius must be bound to the routing snapping radius.
    ORS snaps matrix coordinates with endpoints.matrix.maximum_search_radius and
    routing coordinates with profile_default.service.maximum_snapping_radius. The
    matrix key was unset (shipped default 2000) while routing was 1000, so MATRIX
    was strictly MORE PERMISSIVE than DIRECTIONS: a point 1-2 km off the graph
    resolved to a finite matrix duration and then made DIRECTIONS answer
    404/2010. Measured: -122.3900,37.8180 snaps 1589 m with a finite duration,
    and DIRECTIONS on that pair answers 2010. Every 2010 in the log was preceded
    within one second by a matrix 200 on the same profile and host. That is what
    defeats BOTH matrix-as-oracle pre-flights (deploy-agent.sql step 1e and the
    SA app's backload helpers), so the two radii must come from the SAME
    expression, not from two literals that happen to agree today.

RULE E - the 6099 chunked fallback must cover the locations-only matrix form.
    Chunking was gated on `has_dest`, which excluded the 2-arg locations-only
    MATRIX_TABULAR form. At ~2,510 request bytes (~100 coordinates) the incident
    calls had no room for a destinations index list, so they were exactly the
    excluded form: the remedy never fired for the calls that caused the incident.

WHY THE ASSERTIONS ARE SHAPED THIS WAY
======================================
Comments are stripped first, because this file's own rules name the banned
patterns verbatim and so do the fixed sources - the fix for RULE A is documented
in a comment that contains the string "SYSDATE()", and an unstripped scan
convicts the fix. Each rule also reports whether it actually inspected anything,
and main() fails if any rule saw zero candidates: a rule whose subject has been
renamed away passes silently otherwise, which is the failure mode that let four
verifiers in this repo be invoked by nothing for weeks.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]

GATEWAY_PY = (
    REPO
    / ".cortex/skills/install-fleet-apps/openrouteservice_app/services/gateway/routing_service.py"
)
REGION_SQL = (
    REPO
    / ".cortex/skills/install-fleet-apps/openrouteservice_app/app/modules/03_region_management.sql"
)
STATIC_CONFIG = (
    REPO
    / ".cortex/skills/install-fleet-apps/openrouteservice_app/staged_files/ors-config.yml"
)
# Every place the ORS_REQUEST_LOG windows are computed. Three copies exist
# because the view is defined in the installer module AND re-issued at admin-app
# container boot, and the event list has its own filter.
WINDOW_FILES = [
    REPO / ".cortex/skills/install-fleet-apps/openrouteservice_app/app/modules/08_observability.sql",
    REPO / ".cortex/skills/install-fleet-apps/fleet_admin_app/ui/src/server/lib/init.ts",
    REPO
    / ".cortex/skills/install-fleet-apps/fleet_admin_app/ui/src/app/api/observability/ors-events/route.ts",
]

# ORS codes whose remedy is never "send it again". 6099 is the one that produced
# the incident; the rest are the same class.
REQUIRED_NON_RETRYABLE = {"6099", "6004", "6010", "2010"}


def strip_comment_lines(text: str) -> str:
    """Blank out whole-line comments, preserving line numbering.

    Mirrors check_routing_probe.py deliberately. Only LEADING-comment lines are
    removed, never trailing text: stripping mid-line needs a string-aware parser,
    and the risk runs the wrong way - a false negative hides a live defect.
    """
    out = []
    for line in text.split("\n"):
        s = line.lstrip()
        out.append("" if s.startswith(("--", "//", "#", "*")) else line)
    return "\n".join(out)


def rule_a(sources: list[tuple[Path, str]]) -> tuple[list[str], int]:
    """Every window file must window REQUEST_TS, and never against SYSDATE().

    Two halves, and the second is what makes the first worth having. Scanning
    only for the BAD pattern passes when the predicate disappears - a mutation
    that renamed ORS_REQUEST_LOG out of the view survived that version of this
    rule, because the other two files still matched and the aggregate coverage
    counter stayed non-zero. So each file must positively contain a correct
    REQUEST_TS cutoff.
    """
    problems: list[str] = []
    inspected = 0
    bad = re.compile(r"REQUEST_TS\s*>=\s*DATEADD\s*\([^)]*SYSDATE\s*\(\s*\)", re.I)
    good = re.compile(
        r"REQUEST_TS\s*>=\s*DATEADD\s*\([^)]*CURRENT_TIMESTAMP\s*\(\s*\)", re.I
    )
    for path, text in sources:
        inspected += 1
        for m in bad.finditer(text):
            line = text[: m.start()].count("\n") + 1
            problems.append(
                f"RULE A: {path.name}:{line} windows REQUEST_TS (TIMESTAMP_LTZ) against "
                f"SYSDATE() (UTC as NTZ). The cutoff lands in the future by the session "
                f"UTC offset - use CURRENT_TIMESTAMP()."
            )
        if not good.search(text):
            problems.append(
                f"RULE A: {path.name} contains no `REQUEST_TS >= DATEADD(..., "
                f"CURRENT_TIMESTAMP())` cutoff. This file is one of the three places the "
                f"ORS_REQUEST_LOG windows are computed; if the predicate moved, re-point "
                f"WINDOW_FILES rather than leaving the rule with nothing to check."
            )
    return problems, inspected


def rule_b(gateway: str) -> tuple[list[str], int]:
    """The retry branch must exclude deterministic ORS codes."""
    problems: list[str] = []
    inspected = 0

    m = re.search(r"ORS_NON_RETRYABLE_CODES\s*=\s*frozenset\((\{[^}]*\}|\))", gateway)
    if not m:
        return (
            ["RULE B: ORS_NON_RETRYABLE_CODES is not defined in routing_service.py."],
            0,
        )
    inspected += 1
    codes = set(re.findall(r"\d+", m.group(1)))
    missing = REQUIRED_NON_RETRYABLE - codes
    if missing:
        problems.append(
            f"RULE B: ORS_NON_RETRYABLE_CODES is missing {sorted(missing)}. 6099 is the "
            f"code that produced 119 error events from 44 calls; an empty or partial set "
            f"restores the amplification."
        )

    # The set must actually gate the retry, not merely exist. The buggy version
    # had no such guard, so asserting the constant alone would pass on it.
    retry = re.search(
        r"if\s+500\s*<=\s*r\.status_code\s*<\s*600\s+and\s+attempt\s*<\s*ORS_RETRY_MAX_ATTEMPTS([^\n:]*):",
        gateway,
    )
    if not retry:
        problems.append("RULE B: could not locate the 5xx retry condition in get_ors_response.")
    else:
        inspected += 1
        if "non_retryable" not in retry.group(1):
            problems.append(
                "RULE B: the 5xx retry condition does not consult the non-retryable code "
                "set, so a 6099 is still re-sent at full size twice before the chunked "
                "fallback is reachable."
            )
    return problems, inspected


def rule_c(gateway: str) -> tuple[list[str], int]:
    """A 5xx that ends the loop must record a breaker failure, not a success."""
    problems: list[str] = []
    # Look at the code AFTER the retry `continue` and up to the `return annotated`
    # that ends the successful path: that is the loop-ending branch.
    m = re.search(
        r"time\.sleep\(backoff_s\)\s*\n\s*continue\s*\n(.*?)\n\s*return annotated",
        gateway,
        re.S,
    )
    if not m:
        return (
            [
                "RULE C: could not locate the loop-ending branch of get_ors_response "
                "(between the retry `continue` and `return annotated`)."
            ],
            0,
        )
    tail = strip_comment_lines(m.group(1))
    inspected = 1
    if "_breaker_on_failure" not in tail:
        problems.append(
            "RULE C: the branch that ENDS the retry loop never calls _breaker_on_failure. "
            "A final 5xx then clears the counter via _breaker_on_success, which is why "
            "119 recorded 5xx events produced ZERO circuit_open events."
        )
    elif not re.search(r"if\s+500\s*<=\s*r\.status_code\s*<\s*600\s*:", tail):
        problems.append(
            "RULE C: the loop-ending branch does not distinguish a 5xx from a non-5xx, so "
            "either every response counts as a failure or none does."
        )
    return problems, inspected


def rule_d(region_sql: str, static_cfg: str) -> tuple[list[str], int]:
    """matrix maximum_search_radius must be bound to maximum_snapping_radius.

    Both halves are scoped to the MATRIX endpoint block. `maximum_search_radius`
    is also a legitimate key under the `match:` endpoint, bound to a different
    limit - and an unscoped regex matched THAT one. Deleting the matrix line
    entirely then still produced a match, and the rule reported a misleading
    cause instead of the missing key. Scope first, assert second.
    """
    problems: list[str] = []
    inspected = 0

    snap = re.search(
        r"maximum_snapping_radius:\s*'\s*\+\s*str\(limits\[([^\]]+)\]\)", region_sql
    )
    # Narrow to the emitted matrix block: everything between the "matrix:" line
    # and the next endpoint ("isochrones:").
    mblock = re.search(
        r"'\s*matrix:\s*',(.*?)'\s*isochrones:\s*',", region_sql, re.S
    )
    search = (
        re.search(
            r"maximum_search_radius:\s*'\s*\+\s*str\(limits\[([^\]]+)\]\)", mblock.group(1)
        )
        if mblock
        else None
    )
    if not snap:
        problems.append(
            "RULE D: WRITE_ORS_CONFIG no longer emits maximum_snapping_radius - the rule's "
            "subject is gone, so this is a failure, not a pass."
        )
    elif not mblock:
        problems.append(
            "RULE D: could not locate the emitted `matrix:` endpoint block in "
            "WRITE_ORS_CONFIG, so the matrix radius cannot be checked in isolation."
        )
    elif not search:
        problems.append(
            "RULE D: the emitted matrix block sets no maximum_search_radius, so matrix "
            "snapping falls back to the ORS default (2000) and is more permissive than "
            "routing. That is what makes a matrix pre-flight pass a pair DIRECTIONS then "
            "rejects with 2010."
        )
    else:
        inspected += 1
        if snap.group(1).strip() != search.group(1).strip():
            problems.append(
                f"RULE D: the matrix search radius reads limits[{search.group(1).strip()}] "
                f"while routing reads limits[{snap.group(1).strip()}]. They must be the same "
                f"expression - two independent keys drift back apart, which is the defect."
            )

    # Static bootstrap config staged by provision_engine.sh: both keys present
    # and numerically equal. This file had NO snapping radius at all, which is
    # why the live SanFrancisco service answered "radius of 400.0 meters".
    cfg = strip_comment_lines(static_cfg)
    snap_v = re.search(r"^\s*maximum_snapping_radius:\s*(\d+)", cfg, re.M)
    cfg_mblock = re.search(r"^\s*matrix:\s*$(.*?)^\s*isochrones:\s*$", cfg, re.S | re.M)
    search_v = (
        re.search(r"^\s*maximum_search_radius:\s*(\d+)", cfg_mblock.group(1), re.M)
        if cfg_mblock
        else None
    )
    if not snap_v or not cfg_mblock or not search_v:
        problems.append(
            "RULE D: the static ors-config.yml must set BOTH maximum_snapping_radius and a "
            "maximum_search_radius inside its `matrix:` endpoint block; a missing snapping "
            "radius takes the ORS default (measured 400 m on the live SanFrancisco service)."
        )
    else:
        inspected += 1
        if snap_v.group(1) != search_v.group(1):
            problems.append(
                f"RULE D: static ors-config.yml has snapping={snap_v.group(1)} but matrix "
                f"search={search_v.group(1)}; they must be equal."
            )
    return problems, inspected


def rule_e(gateway: str) -> tuple[list[str], int]:
    """The 6099 chunked fallback must not be gated on has_dest."""
    problems: list[str] = []
    gate = re.search(
        r"error_obj\.get\('code'\)\s*==\s*6099([^\n:]*):",
        strip_comment_lines(gateway),
    )
    if not gate:
        return (
            [
                "RULE E: could not find the 6099 fallback trigger in post_matrix_tabular - "
                "the rule's subject is gone, so this is a failure, not a pass."
            ],
            0,
        )
    if "has_dest" in gate.group(1):
        problems.append(
            "RULE E: the 6099 chunked fallback is gated on has_dest, which excludes the "
            "2-arg locations-only MATRIX_TABULAR form - the exact form the incident used "
            "(~100 coordinates, no destinations index list)."
        )
    return problems, 1


def main() -> int:
    paths = [GATEWAY_PY, REGION_SQL, STATIC_CONFIG, *WINDOW_FILES]
    for p in paths:
        if not p.exists():
            print(f"FAILED: missing {p}")
            return 1

    gateway = strip_comment_lines(GATEWAY_PY.read_text())
    region_sql = REGION_SQL.read_text()
    static_cfg = STATIC_CONFIG.read_text()
    windows = [(p, strip_comment_lines(p.read_text())) for p in WINDOW_FILES]

    problems: list[str] = []
    coverage: dict[str, int] = {}
    for name, (probs, seen) in {
        "A": rule_a(windows),
        "B": rule_b(gateway),
        "C": rule_c(gateway),
        "D": rule_d(region_sql, static_cfg),
        "E": rule_e(gateway),
    }.items():
        problems += probs
        coverage[name] = seen

    print(f"  scanned {len(WINDOW_FILES)} window file(s), the gateway, and 2 config writer(s)")
    print("  rule coverage: " + ", ".join(f"{k}={v}" for k, v in sorted(coverage.items())))

    # Vacuity guard. A rule that inspected nothing has not passed - its subject
    # was renamed or deleted and the rule went quiet, which is exactly how a
    # gate becomes documentation.
    vacuous = [k for k, v in coverage.items() if v == 0]
    if vacuous:
        problems.append(
            f"VACUOUS: rule(s) {sorted(vacuous)} inspected zero candidates. The subject has "
            f"moved - re-point the rule rather than letting it pass silently."
        )

    if problems:
        print()
        for p in problems:
            print("  " + p)
        print(f"\nFAILED: {len(problems)} ORS observability/resilience violation(s)")
        return 1
    print(
        "\nPASSED: metrics windows are timezone-correct, deterministic ORS codes are not "
        "retried, a failing host can open the breaker, and matrix snapping matches routing"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
