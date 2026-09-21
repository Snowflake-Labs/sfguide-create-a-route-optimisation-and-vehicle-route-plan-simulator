#!/usr/bin/env python3
"""Mutation harness for check_geography_carrier.py.

A gate never seen to fail is not a gate. Each mutation reintroduces one specific
regression the gate claims to forbid; the gate must exit non-zero for every one.
Files are restored after each run, and the final line re-asserts a clean pass.
"""
import re
import shutil
import subprocess
import pathlib

REPO = pathlib.Path(__file__).resolve().parents[4]
GATE = REPO / ".cortex/skills/install-fleet-apps/scripts/check_geography_carrier.py"
BAK = pathlib.Path("/tmp/geo_gate_mut.bak")

INIT = ".cortex/skills/install-fleet-apps/fleet_admin_app/ui/src/server/lib/init.ts"
PACK = ".cortex/skills/install-fleet-apps/fleet_sa_app/app/packs/fleet/backload_matching/setup.sql"
YAML = ".cortex/skills/install-fleet-apps/fleet_sa_app/app/packs/fleet/backload_matching/data-model.yaml"
PROPS = ".cortex/skills/backload-matching/references/proposals-schema.sql"
QROUTE = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/app/api/query/route.ts"
SNOW = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/lib/snowflake.ts"
ADMIN_SQL = ".cortex/skills/install-fleet-apps/fleet_admin_app/ui/src/server/lib/sql.ts"
VIEWMAP = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/components/views/areas/view-map.tsx"
INLINE = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/components/inline/render-map-inline.tsx"
KIT = "packages/fleet-kit/src/map/detect-geo.ts"

MUTATIONS = [
    ("A1 drop PICKUP_GEOM from ONE view in the pack file", PACK,
     "  f.PICKUP_GEOM,\n", ""),
    ("A2 drop DELIVERY_GEOM from the runtime owner's VW_LOADS", INIT,
     "          eo.DROPOFF_GEOM AS DELIVERY_GEOM,\n", ""),
    ("A3 drop geom from the data-model yaml copy", YAML,
     "        f.PICKUP_GEOM,\n", ""),
    ("A4 drop the lane-density endpoint geometry", INIT,
     "            o.PICKUP_LON, o.PICKUP_LAT, o.PICKUP_GEOM,",
     "            o.PICKUP_LON, o.PICKUP_LAT,"),
    ("B1 reintroduce an ST_MAKEPOINT rebuild (runtime owner)", INIT,
     "          iv.PICKUP_GEOM,",
     "          ST_MAKEPOINT(iv.PICKUP_LON, iv.PICKUP_LAT) AS PICKUP_GEOM,"),
    ("B2 reintroduce a rebuild in the reference copy", PROPS,
     "  iv.PICKUP_GEOM,",
     "  ST_MAKEPOINT(iv.PICKUP_LON, iv.PICKUP_LAT) AS PICKUP_GEOM,"),
    ("C1 remove the geography branch (lib/snowflake.ts)", SNOW,
     "const GEO_COLUMN_TYPES = new Set(['geography', 'geometry']);",
     "const GEO_COLUMN_TYPES = new Set(['nope']);"),
    ("C2 stop returning `type` from /api/query", QROUTE,
     "columns: columns.map(({ key, label, type }) => ({ key, label, type })),",
     "columns: columns.map(({ key, label }) => ({ key, label })),"),
    ("C3 drop the geography branch from the admin serializer", ADMIN_SQL,
     "    if (t === 'geography' || t === 'geometry') {", "    if (t === 'nope') {"),
    ("D1 import the rebind but never call it (dashboard)", VIEWMAP,
     "const { layer: bound } = rebindLayerGeometry(layer, data?.columns, rows);",
     "const bound = layer;"),
    ("D2 same on the inline chat surface", INLINE,
     "const { layer: bound, note: rebind } = rebindLayerGeometry(layer, data?.columns, rows);",
     "const bound = layer, rebind = undefined;"),
    ("E1 desync the geography type-name sets", KIT,
     "const GEO_TYPES = new Set(['geography', 'geometry']);",
     "const GEO_TYPES = new Set(['geography']);"),
]

RULE_RE = re.compile(r"- (RULE \w+|VACUITY|PATH)")


def run_gate():
    r = subprocess.run(["python3", str(GATE)], capture_output=True, text=True)
    out = r.stdout + r.stderr
    rules = sorted({m.group(1) for m in (RULE_RE.match(l) for l in out.splitlines()) if m})
    return r.returncode, rules, out


def main() -> int:
    convicted = survived = 0
    for label, rel, old, new in MUTATIONS:
        p = REPO / rel
        orig = p.read_text()
        if old not in orig:
            print(f"ANCHOR-MISS  {label}  ({rel})")
            survived += 1
            continue
        shutil.copy(p, BAK)
        p.write_text(orig.replace(old, new, 1))
        rc, rules, _ = run_gate()
        shutil.copy(BAK, p)
        if rc != 0:
            convicted += 1
            print(f"CONVICTED  {label} -> {rules}")
        else:
            survived += 1
            print(f"SURVIVED   {label}  (gate did not fail)")

    # Vacuity: a wrong repo root makes every path miss. The gate must SAY so
    # rather than pass on zero inspected files.
    gate_orig = GATE.read_text()
    GATE.write_text(gate_orig.replace(
        "REPO = Path(__file__).resolve().parents[4]",
        "REPO = Path(__file__).resolve().parents[3]", 1))
    rc, rules, out = run_gate()
    GATE.write_text(gate_orig)
    if rc != 0 and "VACUITY" in out:
        convicted += 1
        print(f"CONVICTED  V  wrong REPO depth reported as vacuity -> {rules}")
    else:
        survived += 1
        print(f"SURVIVED   V  wrong REPO depth NOT caught (rc={rc})")

    rc, _, out = run_gate()
    print(f"\n{convicted} convicted / {survived} survived")
    print("RESTORED:", out.strip().splitlines()[0], f"exit={rc}")
    return 0 if survived == 0 and rc == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
