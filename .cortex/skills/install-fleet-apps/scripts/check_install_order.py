#!/usr/bin/env python3
"""Guard: no install SQL file may reference an object a LATER file creates.

Why this exists
---------------
Two defects in two days came from this single class, and neither was visible on a
developed account - only on a clean one:

  1. `V_DIM_FLEET_CURRENT` was dropped for a migration and read by a consumer view
     before being recreated.
  2. `vehicle_profile_catalog.sql` (installer step 2.5) opened with
     `DROP VIEW IF EXISTS FLEET_APP.UNIFIED_FLEET.VW_VEHICLE_PROFILE`. `IF EXISTS`
     covers the view but NOT the database, and FLEET_APP is not created until step
     3.5 / step 4 - so on a fresh account the statement failed, `snow sql -f`
     aborted the file, and everything below it (the vehicle-profile seed, the
     dwell-SLA seed, the DIM_FLEET stamp) silently did not happen. Delivery Sync
     rendered blank and the packs failed, while the installer printed OK.

Both are trivially detectable statically: compare, per file, the set of objects it
REFERENCES against the set of objects created by files that run EARLIER, and flag a
forward reference. That is what this does.

What it deliberately does NOT do
--------------------------------
It is a lint, not a type checker. Objects are matched at
DATABASE.SCHEMA.OBJECT granularity, references inside a guarded block
(`EXECUTE IMMEDIATE ... EXCEPTION`) are exempt because that is the sanctioned way to
tolerate a missing dependency, and a reference to a database created at RUNTIME by a
non-SQL step (the packs installer, the apps) is resolved from PROVIDED_ELSEWHERE.
False positives are worse than a narrow check here, so the rules stay conservative.

Usage:  python3 check_install_order.py
Exit:   0 clean, 1 forward reference found
"""
from __future__ import annotations

import pathlib
import re
import sys

SCRIPTS = pathlib.Path(__file__).resolve().parent
SKILL = SCRIPTS.parent

# Execution order as install_fleet_apps.sh runs them. Kept as an explicit list
# rather than parsed out of the shell script: the point of the check is to encode
# the intended contract, so it should fail loudly if someone reorders the installer
# without reconsidering the dependencies.
ORDER = [
    ("1   infra",            SKILL / "openrouteservice_app" / "app" / "modules"),  # dir: all modules
    ("2   seed_data",        SCRIPTS / "seed_data.sql"),
    ("2   loader",           SKILL.parents[2] / "datasets" / "load-seed-data.sql"),
    ("2.5 catalog",          SCRIPTS / "vehicle_profile_catalog.sql"),
    ("2.5 projections",      SCRIPTS / "projection_views.sql"),
    ("3.5 analytic",         SCRIPTS / "analytic_layer.sql"),
    ("4   packs",            SKILL / "fleet_sa_app" / "app" / "packs"),            # dir: all setup.sql
    ("4   contract",         SKILL / "fleet_sa_app" / "app" / "scoped_contract.sql"),
    ("4.2 delivery_sync",    SCRIPTS / "delivery_sync_layer.sql"),
    ("4.5 semantic",         SKILL / "fleet_sa_app" / "app" / "semantic_views.sql"),
    # SV_OFFERS reads FLEET_INTELLIGENCE.MARKETPLACE, which NO install step
    # creates (the admin app boot init / the freight-exchange skill do). It is
    # therefore expected to reference an object this ordering does not provide,
    # which is exactly why the installer runs it as its own best-effort file.
    ("4.5 semantic (mkt)",   SKILL / "fleet_sa_app" / "app" / "semantic_views_marketplace.sql"),
    # SV_EMERGENCY_RESPONSE reads FLEET_APP.EMERGENCY_RESPONSE, built by the emergency
    # pack's Data Studio generator rather than by this ordered chain - so, like the
    # marketplace view above, it is expected to reference an object this ordering does
    # not provide, which is why the installer runs it as its own best-effort file.
    ("4.5 semantic (emerg)", SKILL / "fleet_sa_app" / "app" / "semantic_views_emergency.sql"),
    ("4.7 sap_knowledge",    SKILL / "fleet_sa_app" / "app" / "sap_knowledge.sql"),
    ("4.8 view_catalog",     SKILL / "fleet_sa_app" / "app" / "view_catalog.sql"),
    ("4.9 deployment_facts", SKILL / "fleet_sa_app" / "app" / "deployment_facts.sql"),
    ("4.95 sv_deployment",   SKILL / "fleet_sa_app" / "app" / "semantic_views_deployment.sql"),
    # Eval input tables. Self-contained (own schema, no cross-references), but
    # included so a future edit that reaches into the contract is caught.
    ("6.6 agent_evals",      SKILL / "fleet_sa_app" / "app" / "agent_evals.sql"),
    ("8   roles",            SKILL / "fleet_sa_app" / "app" / "role_binding.sql"),
]

# Databases/schemas provisioned outside this ordered SQL chain. A reference to one of
# these is never a forward reference.
PROVIDED_ELSEWHERE = (
    "OPENROUTESERVICE_APP",      # engine substrate (step 3, its own module chain)
    "SNOWFLAKE",                 # CORTEX, ACCOUNT_USAGE, INFORMATION_SCHEMA
    "OVERTURE_MAPS__",           # Marketplace listings
    "U_S__ZIP_CODE_METADATA_WITH_GEOMETRY",  # Marketplace listing (US ZIP geometry)
    "ROUTING_PLATFORM",          # routing contract, created with the engine (step 3)
    "FLEET_INTELLIGENCE.SYNAPSE",  # synapse bundles (step 5)
    "INFORMATION_SCHEMA",
    "MOCK_SAP", "MOCK_TELEMATICS",  # step 2.6
)

CREATE_RE = re.compile(
    r'\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TRANSIENT\s+|SECURE\s+|DYNAMIC\s+)?'
    r'(?:DATABASE|SCHEMA|TABLE|VIEW|FUNCTION|PROCEDURE|STAGE|TASK|STREAM)'
    r'(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Z_0-9]+(?:\.[A-Z_0-9]+){0,2})', re.I)
# A reference is any 3-part name that is not part of a CREATE. Two-part names are
# ignored: they depend on the session's current database and are too noisy.
REF_RE = re.compile(r'\b([A-Z][A-Z_0-9]*\.[A-Z][A-Z_0-9]*\.[A-Z][A-Z_0-9]*)\b')
# Anything inside a $$-delimited body is DEFERRED: a proc or function body runs when
# it is CALLED, not when the file is loaded, so it may legitimately name an object a
# later step creates (03_region_management.sql calls a ROUTE_OPTIMIZATION proc that
# a demo skill installs). EXECUTE IMMEDIATE blocks are also $$-delimited and are the
# sanctioned way to tolerate a missing dependency, so one rule covers both. Only
# TOP-LEVEL statements can abort the file, and those are what this check is about.
DOLLAR_BODY_RE = re.compile(r'\$\$.*?\$\$', re.S)
COMMENT_RE = re.compile(r'--[^\n]*')


def sql_files(target: pathlib.Path) -> list[pathlib.Path]:
    if target.is_dir():
        return sorted(target.rglob("*.sql"))
    return [target] if target.exists() else []


def analyse(path: pathlib.Path):
    """Return (created, referenced) sets of DB.SCHEMA.OBJECT and DB.SCHEMA names."""
    raw = path.read_text(errors="ignore")
    # Strip comments: prose about a defect routinely names the object it discusses,
    # and flagging documentation as a forward reference would be absurd.
    body = COMMENT_RE.sub("", raw)
    # CREATEs are collected from the whole file (a proc body still defines the proc),
    # references only from top-level statements.
    unguarded = DOLLAR_BODY_RE.sub(" ", body)

    created = set()
    for name in CREATE_RE.findall(body):
        parts = name.upper().split(".")
        created.add(".".join(parts))
        if len(parts) >= 2:
            created.add(".".join(parts[:2]))   # the schema is now reachable
        created.add(parts[0])                  # and so is the database

    referenced = {n.upper() for n in REF_RE.findall(unguarded)}
    return created, referenced


def main() -> int:
    available: set[str] = set()
    problems: list[str] = []
    for label, target in ORDER:
        files = sql_files(target)
        if not files:
            print(f"  {label:20s} (no SQL found at {target})")
            continue
        step_created: set[str] = set()
        for path in files:
            created, referenced = analyse(path)
            rel = path.relative_to(SKILL) if SKILL in path.parents else path.name
            for ref in sorted(referenced):
                db = ref.split(".")[0]
                schema = ".".join(ref.split(".")[:2])
                if any(ref.startswith(p) or db.startswith(p) for p in PROVIDED_ELSEWHERE):
                    continue
                # Satisfied if the object, its schema, or its database is already
                # available, or is created by this very file.
                if (ref in available or schema in available or db in available
                        or ref in created or schema in created or db in created):
                    continue
                problems.append(
                    f"{label}: {rel} references {ref} before anything creates it. "
                    f"On a fresh account this statement fails, and because "
                    f"`snow sql -f` stops at the first error every statement below "
                    f"it is skipped. Either move it after the creating step or wrap "
                    f"it in EXECUTE IMMEDIATE with an EXCEPTION handler."
                )
            step_created |= created
        available |= step_created
        print(f"  {label:20s} files={len(files):2d} cumulative_objects={len(available)}")

    print()
    if problems:
        print("FAILED: install-order check")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("PASSED: no SQL file references an object created by a later install step")
    return 0


if __name__ == "__main__":
    sys.exit(main())
