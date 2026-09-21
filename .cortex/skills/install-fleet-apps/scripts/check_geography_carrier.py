#!/usr/bin/env python3
"""Fail when stored GEOGRAPHY is dropped, rebuilt, or left unplugged.

WHY THIS EXISTS
---------------
Every fact table in this repo is dual-carrier: it persists a GEOGRAPHY column
NEXT TO lat/lon numerics (PICKUP_GEOM beside PICKUP_LON/PICKUP_LAT, ORIGIN beside
ORIGIN_LON/ORIGIN_LAT). The numerics are load-bearing and must stay - ORS is an
HTTP API that needs JSON numbers, and a semantic view cannot hold a GEOGRAPHY
column at all. So the failure mode here is never "geometry is missing". It is
that the geometry gets SILENTLY DROPPED at a seam and then rebuilt downstream,
and nothing notices because both sides are individually valid, compile, deploy,
and return correct numbers.

That is exactly what had happened. VW_EXTERNAL_OFFERS projected the numerics and
not PICKUP_GEOM/DROPOFF_GEOM even though its own source (V_FACT_OFFERS_CURRENT)
stored both, so VW_LOADS rebuilt them with ST_MAKEPOINT and
EXTERNAL_OFFER_SEARCH rebuilt the same point FIVE times per row - in the
ST_DWITHIN filter, both projections and the ORDER BY. Nothing was wrong with the
output, which is why it survived.

The same shape has a second half on the client. detectGeoColumns already treated
a declared GEOGRAPHY column as authoritative, but it was imported by exactly one
file - its own test harness - so no runtime path ever called it. A capability
that is built and unplugged looks identical to one that does not exist.

WHAT IT CHECKS
--------------
RULE A  A view that projects a lon/lat PAIR also projects that pair's GEOM
        sibling, wherever the sibling name is used anywhere in the same file.
        This is what stops the geometry being dropped at a seam again.

RULE B  No expression rebuilds a point with ST_MAKEPOINT from a lon/lat pair
        whose GEOM sibling is available in the same file. Construction on INSERT
        is exempt (that is how the stored column is produced in the first place),
        and so is a point built from PROC ARGUMENTS or from an aggregate that has
        no stored geometry.

RULE C  All three row serializers carry an explicit geography branch, and
        /api/query returns the column `type`. Without the type the client cannot
        bind a map layer on declared geometry, which is the one signal that
        survives an empty result set.

RULE D  rebindLayerGeometry is CALLED from the runtime, not merely defined and
        exported. This is the anti-shelfware rule: detect-geo sat unused behind a
        test harness for exactly this reason.

RULE E  The geography type-name sets agree across the three places that encode
        them (both SA serializers and the kit's detector).

Every rule counts what it inspected and fails on zero. A path that resolves to
nothing passes every assertion otherwise, which has happened in this repo before.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]

failures: list[str] = []
# Per-rule tally of files actually opened and matched, so a rule that inspected
# nothing is reported as a failure rather than silently passing.
inspected: dict[str, int] = {}


def fail(msg: str) -> None:
    failures.append(msg)


def seen(rule: str, n: int = 1) -> None:
    inspected[rule] = inspected.get(rule, 0) + n


def read(rel: str) -> str | None:
    p = REPO / rel
    if not p.is_file():
        fail(f"PATH: {rel} does not exist (a gate that inspects nothing cannot fail)")
        return None
    return p.read_text()


def strip_sql_comments(s: str) -> str:
    """Remove `--` line comments and /* */ blocks.

    Comments are stripped FIRST and always. A previous gate in this repo passed
    because it matched the prose comment that documented the very trap it was
    meant to forbid.
    """
    s = re.sub(r"/\*.*?\*/", " ", s, flags=re.S)
    return re.sub(r"--[^\n]*", " ", s)


def strip_ts_comments(s: str) -> str:
    s = re.sub(r"/\*.*?\*/", " ", s, flags=re.S)
    return re.sub(r"(?<![:'\"])//[^\n]*", " ", s)


# ---------------------------------------------------------------------------
# The dual-carrier pairs. Each entry is (lon column, lat column, geom sibling).
# ---------------------------------------------------------------------------
PAIRS = [
    ("PICKUP_LON", "PICKUP_LAT", "PICKUP_GEOM"),
    ("DROPOFF_LON", "DROPOFF_LAT", "DROPOFF_GEOM"),
    ("DELIVERY_LON", "DELIVERY_LAT", "DELIVERY_GEOM"),
    ("ORIGIN_LON", "ORIGIN_LAT", "ORIGIN"),
    ("DESTINATION_LON", "DESTINATION_LAT", "DESTINATION"),
]

# Files that define the backload view chain. All copies, because they drifted
# apart before: the admin app's init.ts is the RUNTIME owner, the pack files are
# what a fresh install deploys, and the references/ pair is the documented shape.
VIEW_FILES = [
    "\u002ecortex/skills/install-fleet-apps/fleet_admin_app/ui/src/server/lib/init.ts",
    "\u002ecortex/skills/install-fleet-apps/fleet_sa_app/app/packs/fleet/backload_matching/setup.sql",
    "\u002ecortex/skills/install-fleet-apps/fleet_sa_app/app/packs/fleet/backload_matching/data-model.yaml",
    "\u002ecortex/skills/backload-matching/references/proposals-schema.sql",
    "\u002ecortex/skills/backload-matching/references/bootstrap.sql",
]

# Views that CARRY geometry to a downstream consumer. RULE A applies only to
# these, and the narrow scope is deliberate.
#
# Requiring the geom sibling on EVERY view that projects a lon/lat pair is
# over-strict, and an over-strict gate gets switched off. VW_CANDIDATES_SCORED is
# the counter-example: it is already geometry-native where it matters
# (ST_DISTANCE / ST_DWITHIN on EMPTY_GEOM and PICKUP_GEOM) and passes
# DELIVERY_LON/DELIVERY_LAT through only as display columns for the solver, which
# needs numbers. Demanding DELIVERY_GEOM there would be noise.
#
# These six are the pool, contract and enrichment views whose consumers DO need
# geometry - they are the seams where dropping it forced the downstream rebuild.
CARRIER_VIEWS = (
    "VW_EXTERNAL_OFFERS",
    "VW_INTERNAL_VOLUMES",
    "VW_TRAILERS",
    "VW_LOADS",
    "VW_TRAILERS_GEO",
    "VW_LANE_DENSITY",
)


def is_carrier(name: str) -> bool:
    """True when `name` is one of CARRIER_VIEWS, in either naming convention.

    The pack data-model declares these WITHOUT the VW_ prefix (`- name:
    EXTERNAL_OFFERS`) while the SQL and TS copies use the full object name
    (VW_EXTERNAL_OFFERS). Comparing only the prefixed form silently skipped every
    YAML view, so a mutation deleting geometry from that copy passed - the yaml
    is one of the four places these views are defined, and it is what a fresh
    install deploys.
    """
    base = name.split(" arm ")[0].split(".")[-1].strip().upper()
    if base.startswith("VW_"):
        base = base[3:]
    return base in {v[3:] if v.startswith("VW_") else v for v in CARRIER_VIEWS}


SERIALIZERS = {
    "\u002ecortex/skills/install-fleet-apps/fleet_sa_app/ui/src/app/api/query/route.ts": True,
    "\u002ecortex/skills/install-fleet-apps/fleet_sa_app/ui/src/lib/snowflake.ts": False,
    "\u002ecortex/skills/install-fleet-apps/fleet_admin_app/ui/src/server/lib/sql.ts": False,
}

DETECT_GEO = "packages/fleet-kit/src/map/rebind-geometry.ts"
KIT_DETECT = "packages/fleet-kit/src/map/detect-geo.ts"

# Runtime call sites that must actually invoke the rebind. Both map surfaces.
REBIND_CALLERS = [
    "\u002ecortex/skills/install-fleet-apps/fleet_sa_app/ui/src/components/inline/render-map-inline.tsx",
    "\u002ecortex/skills/install-fleet-apps/fleet_sa_app/ui/src/components/views/areas/view-map.tsx",
]


def view_chunks(rel: str, code: str) -> list[tuple[str, str]]:
    """Split a file into per-view chunks, as (view name, body).

    The invariant is PER VIEW, not per file, and that distinction is the whole
    rule. A file-scoped version of RULE A passed a mutation that deleted one
    view's PICKUP_GEOM projection, because sibling views in the same file still
    mentioned the column.

    SQL and the TS runtime owner both delimit on CREATE OR REPLACE VIEW; the pack
    data-model delimits on its YAML `- name:` entries.
    """
    if rel.endswith(".yaml"):
        parts = re.split(r"\n\s*-\s+name:\s*(\S+)", code)
        # re.split with one group yields [pre, name1, body1, name2, body2, ...]
        chunks = [(parts[i], parts[i + 1]) for i in range(1, len(parts) - 1, 2)]
    else:
        parts = re.split(r"CREATE\s+OR\s+REPLACE\s+VIEW\s+([\w.$]+)", code, flags=re.I)
        chunks = [(parts[i], parts[i + 1]) for i in range(1, len(parts) - 1, 2)]

    # Split each view again on its UNION arms. A UNION'd view has one projection
    # list PER ARM, and the arms are independent: VW_LOADS carries an internal and
    # an external arm, so a view-scoped rule was satisfied by the OTHER arm's
    # geometry when one arm's projection was deleted. That mutation survived until
    # this split existed.
    out: list[tuple[str, str]] = []
    for name, body in chunks:
        arms = re.split(r"\bUNION\s+(?:ALL\s+)?", body, flags=re.I)
        if len(arms) == 1:
            out.append((name, body))
        else:
            out.extend((f"{name} arm {i + 1}", arm) for i, arm in enumerate(arms))
    return out


def rule_a() -> None:
    """A projected lon/lat pair must be accompanied by its GEOM sibling.

    Scoped to a single view. Only applied when the file as a whole knows the geom
    column exists, so a view reading a source that genuinely has no geometry is
    not accused.
    """
    for rel in VIEW_FILES:
        body = read(rel)
        if body is None:
            continue
        code = strip_sql_comments(body)
        chunks = view_chunks(rel, code)
        if not chunks:
            fail(f"RULE A: {Path(rel).name} yielded no view chunks - the splitter is wrong.")
            continue
        for lon, lat, geom in PAIRS:
            if not re.search(rf"\b{geom}\b", code):
                continue
            for name, chunk in chunks:
                if not is_carrier(name):
                    continue
                if lon not in chunk or lat not in chunk:
                    continue
                seen("A")
                if not re.search(rf"(?:\.|\s|,|^){geom}\b\s*(?:,|AS\b|$|\n)", chunk, re.M | re.I):
                    fail(
                        f"RULE A: {Path(rel).name} view {name} projects {lon}/{lat} "
                        f"but not {geom}, which this file knows exists.\n"
                        "  Dropping the stored geometry here is what forces every "
                        "downstream reader to rebuild it with ST_MAKEPOINT."
                    )


def rule_b() -> None:
    """No ST_MAKEPOINT rebuild of a pair whose GEOM sibling is in the file."""
    for rel in VIEW_FILES:
        body = read(rel)
        if body is None:
            continue
        code = strip_sql_comments(body)
        for lon, lat, geom in PAIRS:
            if not re.search(rf"\b{geom}\b", code):
                continue
            seen("B")
            # Match a rebuild of exactly this pair, with or without an alias.
            pat = re.compile(
                rf"ST_MAKEPOINT\(\s*(?:[A-Za-z_][\w$]*\.)?{lon}\s*,"
                rf"\s*(?:[A-Za-z_][\w$]*\.)?{lat}\s*\)",
                re.I,
            )
            for m in pat.finditer(code):
                fail(
                    f"RULE B: {Path(rel).name} rebuilds a point with "
                    f"`{m.group(0)}` while {geom} is available in the same file.\n"
                    "  Read the stored column instead. If this really is an "
                    "INSERT that PRODUCES the stored column, move it out of a "
                    "view definition."
                )


def rule_c() -> None:
    """Explicit geography branch in every serializer; `type` returned by /api/query."""
    for rel, is_query_route in SERIALIZERS.items():
        body = read(rel)
        if body is None:
            continue
        code = strip_ts_comments(body)
        seen("C")
        if "geography" not in code.lower():
            fail(
                f"RULE C: {Path(rel).name} has no geography branch. GEOGRAPHY then "
                "reaches the map only by falling through the final `else` as an "
                "untouched string - which works, but nothing declares that the "
                "map path depends on it."
            )
        if is_query_route:
            # The map binding needs the DECLARED type. Assert the returned column
            # objects carry it, not merely that the word appears somewhere.
            if not re.search(r"columns\s*:\s*columns\.map\(\s*\(\s*\{[^}]*\btype\b[^}]*\}", code):
                fail(
                    f"RULE C: {Path(rel).name} does not return `type` on its columns. "
                    "Without the declared Snowflake type the client cannot bind a "
                    "map layer to a GEOGRAPHY column, and the type is the only "
                    "geometry signal that survives an empty result set."
                )


def rule_d() -> None:
    """rebindLayerGeometry must be CALLED, not just defined and exported."""
    mod = read(DETECT_GEO)
    if mod is not None:
        seen("D")
        if "export function rebindLayerGeometry" not in mod:
            fail(f"RULE D: {Path(DETECT_GEO).name} does not export rebindLayerGeometry.")
    callers = 0
    for rel in REBIND_CALLERS:
        body = read(rel)
        if body is None:
            continue
        code = strip_ts_comments(body)
        seen("D")
        # A call, not an import. `import { rebindLayerGeometry }` alone is exactly
        # the shelfware state this rule exists to forbid.
        if not re.search(r"rebindLayerGeometry\s*\(", code):
            fail(
                f"RULE D: {Path(rel).name} never CALLS rebindLayerGeometry. "
                "detectGeoColumns was already imported by nothing but its own test "
                "harness; an unplugged capability is indistinguishable from a "
                "missing one."
            )
        else:
            callers += 1
    if callers == 0:
        fail("RULE D: no runtime map surface calls rebindLayerGeometry at all.")


def rule_e() -> None:
    """The geography type-name sets must agree across all three encodings."""
    sets: dict[str, set[str]] = {}
    for rel, var in [
        ("\u002ecortex/skills/install-fleet-apps/fleet_sa_app/ui/src/app/api/query/route.ts", "GEO_COLUMN_TYPES"),
        ("\u002ecortex/skills/install-fleet-apps/fleet_sa_app/ui/src/lib/snowflake.ts", "GEO_COLUMN_TYPES"),
        (KIT_DETECT, "GEO_TYPES"),
    ]:
        body = read(rel)
        if body is None:
            continue
        m = re.search(rf"{var}\s*=\s*new Set\(\s*\[([^\]]*)\]", strip_ts_comments(body))
        if not m:
            fail(f"RULE E: {Path(rel).name} does not declare {var} as a Set literal.")
            continue
        seen("E")
        sets[f"{Path(rel).name}:{var}"] = {t.strip().strip("'\"").lower() for t in m.group(1).split(",") if t.strip()}
    if len(sets) > 1:
        distinct = {frozenset(v) for v in sets.values()}
        if len(distinct) > 1:
            detail = "; ".join(f"{k}={sorted(v)}" for k, v in sets.items())
            fail(
                "RULE E: the geography type-name sets disagree, so a column one "
                f"layer treats as geometry another treats as text. {detail}"
            )


def report() -> int:
    empty = [r for r in ("A", "B", "C", "D", "E") if inspected.get(r, 0) == 0]
    for r in empty:
        fail(
            f"VACUITY: RULE {r} inspected 0 files, so it cannot fail and proves "
            "nothing. Check the paths in this script."
        )
    if failures:
        print("check_geography_carrier: FAILED\n")
        for f in failures:
            print(f"- {f}\n")
        return 1
    counts = ", ".join(f"{r}={inspected.get(r, 0)}" for r in ("A", "B", "C", "D", "E"))
    print(
        "check_geography_carrier: PASSED - stored geometry is projected, not "
        f"rebuilt; the serializers declare it; the rebind is wired ({counts})"
    )
    return 0


def main() -> int:
    rule_a()
    rule_b()
    rule_c()
    rule_d()
    rule_e()
    return report()


if __name__ == "__main__":
    sys.exit(main())
