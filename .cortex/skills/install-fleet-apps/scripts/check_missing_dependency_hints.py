#!/usr/bin/env python3
"""Guard: a view that reads a layer the installer skipped must tell the user the
real fix, never a guessed one.

What happened (sfseeurope-idoukas_aws1, 2026-10-09 install): the Location layer
was never built, Site Impact showed a raw "does not exist" error, and the user
was told to run a "Location dataset generator in the Admin app" - which does not
exist. The fix (BUILD_LOCATION_DIAGNOSTICS) was written down only in
validate_app_views.py, where neither the app nor the agent could see it.

Rules:
  A  every FLEET_APP.<SCHEMA>. that app-views.json or pack-views.json reads has
     an entry in ui/src/lib/repair-map.json, so a missing object in it maps to a
     builder instead of falling through to the raw error
  B  /api/query's catch calls missingDependencyMessage() BEFORE the generic
     `{ error: rawMsg }` 500 (comments stripped, so a comment naming it does not
     count)
  C  query_location in agent-spec.json AND super-agent-spec.json tells the agent
     what "does not exist" means and names BUILD_LOCATION_DIAGNOSTICS
  D  the Location repair entry's fix names BUILD_LOCATION_DIAGNOSTICS and no
     repair text tells the user to generate a dataset

Usage:  python3 .cortex/skills/install-fleet-apps/scripts/check_missing_dependency_hints.py
Exit:   0 clean, 1 violation
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import sys

REPO = pathlib.Path(os.environ.get("GATE_REPO") or pathlib.Path(__file__).resolve().parents[4])
SKILL = REPO / ".cortex/skills/install-fleet-apps"
APP = SKILL / "fleet_sa_app/app"
UI = SKILL / "fleet_sa_app/ui/src"
REPAIR_MAP = UI / "lib/repair-map.json"
VIEW_FILES = [APP / "app-views.json", UI / "lib/packs/fleet/pack-views.json"]
ROUTE = UI / "app/api/query/route.ts"
SPECS = [APP / "agent-spec.json", APP / "super-agent-spec.json"]

failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"(?<![:'\"\\])//[^\n]*", "", text)


entries = json.loads(REPAIR_MAP.read_text())["entries"]
prefixes = [e["prefix"].upper() for e in entries]

# A
for vf in VIEW_FILES:
    for schema in sorted(set(re.findall(r"FLEET_APP\.([A-Z_]+)\.", vf.read_text()))):
        ref = f"FLEET_APP.{schema}."
        if not any(ref.startswith(p) for p in prefixes):
            fail(f"A {vf.name}: {ref} has no repair-map.json entry; a missing object there shows the raw error")

# B
route = strip_comments(ROUTE.read_text())
catch_at = route.rfind("} catch (err)")
call_at = route.find("missingDependencyMessage(", catch_at) if catch_at >= 0 else -1
generic_at = route.find("{ error: rawMsg }", catch_at) if catch_at >= 0 else -1
if catch_at < 0:
    fail("B route.ts: no top-level catch found")
elif call_at < 0:
    fail("B route.ts: the catch never calls missingDependencyMessage()")
elif generic_at >= 0 and call_at > generic_at:
    fail("B route.ts: missingDependencyMessage() runs after the generic raw-error 500")

# C
for sp in SPECS:
    desc = ""
    for t in json.loads(sp.read_text()).get("tools", []):
        ts = t.get("tool_spec", t)
        if ts.get("name") == "query_location":
            desc = ts.get("description") or ""
    if not desc:
        fail(f"C {sp.name}: query_location tool not found")
    elif "does not exist" not in desc or "BUILD_LOCATION_DIAGNOSTICS" not in desc:
        fail(f"C {sp.name}: query_location does not say what 'does not exist' means or name BUILD_LOCATION_DIAGNOSTICS")

# D
loc = next((e for e in entries if e["prefix"].upper() == "FLEET_APP.LOCATION."), None)
if loc is None:
    fail("D repair-map.json: no FLEET_APP.LOCATION. entry")
elif not any("BUILD_LOCATION_DIAGNOSTICS" in s for s in (loc.get("fix") or [loc["action"]])):
    fail("D repair-map.json: the Location fix does not name BUILD_LOCATION_DIAGNOSTICS")
for e in entries:
    text = " ".join([*(e.get("fix") or []), e.get("note", "")])
    if re.search(r"\bgenerate (a|the) [a-z ]*dataset\b", text, re.I):
        fail(f"D repair-map.json: {e['prefix']} tells the user to generate a dataset")

if failures:
    print("missing-dependency hints: %d violation(s)" % len(failures))
    for f in failures:
        print("  " + f)
    sys.exit(1)
print("missing-dependency hints: OK (%d repair entries)" % len(entries))
