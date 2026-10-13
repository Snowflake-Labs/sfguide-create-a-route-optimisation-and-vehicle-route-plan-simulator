#!/usr/bin/env python3
"""
check_offgraph_region_keys.py - a stop outside the road graph must be EXCLUDED,
and a region-scoped dimension must be joined ON its region.

WHY THIS IS A GATE

Backload Matching on a freshly generated UsTexas dataset answered:

  "Solve returned no assignments. 1 location in this request is outside the
   UsTexas road graph ... (for example: 27.4475, -82.5730)."

That coordinate is in Florida, ~900 km past the Texas graph. It got there
because VW_TRAILERS derived each trailer's current position from its last trip
keyed on VEHICLE_ID ALONE:

    QUALIFY ROW_NUMBER() OVER (PARTITION BY VEHICLE_ID ORDER BY TRIP_END DESC)
    ...
    JOIN last_drop ld ON ld.VEHICLE_ID = f.VEHICLE_ID

VEHICLE_ID is unique only WITHIN a region. Measured on tib85385, V-DRI-00013 and
V-DRI-00019 exist in both UsTexas and UnitedStatesOfAmerica, so 3 of 30 Texas
trailers took a USA trip's destination and 2 of those landed in Florida. The
mirrored USA leak (27 rows) was invisible because Texas is INSIDE the USA graph,
which is why this surfaced only when a sub-national region was added.

The same id-only key on the POI joins fanned 27 Texas trailers into 40 rows and
300 offers into 345 (483 LOCATION_IDs appear in more than one region), so the
solver double-counted capacity and savings with nothing thrown.

Why the client could not save itself, which is the durable half:

  - A point outside the graph bbox does NOT come back as a null duration cell.
    It fails the whole ORS request with code 6010, so findUnroutablePoints' bare
    `catch` classed it as transient and kept all 150 points of the batch - the
    pre-filter failing open on the exact case it exists for.
  - The 422 body ALREADY named the offending coordinates in `outOfGraphPoints`
    and nothing read it. outOfGraphMessage() contains no "location [lon,lat]"
    substring, so the retry loop's regex found nothing, `bad` stayed null, and
    the one error shape that names its own remedy broke out as `fatal` on the
    FIRST attempt.

SIX RULES
  A. Every last_drop row pick must partition on REGION as well as VEHICLE_ID,
     and every last_drop join must carry a REGION predicate. Asserted per COPY:
     there are five (pack setup.sql, pack data-model.yaml, admin init.ts, the
     marketplace mirror, legacy bootstrap.sql) and fixing four leaves the fifth
     shipping - the fifth was found only because a separate parity gate reported
     it as DRIFT rather than as the missing region key it was.
  B. Every DIM_POIS join must carry a REGION predicate, and every DIM_POIS /
     DIM_FLEET pre-aggregation must GROUP BY REGION. The GROUP BY half matters
     on its own: collapsing on the id alone DISCARDS one of the two regions a
     colliding id belongs to, so the join predicate has nothing left to select.
  C. solve() must read the graph bbox from REGION_ORS_MAP and shear before the
     ORS probe. REGION_ORS_MAP by name, not REGION_REGISTRY: the registry bbox
     is a boundary envelope for camera framing, and deciding routability on it
     is a different number from the one ORS enforces.
  D. The 422 path must READ outOfGraphPoints and REACH a retry - asserted as
     `continue` inside the branch, not merely as a mention of the field. A
     version that logs the points and still breaks satisfies every
     name-matching rule and reproduces the original defect exactly.
  E. findUnroutablePoints must classify an out-of-graph throw via isOutOfGraph
     and convict the named coordinates, rather than treating every error as
     transient. Asserted as `isOutOfGraph` reached from inside the catch AND a
     `bad.add` on a parsed point.
  F. The ORS probe and the bbox pre-flight must read the CURRENT work sets, not
     the original vrp* arrays. Three copies of the shear each reassigned from
     the originals, so whichever ran last silently restored what an earlier pass
     had removed - which would hand ORS back the very point the bbox check just
     excluded.

Comments are stripped before matching. This repo has had rules false-pass off
the comment that documents the trap. Every rule reports how many items it
inspected and the run fails on zero: two gates here have previously passed while
inspecting nothing at all.
"""

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
SKILL = REPO / ".cortex/skills/install-fleet-apps"
SA_APP = SKILL / "fleet_sa_app"

VIEW = SA_APP / "ui/src/components/views/areas/backload-matching.tsx"
HELPERS = SA_APP / "ui/src/components/views/areas/backload-matching/helpers.ts"

# Every copy of the backload contract views. All four define last_drop and the
# POI joins; a fix applied to some of them still ships the defect. The
# marketplace mirror is included because it carries the SAME id-only POI join and
# the parity gate compares it against init.ts - fixing init.ts alone reports as
# drift rather than as the missing region key it is.
VIEW_COPIES = [
    SA_APP / "app/packs/fleet/backload_matching/setup.sql",
    SA_APP / "app/packs/fleet/backload_matching/data-model.yaml",
    SKILL / "fleet_admin_app/ui/src/server/lib/init.ts",
    SKILL / "scripts/marketplace_layer.sql",
    REPO / ".cortex/skills/backload-matching/references/bootstrap.sql",
]


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8") if p.is_file() else ""


def strip_comments(src: str) -> str:
    """Remove SQL (--), JS (//) and block comments.

    Required, not tidiness: the fix for this defect is DOCUMENTED in a comment
    in every file it touches, so an unstripped scan passes on a file whose code
    still carries the bug.
    """
    src = re.sub(r"/\*.*?\*/", " ", src, flags=re.S)
    out = []
    for line in src.splitlines():
        line = re.sub(r"--.*$", "", line)
        line = re.sub(r"(?<!:)//.*$", "", line)
        out.append(line)
    return "\n".join(out)


def rule_a():
    """last_drop partitioned and joined on REGION, in every copy."""
    violations, checked = [], 0
    for path in VIEW_COPIES:
        src = strip_comments(read(path))
        if not src:
            violations.append(f"{path.name}: file missing or empty")
            continue
        name = path.name

        parts = re.findall(
            r"ROW_NUMBER\(\)\s*OVER\s*\(\s*PARTITION\s+BY\s+([^)]*?)ORDER\s+BY\s+TRIP_END",
            src,
            flags=re.I | re.S,
        )
        for keys in parts:
            checked += 1
            if "VEHICLE_ID" not in keys.upper():
                continue  # a TRIP_END row pick not keyed on the vehicle
            if "REGION" not in keys.upper():
                violations.append(
                    f"{name}: last_drop partitions on `{keys.strip()}` without REGION - "
                    "VEHICLE_ID repeats across regions, so this picks another region's trip"
                )

        joins = re.findall(r"JOIN\s+last_drop\s+(\w+)\s+ON\s+([^\n]*)", src, flags=re.I)
        for alias, cond in joins:
            checked += 1
            if not re.search(rf"\b{alias}\.REGION\s*=", cond, flags=re.I):
                violations.append(
                    f"{name}: `JOIN last_drop {alias}` has no {alias}.REGION predicate "
                    f"({cond.strip()[:70]})"
                )
    return violations, checked


def rule_b():
    """POI/fleet joins carry REGION, and their pre-aggregations GROUP BY REGION."""
    violations, checked = [], 0
    for path in VIEW_COPIES:
        src = strip_comments(read(path))
        if not src:
            continue
        name = path.name

        # Joins onto a POI source, whether the physical table or a `poi` CTE.
        pat = r"JOIN\s+(?:SYNTHETIC_DATASETS\.UNIFIED\.(?:V_)?DIM_POIS(?:_CURRENT)?|poi)\s+(\w+)\s+ON\s+([^\n]*)"
        for alias, cond in re.findall(pat, src, flags=re.I):
            checked += 1
            if "LOCATION_ID" not in cond.upper():
                continue  # not an id-keyed POI lookup
            if not re.search(rf"\b{alias}\.REGION\s*=", cond, flags=re.I):
                violations.append(
                    f"{name}: POI join `{alias}` keyed on LOCATION_ID with no {alias}.REGION "
                    f"predicate - 483 LOCATION_IDs span regions, so this fans out rows "
                    f"({cond.strip()[:70]})"
                )

        # Pre-aggregations that collapse a region-scoped dimension.
        for keys in re.findall(r"GROUP\s+BY\s+(LOCATION_ID[^\n]*)", src, flags=re.I):
            checked += 1
            if "REGION" not in keys.upper():
                violations.append(
                    f"{name}: `GROUP BY {keys.strip()}` collapses two regions' copies of a "
                    "place into one arbitrary row"
                )
        for keys in re.findall(r"GROUP\s+BY\s+(VEHICLE_ID[^\n]*)", src, flags=re.I):
            checked += 1
            if "REGION" not in keys.upper():
                violations.append(
                    f"{name}: `GROUP BY {keys.strip()}` discards one of the regions a "
                    "colliding VEHICLE_ID belongs to"
                )
    return violations, checked


def solve_block(src: str) -> str:
    """The solve() body, from the shear setup to the end of the retry loop."""
    start = src.find("const excludedLabels: string[] = []")
    if start < 0:
        return ""
    end = src.find("if (!respObj)", start)
    return src[start:end] if end > start else src[start:]


def rule_c():
    """Graph bbox read from REGION_ORS_MAP and sheared before the ORS probe."""
    violations, checked = [], 0
    helpers = strip_comments(read(HELPERS))
    block = solve_block(strip_comments(read(VIEW)))
    if not helpers or not block:
        return (["solve() block or helpers not found - rule cannot run"], 0)

    checked += 1
    if "REGION_ORS_MAP" not in helpers:
        violations.append(
            "helpers.ts never reads OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP - the graph "
            "bbox is the extent ORS enforces; REGION_REGISTRY's is a camera envelope"
        )

    checked += 1
    if "fetchRegionBbox" not in block or "pointOutsideBbox" not in block:
        violations.append(
            "solve() does not run a bbox pre-flight (fetchRegionBbox + pointOutsideBbox) - "
            "an out-of-bbox point fails the WHOLE ORS request, so nothing downstream can "
            "shear it"
        )
    else:
        # Ordering is the point: a bbox check AFTER the probe cannot stop the
        # probe's batch from throwing 6010 and failing open.
        checked += 1
        if block.find("fetchRegionBbox") > block.find("findUnroutablePoints"):
            violations.append(
                "bbox pre-flight runs AFTER findUnroutablePoints - the probe batch then "
                "still carries the off-graph point and fails open on it"
            )

    checked += 1
    if not re.search(r"bboxRejected\s*>\s*0", block):
        violations.append(
            "the zero-pool branch does not treat a bbox rejection as trustworthy, so it "
            "restores points the graph provably cannot route"
        )
    return violations, checked


def rule_d():
    """The 422 out-of-graph path shears the named points and RETRIES."""
    violations, checked = [], 0
    block = solve_block(strip_comments(read(VIEW)))
    if not block:
        return (["solve() block not found - rule cannot run"], 0)

    checked += 1
    if "outOfGraphPoints" not in block:
        violations.append(
            "the retry loop never reads body.outOfGraphPoints - the 422 already names the "
            "offending coordinates and outOfGraphMessage carries no 'location [lon,lat]', "
            "so the regex path cannot recover it"
        )
        return violations, checked

    # The branch must reach a retry. A version that reads the field, logs it and
    # still breaks satisfies every name-matching rule and ships the same bug.
    # The tail is scoped to the BRANCH, not to the start of `fatal`. It used to
    # run as far as `fatal = body.error`, which swept in the LEGACY code-3 guard
    # (`droppedCoords.includes(badKey)`) further down - so deleting this branch's
    # own no-progress guard left the rule passing off the other path's text.
    # Measured: that mutation survived.
    idx = block.find("outOfGraphPoints")
    stop = block.find("let bad = body.unroutable", idx)
    tail = block[idx:stop] if stop > idx else block[idx:]
    checked += 1
    if not re.search(r"\bcontinue\b", tail):
        violations.append(
            "the outOfGraphPoints branch never reaches `continue` - it must re-solve the "
            "sheared challenge, not fall through to `fatal` on attempt 0"
        )
    checked += 1
    if "droppedCoords.includes" not in tail:
        violations.append(
            "no no-progress guard in the outOfGraphPoints branch - re-sending an identical "
            "challenge would burn the retry cap"
        )
    return violations, checked


def rule_e():
    """findUnroutablePoints convicts an out-of-graph refusal instead of failing open."""
    violations, checked = [], 0
    src = strip_comments(read(HELPERS))
    start = src.find("export async function findUnroutablePoints")
    if start < 0:
        return (["findUnroutablePoints not found - rule cannot run"], 0)
    end = src.find("\nexport ", start + 1)
    body = src[start:end] if end > start else src[start:]

    checked += 1
    if "isOutOfGraph" not in body:
        violations.append(
            "findUnroutablePoints does not classify an out-of-graph throw (isOutOfGraph) - "
            "ORS 6010 fails the whole MATRIX call, so a bare catch keeps every point in the "
            "batch including the one that caused it"
        )
    checked += 1
    if "parseOutOfGraphPoints" not in body:
        violations.append(
            "the named coordinates are never parsed out of the refusal, so the batch is "
            "abandoned with no verdicts"
        )
    checked += 1
    if not re.search(r"bad\.add\(", body):
        violations.append("nothing is convicted - the probe cannot shear anything")
    # Asserted on the BACKOFF CONDITION, not on the identifier appearing
    # somewhere in the function. Removing the exemption from the `if` leaves the
    # counter declared and incremented, so a mention-only rule passes on a
    # version that throws the convictions away. Measured: that survived.
    # Scoped by searching BACKWARDS from publish(true) for the nearest `if (`.
    # A forward `if\s*\((.*?)\)\s*\{\s*publish\(true\)` with re.S matched the
    # FIRST `if (` in the function and swallowed the entire body into group(1),
    # so the rule passed on any text containing the identifier anywhere.
    # Measured: that mutation survived.
    checked += 1
    pi = body.find("publish(true)")
    ci = body.rfind("if (", 0, pi) if pi > 0 else -1
    if pi < 0 or ci < 0:
        violations.append("the >50%-flagged backoff could not be located - rule cannot verify it")
    elif "offGraphConvicted" not in body[ci:pi]:
        violations.append(
            "the backoff condition does not exempt out-of-graph convictions, so coordinates "
            "ORS explicitly refused get discarded as an untrustworthy probe"
        )
    return violations, checked


def rule_f():
    """Every shear reads the CURRENT work sets, not the original vrp* arrays."""
    violations, checked = [], 0
    block = solve_block(strip_comments(read(VIEW)))
    if not block:
        return (["solve() block not found - rule cannot run"], 0)

    # After the work sets are established, re-deriving from vrpVehicles /
    # vrpShipments throws away every earlier exclusion. The ONLY legitimate uses
    # are the initial assignment and the untrustworthy-probe restore.
    for m in re.finditer(r"(vrpVehicles|vrpShipments)\s*\.\s*(filter|map)\b", block):
        checked += 1
        violations.append(
            f"shear/collect re-derives from {m.group(1)} instead of the current work set - "
            "an earlier pass's exclusions are silently restored"
        )

    checked += 1
    # Word-boundary anchored: a plain substring test also matched a RENAMED
    # helper (`const shearByKeysRenamed`), so removing the shared shear left the
    # rule passing. Measured: that mutation survived.
    if not re.search(r"const shearByKeys\b", block) or not re.search(r"\bshearByKeys\(", block):
        violations.append(
            "no single shearByKeys helper called from the exclusion paths - the divergent "
            "copies are what let the bbox pre-flight's exclusions be undone by the ORS probe"
        )
    return violations, checked


def main() -> int:
    results = [
        ("A last_drop keyed on REGION in every copy", *rule_a()),
        ("B POI/fleet joins and rollups carry REGION", *rule_b()),
        ("C bbox pre-flight from REGION_ORS_MAP", *rule_c()),
        ("D 422 out-of-graph shears and retries", *rule_d()),
        ("E probe convicts an out-of-graph refusal", *rule_e()),
        ("F shears read the current work sets", *rule_f()),
    ]

    failed = False
    for label, violations, checked in results:
        if checked == 0:
            print(f"FAILED [{label}]: inspected 0 items - paths are stale, so this rule is vacuous.")
            failed = True
            continue
        if violations:
            failed = True
            print(f"FAILED [{label}]: {len(violations)} violation(s) over {checked} inspected:")
            for v in violations:
                print("  - " + v)
        else:
            print(f"PASSED [{label}]: {checked} inspected, no violations.")

    if failed:
        print(
            "\n  VEHICLE_ID and LOCATION_ID are unique only WITHIN a region: join on\n"
            "  the id alone and a trailer inherits another region's position, which\n"
            "  the road graph then refuses outright. And a stop outside the graph\n"
            "  bbox must be EXCLUDED, never allowed to abort the solve - it fails\n"
            "  the whole ORS request rather than returning a null cell, so it has\n"
            "  to be caught by bbox arithmetic before the engine is called and by\n"
            "  reading the coordinates the 422 already names."
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
