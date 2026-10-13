#!/usr/bin/env python3
"""Negative test for check_site_impact_store_keys.py.

Each mutation reintroduces a shape the gate exists to stop; every one must be
CONVICTED by the named rule. Restores from an in-memory copy in `finally`, never
`git checkout` (that once wiped uncommitted fixes in an untouched file).
"""

import subprocess
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
GATE = SKILL / "scripts/check_site_impact_store_keys.py"
VIEWS = SKILL / "fleet_sa_app/app/app-views.json"
SQL = SKILL / "scripts/analytic_layer_live_routing.sql"

# (label, file, find, replace, rule expected to convict)
MUTATIONS = [
    ("candidate isochrone joins stores on id only", VIEWS,
     "s.STORE_ID=x.cid AND s.REGION=x.rgn", "s.STORE_ID=x.cid", "A"),
    ("store-ring lookup region predicate swapped to a join on id", VIEWS,
     "FROM sel x JOIN FLEET_APP.LOCATION.VW_STORES s ON s.STORE_ID=x.cid AND s.REGION=x.rgn",
     "FROM sel x JOIN FLEET_APP.LOCATION.VW_STORES s ON x.rgn IS NOT NULL AND s.STORE_ID=x.cid", "A"),
    ("candidate isochrone back to scalar coordinates", VIEWS,
     "ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(pt.LON,pt.LAT))",
     "ARRAY_CONSTRUCT(ARRAY_CONSTRUCT((SELECT LON FROM pt),(SELECT LAT FROM pt)))", "B"),
    ("candidate isochrone hardcodes driving-car", VIEWS,
     "ISOCHRONES(pt.prof,", "ISOCHRONES('driving-car',", "C"),
    ("LIVE_ZIP_BANDS back to scalar coordinates", SQL,
     "ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(c.LON, c.LAT)),\n      (SELECT ARRAY_AGG(BAND_MIN*60)",
     "ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(\n        (SELECT LON FROM FLEET_INTELLIGENCE.LOCATION.STORES WHERE REGION=P_REGION AND STORE_ID=P_STORE_ID),\n        (SELECT LAT FROM FLEET_INTELLIGENCE.LOCATION.STORES WHERE REGION=P_REGION AND STORE_ID=P_STORE_ID))),\n      (SELECT ARRAY_AGG(BAND_MIN*60)", "B"),
    ("LIVE_ZIP_BANDS row source loses REGION", SQL,
     "           WHERE REGION = P_REGION AND STORE_ID = P_STORE_ID) c,",
     "           WHERE STORE_ID = P_STORE_ID) c,", "D"),
    ("LIVE_CANDIDATE_ISO row source removed", SQL,
     "  FROM (SELECT LON, LAT FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS\n         WHERE REGION = P_REGION AND STORE_ID = P_CANDIDATE_ID) c,\n  TABLE(",
     "  FROM TABLE(", "D"),
    # Comment-only survival: the explanatory comment stays, the code reverts.
    ("row source deleted but its comment kept", SQL,
     "    FROM (SELECT LON, LAT FROM FLEET_INTELLIGENCE.LOCATION.STORE_FACTS\n           WHERE REGION = P_REGION AND STORE_ID = P_CANDIDATE_ID) c,\n    TABLE(",
     "    -- FROM (SELECT LON, LAT FROM x WHERE REGION = P_REGION) c, TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(\n    FROM TABLE(", "D"),
]


def run_gate() -> tuple[bool, list[str]]:
    p = subprocess.run([sys.executable, str(GATE)], capture_output=True, text=True, timeout=60)
    failed = [ln.split("[", 1)[1].split("]", 1)[0]
              for ln in p.stdout.splitlines() if ln.startswith("FAILED [")]
    return p.returncode == 0, failed


def main() -> int:
    ok, failed = run_gate()
    if not ok:
        print(f"ABORT: gate already fails on a clean tree: {failed}")
        return 1
    print("baseline: gate PASSES on the clean tree\n")

    bad = []
    for label, path, find, repl, want in MUTATIONS:
        original = path.read_text(encoding="utf-8")
        if find not in original:
            print(f"ABORT: anchor missing in {path.name} for '{label}'")
            return 1
        try:
            path.write_text(original.replace(find, repl, 1), encoding="utf-8")
            ok, failed = run_gate()
        finally:
            path.write_text(original, encoding="utf-8")
        if ok:
            print(f"SURVIVED  [{want}] {label}   <-- GATE IS BLIND")
            bad.append(label)
        elif want not in failed:
            print(f"MISATTRIB [{want}] {label}   convicted by {failed} instead")
            bad.append(label)
        else:
            print(f"convicted [{want}] {label}")

    ok, failed = run_gate()
    print(f"\nrestored tree: gate {'PASSES' if ok else f'FAILS {failed}'}")
    if bad:
        print(f"\n{len(bad)} mutation(s) not convicted by the intended rule.")
        return 1
    print(f"\nall {len(MUTATIONS)} mutations convicted by the intended rule.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
