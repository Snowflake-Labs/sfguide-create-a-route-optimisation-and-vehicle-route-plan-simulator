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
    if not codes:
        problems.append(f"{GATEWAY_PY.name}: found no error codes - has the response shape changed?")
    return codes, problems


def detector_patterns() -> tuple[list[re.Pattern[str]], list[str]]:
    """Compile every regex in SUSPEND_SIGNATURES + NOT_READY_SIGNATURES."""
    problems: list[str] = []
    if not SUSPEND_TS.exists():
        return [], [f"{SUSPEND_TS}: missing"]
    text = SUSPEND_TS.read_text()
    pats: list[re.Pattern[str]] = []
    found_arrays = 0
    for name in ("SUSPEND_SIGNATURES", "NOT_READY_SIGNATURES"):
        block = re.search(rf"const\s+{name}\s*=\s*\[(.*?)\]\s*;", text, re.DOTALL)
        if not block:
            problems.append(f"{SUSPEND_TS.name}: could not find {name}")
            continue
        found_arrays += 1
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
    return pats, problems


def main() -> int:
    problems: list[str] = []
    codes, p1 = gateway_error_codes()
    problems.extend(p1)
    pats, p2 = detector_patterns()
    problems.extend(p2)

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
        f"{len(IGNORED_CODES)} allowlisted, {len(pats)} patterns)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
