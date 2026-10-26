#!/usr/bin/env python3
"""Guard: a view whose data layer was not built is shown unavailable, with the
reason and fix, in the app AND to the agent - never silently hidden, never
recommended.

What happened (sfseeurope-idoukas_aws1): FLEET_APP.LOCATION was never built,
yet Site Impact was offered; users clicked into a feature that could not work.
The app's gate could only HIDE (no reason), scanned only top-level queries,
never probed function-only schemas, and the agent catalog had no availability.

Rules:
  A  lib/view-deps.ts and layer_impact.py find the SAME schemas for every view,
     and choose the SAME probe object per schema
     in app-views.json (tsx probe), so the app gate, the installer summary and
     the agent catalog agree on what a view needs
  B  view_catalog.sql carries REQUIRED_SCHEMAS and site_impact lists LOCATION
  C  load-views registers an absent layer as `unavailable`, and `hidden` comes
     from the authored view only (comments stripped)
  D  view-panel renders UnavailableViewNotice for an unavailable view
  E  pack-status walks nested queries (viewDataRefs), probes function-only
     schemas in INFORMATION_SCHEMA.FUNCTIONS, and returns `layers`
  F  show_view, deep_link and list_use_cases call layerGapsFor();
     list_use_cases returns missing_layers and empty_layers
  G  the agent row probe only touches objects that exist, from validated
     three-part names in allowed databases

Needs the SA app's node_modules (tsx).
Usage:  python3 .cortex/skills/install-fleet-apps/scripts/check_view_availability.py
Exit:   0 clean, 1 violation
"""
from __future__ import annotations

import json
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
SKILL = HERE.parent
UI = SKILL / "fleet_sa_app" / "ui"
SRC = UI / "src"
sys.path.insert(0, str(HERE))
from layer_impact import load_views, schema_probes, view_schemas  # noqa: E402

failures: list[str] = []


def code(p: pathlib.Path) -> str:
    text = p.read_text()
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"(?<![:'\"\\])//[^\n]*", "", text)


# A
p = subprocess.run(["npx", "tsx", "scripts/print-view-schemas.mts"], cwd=UI,
                   capture_output=True, text=True, timeout=300)
if p.returncode != 0:
    failures.append("A tsx probe failed: %s" % p.stderr.strip()[-300:])
else:
    probe_out = json.loads(p.stdout.strip().splitlines()[-1])
    ts = probe_out["schemas"]
    py_probes = {s: [o, fn] for s, (o, fn) in schema_probes(load_views()).items()}
    if probe_out["probes"] != py_probes:
        bad = sorted(k for k in set(py_probes) | set(probe_out["probes"])
                     if py_probes.get(k) != probe_out["probes"].get(k))
        failures.append("A probe choice differs between view-deps.ts and layer_impact.py for: %s" % bad)
    for vid, v in load_views().items():
        py = view_schemas(v)
        if ts.get(vid) != py:
            failures.append("A %s: view-deps.ts finds %s, layer_impact.py finds %s" % (vid, ts.get(vid), py))

# B
cat = (SKILL / "fleet_sa_app" / "app" / "view_catalog.sql").read_text()
if not re.search(r"^\s*REQUIRED_SCHEMAS\s+ARRAY\b", cat, re.M):
    failures.append("B view_catalog.sql has no REQUIRED_SCHEMAS column")
else:
    m = re.search(r"\$\$site_impact\$\$.*?ARRAY_CONSTRUCT\(([^()]*)\),\s*ARRAY_CONSTRUCT\(([^()]*)\);?\s*(?:UNION ALL|;|$)", cat, re.S)
    if not m or "$$LOCATION$$" not in m.group(1):
        failures.append("B site_impact's REQUIRED_SCHEMAS does not list LOCATION")
    if not re.search(r"^\s*REQUIRED_OBJECTS\s+ARRAY\b", cat, re.M):
        failures.append("B view_catalog.sql has no REQUIRED_OBJECTS column (agents cannot see an empty layer)")
    elif not m or "$$rows:FLEET_APP.LOCATION." not in m.group(2):
        failures.append("B site_impact's REQUIRED_OBJECTS has no rows: probe on a LOCATION object")

# C
lv = code(SRC / "lib" / "load-views.tsx")
if not re.search(r"\bunavailable\s*[,}]", lv) or "unavailableFor(" not in lv:
    failures.append("C load-views never sets `unavailable` from the layer status")
hid = re.findall(r"hidden:\s*([^,\n]+)", lv)
if any(h.strip() not in ("view.hidden", "true") for h in hid):
    failures.append("C load-views derives `hidden` from something other than the authored view: %s" % hid)

# D
vp = code(SRC / "components" / "views" / "view-panel.tsx")
if not re.search(r"\.unavailable\s*\?\s*\(\s*<UnavailableViewNotice", vp):
    failures.append("D view-panel does not render UnavailableViewNotice for an unavailable view")

# E
ps = code(SRC / "app" / "api" / "pack-status" / "route.ts")
for needle, why in (("schemaProbes(", "shared nested-query probe choice"),
                    ("INFORMATION_SCHEMA.FUNCTIONS WHERE FUNCTION_SCHEMA", "function-only schema probe"),
                    ("layers", "per-schema layers in the response")):
    if needle not in ps:
        failures.append("E pack-status lacks the %s (%s)" % (why, needle))

# F
procs = SKILL / "fleet_tools" / "user" / "src" / "procs"
for verb in ("show_view.ts", "deep_link.ts", "list_use_cases.ts"):
    if "layerGapsFor(" not in code(procs / verb):
        failures.append("F %s never checks layerGapsFor()" % verb)
luc = code(procs / "list_use_cases.ts")
for field in ("missing_layers", "empty_layers"):
    if not re.search(r"\br\.%s\s*=" % field, luc):
        failures.append("F list_use_cases does not return %s" % field)

# G  the agent probe: rows only over objects that EXIST (one missing object
#    inside a UNION ALL fails the whole probe), and FQNs validated before
#    being interpolated into FROM
help_ = code(SKILL / "fleet_tools" / "user" / "src" / "helpers.ts")
m = re.search(r"const probe = \[(.*?)\];", help_, re.S)
if not m or "existing.has(" not in m.group(1):
    failures.append("G the row probe is not restricted to objects that exist")
if not re.search(r"SPEC_RE\s*=\s*/\^\(rows\|exists\|function\):\(\[A-Z0-9_\]\+\)", help_) or "SPEC_RE.exec(" not in help_:
    failures.append("G probe specs are not validated against a strict three-part identifier")
if "PROBE_DATABASES.has(" not in help_:
    failures.append("G probe specs are not restricted to the allowed databases")

if failures:
    print("view availability: %d violation(s)" % len(failures))
    for f in failures:
        print("  " + f)
    sys.exit(1)
print("view availability: OK")
