#!/usr/bin/env python3
"""Negative test for check_offgraph_region_keys.py.

Each mutation reintroduces one of the shapes the gate exists to stop. Every one
must be CONVICTED by the named rule; a SURVIVED line means the gate is blind
there and the rule is decoration.

Restores from an in-memory copy, never `git checkout` - doing that once wiped
uncommitted fixes in a file the mutation never touched.
"""

import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
GATE = REPO / ".cortex/skills/install-fleet-apps/scripts/check_offgraph_region_keys.py"
SKILL = REPO / ".cortex/skills/install-fleet-apps"
SA = SKILL / "fleet_sa_app"

VIEW = SA / "ui/src/components/views/areas/backload-matching.tsx"
HELP = SA / "ui/src/components/views/areas/backload-matching/helpers.ts"
SETUP = SA / "app/packs/fleet/backload_matching/setup.sql"
INIT = SKILL / "fleet_admin_app/ui/src/server/lib/init.ts"
MARKET = SKILL / "scripts/marketplace_layer.sql"

# (label, file, find, replace, rule letter expected to convict)
MUTATIONS = [
    ("drop REGION from a last_drop partition", SETUP,
     "PARTITION BY REGION, VEHICLE_ID ORDER BY TRIP_END",
     "PARTITION BY VEHICLE_ID ORDER BY TRIP_END", "A"),
    ("drop a last_drop join REGION predicate", INIT,
     "JOIN last_drop ld ON ld.VEHICLE_ID = f.VEHICLE_ID AND ld.REGION = f.REGION",
     "JOIN last_drop ld ON ld.VEHICLE_ID = f.VEHICLE_ID", "A"),
    ("drop a POI join REGION predicate", SETUP,
     "h ON h.LOCATION_ID = f.HOME_LOCATION_ID AND h.REGION = f.REGION",
     "h ON h.LOCATION_ID = f.HOME_LOCATION_ID", "B"),
    ("revert a POI rollup to GROUP BY LOCATION_ID", INIT,
     "GROUP BY LOCATION_ID, REGION", "GROUP BY LOCATION_ID", "B"),
    ("revert the fleet rollup to GROUP BY VEHICLE_ID", INIT,
     "GROUP BY VEHICLE_ID, REGION", "GROUP BY VEHICLE_ID", "B"),
    # The marketplace mirror was missed on the first pass and surfaced only as
    # DRIFT from a different gate. Pinned here so it stays in scope.
    ("drop the REGION predicate in the marketplace mirror", MARKET,
     "p ON p.LOCATION_ID = f.PICKUP_POI_ID AND p.REGION = f.REGION",
     "p ON p.LOCATION_ID = f.PICKUP_POI_ID", "B"),
    ("bbox read switched to REGION_REGISTRY", HELP,
     "FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP WHERE REGION",
     "FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY WHERE REGION_NAME", "C"),
    ("delete the bbox pre-flight call", VIEW,
     "const graphBox = await fetchRegionBbox(cfg.region, { signal: ac.signal });",
     "const graphBox = null;", "C"),
    ("zero-pool branch ignores a bbox rejection", VIEW,
     "if (probeTrustworthy || bboxRejected > 0) {", "if (probeTrustworthy) {", "C"),
    ("422 branch drops the no-progress guard", VIEW,
     "if (!droppedCoords.includes(k)) keys.add(k);", "keys.add(k);", "D"),
    ("422 branch reads the field but never retries", VIEW,
     "          continue;\n        }\n      }", "        }\n      }", "D"),
    ("probe treats out-of-graph as transient again", HELP,
     "if (isOutOfGraph(text)) return { kind: 'off-graph', named: parseOutOfGraphPoints(text) };",
     "if (false) return { kind: 'off-graph', named: [] };", "E"),
    ("off-graph convictions no longer exempt from the backoff", HELP,
     "    offGraphConvicted === 0 &&\n", "", "E"),
    ("named coordinates never parsed out of the refusal", HELP,
     "named: parseOutOfGraphPoints(text)", "named: []", "E"),
    ("probe collects points from vrpVehicles again", VIEW,
     "for (const v of workVehicles) { addPt(v.start); addPt(v.end); }",
     "for (const v of vrpVehicles.filter(() => true)) { addPt(v.start); addPt(v.end); }", "F"),
    ("shared shear helper renamed away", VIEW,
     "const shearByKeys = (badKeys: Set<string>): void => {",
     "const shearByKeysRenamed = (badKeys: Set<string>): void => {", "F"),
]


def run_gate() -> tuple[bool, list[str]]:
    p = subprocess.run([sys.executable, str(GATE)], capture_output=True, text=True)
    failed = [
        ln.split("[", 1)[1].split("]", 1)[0].split()[0]
        for ln in p.stdout.splitlines()
        if ln.startswith("FAILED [")
    ]
    return p.returncode == 0, failed


def main() -> int:
    clean_ok, clean_failed = run_gate()
    if not clean_ok:
        print(f"ABORT: gate already fails on a clean tree: {clean_failed}")
        return 1
    print("baseline: gate PASSES on the clean tree\n")

    survived, misattributed = [], []
    for label, path, find, repl, want in MUTATIONS:
        original = path.read_text(encoding="utf-8")
        if find not in original:
            print(f"ABORT: anchor missing in {path.name} for '{label}'")
            return 1
        path.write_text(original.replace(find, repl, 1), encoding="utf-8")
        try:
            ok, failed = run_gate()
        finally:
            path.write_text(original, encoding="utf-8")

        if ok:
            print(f"SURVIVED  [{want}] {label}   <-- GATE IS BLIND")
            survived.append(label)
        elif want not in failed:
            print(f"MISATTRIB [{want}] {label}   convicted by {failed} instead")
            misattributed.append(label)
        else:
            print(f"convicted [{want}] {label}" + (f"  (also {[f for f in failed if f != want]})" if len(failed) > 1 else ""))

    ok, failed = run_gate()
    print(f"\nrestored tree: gate {'PASSES' if ok else f'FAILS {failed}'}")
    if survived or misattributed:
        print(f"\n{len(survived)} survived, {len(misattributed)} misattributed - the gate does not hold.")
        return 1
    print(f"\nall {len(MUTATIONS)} mutations convicted by the intended rule.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
