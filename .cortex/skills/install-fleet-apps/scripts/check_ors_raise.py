#!/usr/bin/env python3
"""Guard: every SA app view that depends on live routing must FAIL LOUDLY when
the region's ORS engine is suspended.

The failure this prevents is silent, which is why it needs a check. An ORS
wrapper does not throw when its service is suspended: `ISOCHRONES` returns a row
whose GEOJSON is NULL and `MATRIX_TABULAR` a VARIANT whose durations are NULL,
with the reason (`service_unreachable` + the `ors-service-<region>` host) buried
in the response. Any consumer that filters the NULL away - `IS NOT NULL`, an
inner join on `group_index`, a FLATTEN over a missing `features` array - converts
an outage into an EMPTY RESULT SET. The panel then renders blank, which is
indistinguishable from "there is no data for this selection", and the app's
existing auto-resume path never fires because no error ever reached it.

Raising instead is what makes the whole chain work: /api/query matches the
message against its suspend signatures, resumes the region, and returns a typed
503 that the UI renders as "engine starting, retry in ~N min".

The check is per VIEW, not per query. A view may legitimately contain a query
that degrades quietly (see the exemptions below) as long as at least one query in
that view raises, because one notice per view is all the user needs.

Usage:
    python3 .cortex/skills/install-fleet-apps/scripts/check_ors_raise.py

Exit 0 = clean, 1 = a view touches live routing but nothing in it can raise.
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

SKILL_DIR = pathlib.Path(__file__).resolve().parents[1]
APP_DIR = SKILL_DIR / "fleet_sa_app" / "app"
CONFIG_FILES = [APP_DIR / "app-views.json", APP_DIR / "starter" / "app-views.json"]
SQL_FILES = [
    SKILL_DIR / "scripts" / "analytic_layer.sql",
    SKILL_DIR / "scripts" / "delivery_sync_layer.sql",
]

# Direct ORS entrypoints. A query naming one of these calls the engine itself.
ORS_ENTRYPOINTS = re.compile(
    r"OPENROUTESERVICE_APP\.CORE\.(ISOCHRONES|MATRIX_TABULAR|MATRIX|DIRECTIONS|OPTIMIZATION)"
    r"|ROUTING_PLATFORM\.CONTRACT\._DISPATCH_OPTIMIZATION",
    re.IGNORECASE,
)

# The guards. Any of these in a query (or in a function body) means that SQL
# raises on a suspended engine.
GUARD_TOKENS = re.compile(
    r"FLEET_APP\.CORE\.ORS_(OK|FEATURES|MATRIX)"
    # The two hand-rolled raises predating the shared guards (delivery sync).
    r"|TO_GEOGRAPHY\(\s*'ORS\s"
    r"|TO_NUMBER\(\s*'ORS\s",
    re.IGNORECASE,
)

# LIVE_* wrappers around ORS. Whether one raises is decided by its body, which is
# resolved from the SQL sources below - never assumed from the name.
LIVE_FN = re.compile(r"\b(?:FLEET_APP|FLEET_INTELLIGENCE)\.[A-Z_]+\.(LIVE_[A-Z0-9_]+)\s*\(", re.IGNORECASE)

# Views whose ORS-touching queries are ALLOWED not to raise, keyed by view id.
# Every entry needs a reason: an unexplained pass teaches people to ignore the
# harness. A view listed here still has to be covered by a raising sibling query,
# which is exactly what the reason has to argue.
EXEMPT_VIEWS: dict[str, str] = {}

# Individual LIVE_* functions that deliberately degrade instead of raising. These
# are NOT view-level exemptions: a view relying only on these still fails.
KNOWN_DEGRADERS = {
    "LIVE_FLEET_STATUS": (
        "positions and ON_SITE/JUST_LEFT come from Snowflake data and stay correct "
        "without routing; raising would blank the whole vehicles layer over a "
        "missing sub-status"
    ),
    "LIVE_APPROACH_RINGS": (
        "FLATTEN over a missing features array yields zero rows, so a guard would "
        "never be evaluated; the single-site ring on the same map is the canary"
    ),
}


def raising_functions() -> tuple[dict[str, bool], list[str]]:
    """Map LIVE_* function name -> True when its body can raise.

    Bodies are split on CREATE [OR REPLACE] FUNCTION so a guard in one function
    is never credited to its neighbour.
    """
    out: dict[str, bool] = {}
    problems: list[str] = []
    for path in SQL_FILES:
        if not path.exists():
            problems.append(f"{path}: missing")
            continue
        text = path.read_text()
        chunks = re.split(r"CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+", text, flags=re.IGNORECASE)
        for chunk in chunks[1:]:
            name_match = re.match(r"[A-Z_]+\.[A-Z_]+\.(LIVE_[A-Z0-9_]+)", chunk, re.IGNORECASE)
            if not name_match:
                continue
            name = name_match.group(1).upper()
            body = chunk
            raises = bool(GUARD_TOKENS.search(body))
            if not raises:
                # A thin delegate inherits from what it calls.
                called = {m.group(1).upper() for m in LIVE_FN.finditer(body)} - {name}
                raises = any(out.get(c) for c in called)
            # OR-accumulate: the FLEET_APP delegate and its FLEET_INTELLIGENCE
            # implementation share a name.
            out[name] = out.get(name, False) or raises
    return out, problems


def collect_queries(node, path: str, acc: list[tuple[str, str]]) -> None:
    """Collect (label, sql) pairs. Label prefers a nearby id over a positional
    path, because inserting one layer renumbers every path after it."""
    if isinstance(node, dict):
        label = node.get("id") if isinstance(node.get("id"), str) else path
        q = node.get("query")
        if isinstance(q, str):
            acc.append((label, q))
        for key, val in node.items():
            collect_queries(val, f"{path}.{key}", acc)
    elif isinstance(node, list):
        for i, val in enumerate(node):
            collect_queries(val, f"{path}[{i}]", acc)


def query_raises(sql: str, fn_raises: dict[str, bool]) -> bool:
    if GUARD_TOKENS.search(sql):
        return True
    return any(fn_raises.get(m.group(1).upper(), False) for m in LIVE_FN.finditer(sql))


def query_touches_ors(sql: str, fn_raises: dict[str, bool]) -> bool:
    if ORS_ENTRYPOINTS.search(sql):
        return True
    # A LIVE_* function is an ORS wrapper by construction (it is how this repo
    # names them), so a query calling one that we know about touches routing.
    return any(m.group(1).upper() in fn_raises for m in LIVE_FN.finditer(sql))


def main() -> int:
    problems: list[str] = []
    fn_raises, sql_problems = raising_functions()
    problems.extend(sql_problems)

    if not fn_raises:
        problems.append("no LIVE_* functions found in the SQL sources - check SQL_FILES")

    # Report degraders that have silently acquired a guard, or vanished, so the
    # documented asymmetry cannot rot.
    for name, reason in KNOWN_DEGRADERS.items():
        if name not in fn_raises:
            problems.append(f"KNOWN_DEGRADERS lists {name}, which no longer exists")
        elif fn_raises[name]:
            problems.append(
                f"{name} now raises but is still listed in KNOWN_DEGRADERS "
                f"(reason given: {reason}) - remove the entry"
            )

    checked = 0
    for path in CONFIG_FILES:
        if not path.exists():
            problems.append(f"{path}: missing")
            continue
        try:
            views = json.loads(path.read_text())
        except json.JSONDecodeError as exc:
            problems.append(f"{path}: invalid JSON ({exc})")
            continue
        if not isinstance(views, dict):
            problems.append(f"{path}: expected an object of view id -> view")
            continue
        for view_id, view in views.items():
            if not isinstance(view, dict):
                continue
            queries: list[tuple[str, str]] = []
            collect_queries(view, view_id, queries)
            ors = [(lbl, q) for lbl, q in queries if query_touches_ors(q, fn_raises)]
            if not ors:
                continue
            checked += 1
            if view_id in EXEMPT_VIEWS:
                continue
            if not any(query_raises(q, fn_raises) for _, q in ors):
                labels = ", ".join(sorted({lbl for lbl, _ in ors})[:6])
                problems.append(
                    f"{path.name}: view '{view_id}' calls live routing "
                    f"({len(ors)} query/queries: {labels}) but NOTHING in it raises "
                    f"on a suspended engine - it will render blank instead of the "
                    f"resume notice. Guard the ORS call with FLEET_APP.CORE.ORS_OK / "
                    f"ORS_FEATURES / ORS_MATRIX."
                )

    if problems:
        print("check_ors_raise: FAIL")
        for p in problems:
            print(f"  - {p}")
        return 1
    print(f"check_ors_raise: OK ({checked} live-routing view(s) covered, "
          f"{sum(1 for v in fn_raises.values() if v)}/{len(fn_raises)} LIVE_* functions raise)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
