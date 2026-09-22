#!/usr/bin/env python3
"""Fail when the Data Studio generator loses its POI-cap override or its
setup-phase watchdog heartbeats.

Why this exists
---------------
Two defects, both with SILENT failure modes, both fixed and neither protected.

1. POI CAP. `poiCapForArea` has a first tier of "< 250,000 km2 -> 5,000" that
   spans a 300x area range, so SanFrancisco (839 km2) and Switzerland
   (41,822 km2 ) were handed the SAME pool - 0.121 POIs/km2 against 6.0. A
   preset now overrides it with `config.poi_cap`. If that resolution is dropped
   or reverted, a preset that sets poi_cap silently generates a DEFAULT-sized
   pool: every log line, row count and downstream view still looks plausible,
   and on this account the wasted run is ~90 minutes.

   The `??` is load-bearing and a `||` is a real regression, not a style
   preference: a preset that deliberately sets 0 must not fall back to 5,000.

2. SETUP-PHASE HEARTBEATS. Every batched inserter issues one SEQUENTIAL
   round-trip per batch. jobs.ts runs a no-progress watchdog at
   WATCHDOG_STALL_MS (15 min) whose liveness is
   max(job.lastProgressAt, getRouteActivity()), and only
   `broadcast(job, 'progress', ...)` stamps the former.

   MEASURED: a 72,849-row DIM_POIS insert spent 929 s emitting nothing, the
   watchdog logged "possible ORS stall", set STALLED and ABORT_REQUESTED, and
   the setup phase then completed normally six minutes later. The job was never
   stalled. Removing a beat re-arms exactly that, and the symptom names the
   wrong cause.

   getRouteActivity() covers the TELEMETRY phase, so the telemetry/trip/
   trip-schedule inserters are protected by it and are deliberately NOT required
   to beat. The four inserters that run BEFORE any routing have no second
   liveness source and are the ones this gate pins.

Why a comment was not enough
----------------------------
`broadcast()`'s own comment ALREADY documented this bug class in detail -
"the pre-telemetry universal-generation phase ... never stamps lastProgressAt,
so the watchdog ... falsely aborts any run whose setup phase exceeds 15 min" -
and insertDimPois shipped without a beat anyway. A comment describing a trap
does not stop the trap.

Rules
-----
A  routability.ts resolves the cap as `config.poi_cap ?? <area default>`.
B  routability.ts does not resolve the cap with `||` (0 must not fall back).
C  profiles.ts declares `poi_cap` on GenerationConfig.
D  Each of the four SETUP-phase inserters accepts an onProgress callback.
E  Each of the four SETUP-phase inserters actually CALLS its beat inside the
   batch loop (a declared-but-unused parameter is not a heartbeat).
F  Each of the four jobs.ts call sites passes a callback that broadcasts a
   'progress' event (the only event kind that refreshes the watchdog clock).
G  The shared cadence helper exists and its threshold is a positive number well
   under what 15 minutes of batches can cover.

Plus vacuity counters: every rule reports how many items it inspected, and the
run fails if any rule inspected zero. A gate whose paths have gone stale passes
silently otherwise - which has happened twice in this repo.
"""

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
SKILL = REPO / ".cortex/skills/install-fleet-apps"
STUDIO = SKILL / "fleet_admin_app/ui/src/server/studio"

ROUTABILITY = STUDIO / "engine/routability.ts"
PROFILES = STUDIO / "profiles.ts"
INSERTERS = STUDIO / "inserters.ts"
JOBS = STUDIO / "jobs.ts"

# The inserters that run BEFORE any ORS routing, so getRouteActivity() cannot
# vouch for them. These are the ones that must beat.
SETUP_INSERTERS = [
    "insertDimPois",
    "insertFactOffers",
    "insertDimPartners",
    "insertFactPartnerHistory",
]

# Deliberately exempt: these run DURING the telemetry phase, where
# getRouteActivity() is a second liveness source. Listed so that a future reader
# sees the exemption is reasoned rather than an oversight.
TELEMETRY_INSERTERS = [
    "insertTelemetryBatch",
    "insertTripBatch",
    "insertTripScheduleBatch",
]

failures: list[str] = []
inspected: dict[str, int] = {}


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8") if p.is_file() else ""


def strip_comments(src: str) -> str:
    """Remove // and /* */ comments.

    Load-bearing. This gate's own subject matter is heavily commented - the
    measured 929 s, the word 'progress', the phrase 'poi_cap' and the token
    '??' all appear in prose right next to the code they describe. Without
    stripping, every rule here can be satisfied by the comment explaining the
    trap rather than by the code avoiding it, which is how rule C of an earlier
    gate in this repo false-passed.
    """
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    src = re.sub(r"(?m)^\s*//.*$", "", src)
    src = re.sub(r"//.*$", "", src, flags=re.M)
    return src


def body_of(src: str, fn: str, span: int = 6000) -> str:
    """The text of one exported function, from its signature onward."""
    m = re.search(rf"export\s+async\s+function\s+{re.escape(fn)}\b", src)
    if not m:
        return ""
    start = m.start()
    nxt = re.search(r"\nexport\s+(async\s+)?function\s", src[start + 10:])
    end = start + 10 + nxt.start() if nxt else min(len(src), start + span)
    return src[start:end]


def signature_of(src: str, fn: str) -> str:
    m = re.search(
        rf"export\s+async\s+function\s+{re.escape(fn)}\s*\((.*?)\)\s*:",
        src,
        flags=re.S,
    )
    return m.group(1) if m else ""


def loop_body(body: str) -> str:
    """The text INSIDE the first `for (...) { ... }` of a function body.

    Needed because "a beat call exists somewhere in the function" is too weak:
    a beat invoked once AFTER the loop satisfies that and still leaves the whole
    batch loop silent, which is precisely the defect. A brace matcher is enough
    here - these inserters are one flat loop with no nested function literals.
    """
    m = re.search(r"\bfor\s*\(", body)
    if not m:
        return ""
    brace = body.find("{", m.end())
    if brace < 0:
        return ""
    depth = 0
    for i in range(brace, len(body)):
        if body[i] == "{":
            depth += 1
        elif body[i] == "}":
            depth -= 1
            if depth == 0:
                return body[brace + 1: i]
    return body[brace + 1:]


# --------------------------------------------------------------------------
# Rules A/B/C - the POI cap override
# --------------------------------------------------------------------------
def check_poi_cap() -> None:
    raw = read(ROUTABILITY)
    if not raw:
        failures.append(f"A/B: cannot read {ROUTABILITY.relative_to(REPO)}")
        inspected["A"] = inspected["B"] = 0
        return
    src = strip_comments(raw)

    # Rule A: the override must be READ and must take precedence over the
    # area-derived default. Require poi_cap on the LEFT of ?? and a
    # poiCapForArea-derived value on the right, in one expression.
    pat_ok = re.compile(
        r"config\s*\.\s*poi_cap\s*\?\?\s*[A-Za-z_$][\w$]*",
    )
    assigns = re.findall(r"(?m)^.*poiCap\s*=.*$", src)
    inspected["A"] = len(assigns)
    if not assigns:
        failures.append(
            "A: no `poiCap = ...` assignment found in routability.ts - the "
            "override was removed or the file moved"
        )
    elif not pat_ok.search(src):
        failures.append(
            "A: the POI cap is not resolved as `config.poi_cap ?? <default>`. "
            "Found: " + " | ".join(a.strip()[:90] for a in assigns) + ". "
            "Without the override, a preset's poi_cap is silently ignored and "
            "the pool is default-sized with plausible-looking output."
        )

    # Rule B: reject `||` on the poi_cap resolution specifically. An explicit 0
    # is a legitimate value and `||` would replace it with the default.
    inspected["B"] = len(assigns)
    if re.search(r"config\s*\.\s*poi_cap\s*\|\|", src):
        failures.append(
            "B: POI cap resolved with `||`. Use `??` - a preset that "
            "explicitly sets poi_cap to 0 must not fall back to the "
            "area-derived default."
        )

    # Rule C: the field must be declared, or a preset setting it fails to typecheck.
    praw = strip_comments(read(PROFILES))
    decls = re.findall(r"(?m)^\s*poi_cap\s*\??\s*:", praw)
    inspected["C"] = len(decls)
    if not decls:
        failures.append(
            "C: `poi_cap` is not declared on GenerationConfig in profiles.ts"
        )


# --------------------------------------------------------------------------
# Rules D/E - the inserters accept AND use a beat
# --------------------------------------------------------------------------
def check_inserters() -> None:
    raw = read(INSERTERS)
    if not raw:
        failures.append(f"D/E: cannot read {INSERTERS.relative_to(REPO)}")
        inspected["D"] = inspected["E"] = 0
        return
    src = strip_comments(raw)

    seen_d = seen_e = 0
    for fn in SETUP_INSERTERS:
        sig = signature_of(src, fn)
        if not sig:
            failures.append(
                f"D: setup-phase inserter `{fn}` not found in inserters.ts - "
                "renamed or removed; this gate's list is stale"
            )
            continue
        seen_d += 1
        if "onProgress" not in sig:
            failures.append(
                f"D: `{fn}` runs in the SETUP phase (before any ORS call, so "
                "getRouteActivity() cannot vouch for it) but takes no "
                "onProgress callback. One round-trip per batch with no beat is "
                "what got a healthy job aborted after 929 s of silence."
            )
            continue

        # Rule E: accepting the parameter is not enough - it must be invoked
        # inside the BATCH LOOP. A declared-but-unused onProgress is the exact
        # shape of a beat that silently stopped beating, and a beat called once
        # after the loop leaves every batch silent while still looking wired up.
        body = body_of(src, fn)
        seen_e += 1
        inner = loop_body(body)
        if not inner:
            failures.append(
                f"E: `{fn}` has no batch loop - a beat cannot be periodic, so "
                "a single long call still goes silent."
            )
            continue
        fires_in_loop = re.search(r"\bbeat\s*\(", inner) or re.search(
            r"\bonProgress\s*\(", inner
        )
        if not fires_in_loop:
            failures.append(
                f"E: `{fn}` accepts onProgress but never invokes it INSIDE the "
                "batch loop. A parameter that is never called is not a "
                "heartbeat, and one called only after the loop leaves every "
                "batch silent - which is the 929 s failure this gate exists for."
            )

    inspected["D"] = seen_d
    inspected["E"] = seen_e


# --------------------------------------------------------------------------
# Rule F - the call sites broadcast a 'progress' event
# --------------------------------------------------------------------------
def check_call_sites() -> None:
    raw = read(JOBS)
    if not raw:
        failures.append(f"F: cannot read {JOBS.relative_to(REPO)}")
        inspected["F"] = 0
        return
    src = strip_comments(raw)

    seen = 0
    for fn in SETUP_INSERTERS:
        # Take the call expression plus a little following text, so a callback
        # written on the next lines is in scope.
        m = re.search(rf"\b{re.escape(fn)}\s*\(", src)
        if not m:
            failures.append(
                f"F: no call site for `{fn}` in jobs.ts - the inserter is "
                "wired up somewhere this gate does not look"
            )
            continue
        seen += 1
        window = src[m.start(): m.start() + 900]
        # Cut at the end of the statement so we cannot borrow a neighbouring
        # inserter's broadcast and call this one covered.
        cut = window.find("});")
        stmt = window[: cut + 3] if cut > 0 else window
        if "broadcast(" not in stmt or "'progress'" not in stmt:
            failures.append(
                f"F: the `{fn}` call site does not pass a callback that calls "
                "broadcast(job, 'progress', ...). Only a 'progress' (or "
                "'batch') event refreshes job.lastProgressAt, so any other "
                "event kind leaves the watchdog measuring from the last real "
                "beat and the abort still fires."
            )

    inspected["F"] = seen


# --------------------------------------------------------------------------
# Rule G - the shared cadence helper
# --------------------------------------------------------------------------
def check_cadence() -> None:
    src = strip_comments(read(INSERTERS))
    m = re.search(r"PROGRESS_ROWS\s*=\s*([0-9_]+)", src)
    inspected["G"] = 1 if m else 0
    if not m:
        failures.append(
            "G: shared PROGRESS_ROWS cadence constant not found in "
            "inserters.ts. Four inlined thresholds drift apart, and a beat "
            "that stops beating looks exactly like a healthy run."
        )
        return
    rows = int(m.group(1).replace("_", ""))
    if rows <= 0:
        failures.append(f"G: PROGRESS_ROWS must be positive, found {rows}")
    elif rows > 100_000:
        failures.append(
            f"G: PROGRESS_ROWS={rows} is too coarse. At the measured ~78 rows/s "
            "of the DIM_POIS insert, that is far beyond the 15 min "
            "WATCHDOG_STALL_MS window, so the beat would not prevent the abort."
        )

    if not re.search(r"function\s+makeProgressBeat\s*\(", src):
        failures.append(
            "G: makeProgressBeat helper not found - the cadence is inlined per "
            "inserter again"
        )


def main() -> int:
    check_poi_cap()
    check_inserters()
    check_call_sites()
    check_cadence()

    vacuous = [k for k, v in sorted(inspected.items()) if v == 0]

    print("check_studio_generation_guards: items inspected per rule")
    for k, v in sorted(inspected.items()):
        print(f"  rule {k}: {v}")
    print(
        f"  (telemetry-phase inserters deliberately exempt, covered by "
        f"getRouteActivity: {', '.join(TELEMETRY_INSERTERS)})"
    )

    if vacuous:
        print(
            "\nFAILED: rules inspected ZERO items: "
            + ", ".join(vacuous)
            + "\n  The paths in this gate are stale, so those rules cannot "
            "fail and are not protecting anything."
        )
        return 1

    if failures:
        print(f"\nFAILED: {len(failures)} problem(s).\n")
        for f in failures:
            print(f"  - {f}")
        return 1

    print("\nPASSED: POI cap override and setup-phase heartbeats are intact.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
