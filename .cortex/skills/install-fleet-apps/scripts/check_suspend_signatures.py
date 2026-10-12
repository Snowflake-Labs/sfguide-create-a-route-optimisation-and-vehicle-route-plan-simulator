#!/usr/bin/env python3
"""Guard: every routing-gateway error code must be visible to the app's
suspended-engine detector.

The failure this prevents has already happened twice. The gateway has FOUR
distinct error codes for "this region cannot serve your request"
(`service_unreachable`, `circuit_open`, `timeout`, `service_warming_up`), but
`SUSPEND_SIGNATURES` in lib/routing-suspend.ts only matched the first. So a
region that timed out, or whose circuit breaker had opened, produced an error the
client could not classify: no typed 503, no auto-resume, and the user saw a raw
message or a blank panel while the engine stayed suspended.

Delivery Sync made it routine rather than rare. One render issues six ORS calls,
which crosses the breaker's 5-failure threshold inside that single render, so
from the second render onwards every call returned the unmatched `circuit_open`.

The invariant: if routing_service.py can put a code in a response body, either
routing-suspend.ts can match it or it is explicitly allowlisted here as a
non-routing-availability error. Adding a new gateway error code without deciding
which of those two it is now fails the commit.

The gateway is not the only source. SNOWFLAKE raises some routing failures
before the gateway answers - measured: 100283 "Could not connect to server"
when the gateway is waking from its idle auto-suspend. Those never appear in
routing_service.py, so MEASURED_PLATFORM_ERRORS lists them verbatim with the
bucket each must land in, and the bucket is asserted, not just "some pattern
matches": a waking gateway classified as suspended would claim a resume was
triggered that never was.

Usage:
    python3 .cortex/skills/install-fleet-apps/scripts/check_suspend_signatures.py

Exit 0 = clean, 1 = a gateway error code is invisible to the detector.
"""
from __future__ import annotations

import pathlib
import re
import sys

SKILL_DIR = pathlib.Path(__file__).resolve().parents[1]
GATEWAY_PY = SKILL_DIR / "openrouteservice_app" / "services" / "gateway" / "routing_service.py"
SUSPEND_TS = SKILL_DIR / "fleet_sa_app" / "ui" / "src" / "lib" / "routing-suspend.ts"

# Codes that are NOT a routing-availability condition. These describe a request
# the engine correctly refused or a failure a resume cannot fix, so surfacing a
# "the engine is starting" notice for them would be a lie. Each needs a reason.
IGNORED_CODES: dict[str, str] = {
    "request_too_large": "guardrail rejection: the request exceeds the preset caps, engine is healthy",
    "all_chunks_failed": "every matrix chunk failed on a REACHABLE engine; the per-chunk cause is reported separately",
    "unknown": "terminal fallback when no attempt produced a payload; carries no actionable state",
}

# The detector runs on MESSAGES, not on bare codes, so a code is tested in the
# shapes it actually reaches the client in. Testing the bare token alone would
# force over-broad patterns (a bare /timeout/ also matches a Snowflake statement
# timeout and would mislabel it a routing outage).
ENVELOPES = (
    # The SQL guards raise `TO_GEOGRAPHY('ORS ' || resp:error || ' host=' || ...)`.
    "ORS {code} host=ors-service-usnewjersey",
    # detectSuspendedInResult JSON.stringify's the whole result object.
    '{{"error":"{code}","ors_host":"ors-service-usnewjersey"}}',
)

# Routing failures SNOWFLAKE raises before the gateway answers, verbatim as they
# reach the app, with the bucket each must land in. `suspended` = a resume is
# the remedy; `not_ready` = waiting is (see EngineState in routing-suspend.ts).
MEASURED_PLATFORM_ERRORS: list[tuple[str, str]] = [
    # wgb26798 2026-10-12 16:11:35 UTC, gateway waking from its 1h idle suspend.
    ("SQL API error 422: { \"code\" : \"100283\", \"message\" : \"Request failed for "
     "external function _ORS_STATUS_RAW. Error: Could not connect to server\" }", "not_ready"),
    # The same platform error on a view's live routing call.
    ("100283 (P0000): Request failed for external function _DIRECTIONS_RAW. Error: "
     "Could not connect to server", "not_ready"),
]

# detectOrsSuspended attributes this text to the gateway through a named
# constant, while this gate reads the array literal. They must stay identical.
GATEWAY_CONST = "GATEWAY_CONNECT_FAILURE"


def gateway_error_codes() -> tuple[set[str], list[str]]:
    """Every literal error code routing_service.py can put in a response body."""
    problems: list[str] = []
    if not GATEWAY_PY.exists():
        return set(), [f"{GATEWAY_PY}: missing"]
    text = GATEWAY_PY.read_text()
    # Matches both dict-literal and inline forms:
    #   'error': 'service_unreachable'      "error": "timeout"
    codes = set(re.findall(r"""['"]error['"]\s*:\s*['"]([a-z0-9_]+)['"]""", text, re.IGNORECASE))
    # The breaker now returns the code that opened it, drawn from the same set,
    # via `'error': breaker_reason`. Make sure that indirection still exists so
    # this check cannot be defeated by routing every code through a variable.
    if "'error': breaker_reason" not in text and '"error": breaker_reason' not in text:
        problems.append(
            "routing_service.py no longer returns the breaker cause as 'error'; "
            "a fail-fast response must keep naming the underlying code"
        )
    # ...and the breaker's FALLBACK reaches the body through that same
    # indirection: `_breaker_check` returns `st.get('cause') or 'circuit_open'`.
    # That literal never appears as `'error': '...'`, so without this the code
    # the docstring names as the historical defect was not checked at all.
    codes.update(re.findall(r"""return\s+False\s*,[^\n]*?\bor\s+['"]([a-z0-9_]+)['"]""", text))
    if not codes:
        problems.append(f"{GATEWAY_PY.name}: found no error codes - has the response shape changed?")
    return codes, problems


def detector_patterns() -> tuple[list[re.Pattern[str]], list[str]]:
    """Compile every regex in SUSPEND_SIGNATURES + NOT_READY_SIGNATURES."""
    buckets, problems = bucket_patterns()
    return buckets.get("SUSPEND_SIGNATURES", []) + buckets.get("NOT_READY_SIGNATURES", []), problems


def bucket_patterns() -> tuple[dict[str, list[re.Pattern[str]]], list[str]]:
    """The same regexes, kept per array, so a bucket can be asserted."""
    problems: list[str] = []
    if not SUSPEND_TS.exists():
        return {}, [f"{SUSPEND_TS}: missing"]
    text = SUSPEND_TS.read_text()
    buckets: dict[str, list[re.Pattern[str]]] = {}
    found_arrays = 0
    for name in ("SUSPEND_SIGNATURES", "NOT_READY_SIGNATURES"):
        block = re.search(rf"const\s+{name}\s*=\s*\[(.*?)\]\s*;", text, re.DOTALL)
        if not block:
            problems.append(f"{SUSPEND_TS.name}: could not find {name}")
            continue
        found_arrays += 1
        pats = buckets.setdefault(name, [])
        for raw in re.findall(r"/((?:[^/\\\n]|\\.)+)/([gimsuy]*)", block.group(1)):
            body, flags = raw
            try:
                # JS -> Python: the only flag that matters for matching here is
                # case-insensitivity. JS \b, \d, \s etc. are Python-compatible.
                pats.append(re.compile(body, re.IGNORECASE if "i" in flags else 0))
            except re.error as exc:
                problems.append(f"{name}: regex /{body}/ does not compile in Python: {exc}")
    if found_arrays == 0:
        problems.append(f"{SUSPEND_TS.name}: no signature arrays found at all")
    return buckets, problems


def platform_error_problems(buckets: dict[str, list[re.Pattern[str]]]) -> list[str]:
    """Each measured platform error lands in its required bucket. SUSPEND is
    checked first by detectOrsSuspended, so a not_ready entry must also match no
    SUSPEND pattern, or it is reported as a resume that never happened."""
    problems: list[str] = []
    sus = buckets.get("SUSPEND_SIGNATURES", [])
    nrd = buckets.get("NOT_READY_SIGNATURES", [])
    for text, want in MEASURED_PLATFORM_ERRORS:
        hit_s = any(p.search(text) for p in sus)
        hit_n = any(p.search(text) for p in nrd)
        got = "suspended" if hit_s else "not_ready" if hit_n else None
        if got is None:
            problems.append(f"measured platform error is unmatched by any signature (want {want}): {text[:110]}")
        elif got != want:
            problems.append(f"measured platform error lands in the wrong bucket ({got}, want {want}): {text[:110]}")
    text = SUSPEND_TS.read_text() if SUSPEND_TS.exists() else ""
    const = re.search(rf"const\s+{GATEWAY_CONST}\s*=\s*/((?:[^/\\\n]|\\.)+)/([gimsuy]*)\s*;", text)
    if not const:
        problems.append(f"{SUSPEND_TS.name}: could not find {GATEWAY_CONST}, which attributes "
                        "the connect failure to the gateway")
    else:
        literal = f"/{const.group(1)}/{const.group(2)}"
        block = re.search(r"const\s+NOT_READY_SIGNATURES\s*=\s*\[(.*?)\]\s*;", text, re.DOTALL)
        if not block or literal not in block.group(1):
            problems.append(f"{GATEWAY_CONST} ({literal}) is not also a literal in "
                            "NOT_READY_SIGNATURES - the detector and the gateway attribution disagree")
    return problems


def main() -> int:
    problems: list[str] = []
    codes, p1 = gateway_error_codes()
    problems.extend(p1)
    pats, p2 = detector_patterns()
    problems.extend(p2)
    buckets, _ = bucket_patterns()
    problems.extend(platform_error_problems(buckets))

    uncovered: list[str] = []
    if pats:
        for code in sorted(codes):
            if code in IGNORED_CODES:
                continue
            # Every envelope must be classifiable, not just one: /api/query sees
            # the raised message while the tool path sees the JSON body.
            missing = [
                env.format(code=code)
                for env in ENVELOPES
                if not any(p.search(env.format(code=code)) for p in pats)
            ]
            if missing:
                uncovered.append(f"{code} (unmatched in: {'; '.join(missing)})")

    for entry in uncovered:
        problems.append(
            f"gateway error code '{entry}' is matched by no signature in "
            f"{SUSPEND_TS.name}. Either add a pattern to SUSPEND_SIGNATURES "
            f"(a resume fixes it) / NOT_READY_SIGNATURES (waiting fixes it), or "
            f"add it to IGNORED_CODES in this script with a reason."
        )

    # Guard the allowlist against rot: an entry for a code the gateway no longer
    # emits is stale documentation that teaches people to trust it blindly.
    if codes:
        for code in sorted(IGNORED_CODES):
            if code not in codes:
                problems.append(
                    f"IGNORED_CODES lists '{code}', which routing_service.py no "
                    f"longer emits - remove it"
                )

    if problems:
        print("check_suspend_signatures: FAIL")
        for p in problems:
            print(f"  - {p}")
        return 1

    print(
        f"check_suspend_signatures: OK "
        f"({len(codes) - len(IGNORED_CODES)} routing-availability codes covered, "
        f"{len(IGNORED_CODES)} allowlisted, {len(MEASURED_PLATFORM_ERRORS)} measured platform "
        f"errors in their bucket, {len(pats)} patterns)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
