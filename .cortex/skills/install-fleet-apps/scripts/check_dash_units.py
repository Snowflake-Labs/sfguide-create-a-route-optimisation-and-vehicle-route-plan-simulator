#!/usr/bin/env python3
"""A dashed deck.gl path must stay dashed at every zoom level.

WHY THIS GATE EXISTS
--------------------
deck.gl's PathStyleExtension takes `getDashArray` as [dash, gap] RELATIVE TO THE
PATH WIDTH, measured in the layer's width units. Those units default to
`'meters'` (`widthUnits` on PathLayer, `lineWidthUnits` on GeoJsonLayer), so
`getDashArray: [10, 6]` on a layer that never sets them is a 16 METRE period in
world space. At a country-wide zoom (~1 px per km) the whole period is far
sub-pixel and the line rasterises as one solid stroke.

That is what shipped on the Backload Matching map: the empty legs were dashed
when zoomed in, solid grey when zoomed out, and the layer carried
`lineWidthMinPixels: 6` - which clamps the drawn STROKE WIDTH and has no effect
whatsoever on the dash period, so it read like the units were already handled.
Three layers across two apps had the same defect.

So the invariant is not "the dash extension is enabled" but "the dash period is
pinned to SCREEN space". A gate on the extension being present would have passed
for the entire time the bug was live.

Sites are DISCOVERED by scanning, never listed, so a new dashed layer is covered
the day it is written.

RULES
  A  Every dash site pins pixel width units (`widthUnits` / `lineWidthUnits`)
     inside the same layer-config literal that enables the extension. The
     enclosing literal is found by brace matching, not by a line window: a
     nearby unrelated layer that happens to set pixels must not satisfy it.
  B  Every dash site sets `dashJustified`, so the pattern starts at the vertex
     instead of drifting per segment.
  C  Every dash site actually supplies a `getDashArray`; enabling the extension
     without one silently draws solid.
  D  The empty-leg colour and the no-backload baseline colour stay far apart.
     They were 110 vs 150 grey - two lines that are only distinguishable while a
     dash gap is on screen, which is precisely what rule A had to fix.

Run: python3 .cortex/skills/install-fleet-apps/scripts/check_dash_units.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
SKILL = REPO / ".cortex/skills/install-fleet-apps"
CONSTANTS = SKILL / "fleet_sa_app/ui/src/components/views/areas/backload-proposals/constants.ts"

# Trees that can hold deck.gl layer code. Scanned recursively; build output and
# dependencies are skipped so a vendored copy of deck.gl cannot be graded.
ROOTS = (
    SKILL / "fleet_sa_app/ui/src",
    SKILL / "fleet_admin_app/ui/src",
    REPO / "packages/fleet-kit/src",
)
SKIP_PARTS = {"node_modules", "dist", ".next", "build"}

DASH_RE = re.compile(r"PathStyleExtension\(\s*\{[^}]*\bdash\s*:\s*true")
PIXEL_UNITS_RE = re.compile(r"\b(?:line)?[wW]idthUnits\s*:\s*'pixels'")
COLOR_RE = re.compile(
    r"export const (COLOR_LEG_EMPTY|COLOR_LEG_BASELINE)"
    r"[^=]*=\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]"
)
LINE_COMMENT_RE = re.compile(r"//[^\n]*")
BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.S)
DASH_ARRAY_RE = re.compile(r"\bgetDashArray\s*:")

failures: list[str] = []
sites = 0


def fail(rule: str, msg: str) -> None:
    failures.append(f"  [{rule}] {msg}")


def enclosing_literal(src: str, idx: int) -> str | None:
    """The object literal containing `idx`, found by balanced brace matching.

    Walks backwards for the unmatched `{` that opens the literal, then forwards
    to its partner. Deliberately NOT a line window: the point of the gate is
    that the units are set on the SAME layer config that enables the dash, and a
    window would let a neighbouring layer's `widthUnits` satisfy it.
    """
    depth = 0
    start = -1
    for j in range(idx, -1, -1):
        c = src[j]
        if c == "}":
            depth += 1
        elif c == "{":
            if depth == 0:
                start = j
                break
            depth -= 1
    if start < 0:
        return None
    depth = 0
    for j in range(start, len(src)):
        c = src[j]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return src[start : j + 1]
    return None


def strip_comments(src: str) -> str:
    """Comments removed before any rule runs.

    Not cosmetic: rule C false-passed on the very comment this fix added. The
    ResultMap layer explains the units trap in prose that contains the words
    `getDashArray` and `widthUnits`, so deleting the real props left every rule
    satisfied by the documentation of the bug.
    """
    return LINE_COMMENT_RE.sub("", BLOCK_COMMENT_RE.sub("", src))


def source_files() -> list[Path]:
    out: list[Path] = []
    for root in ROOTS:
        if not root.exists():
            continue
        for p in sorted(root.rglob("*.ts*")):
            if p.suffix not in (".ts", ".tsx"):
                continue
            if SKIP_PARTS & set(p.parts):
                continue
            out.append(p)
    return out


def check_dash_sites() -> None:
    global sites
    for path in source_files():
        src = path.read_text(encoding="utf-8")
        for m in DASH_RE.finditer(src):
            sites += 1
            rel = path.relative_to(REPO)
            line = src.count("\n", 0, m.start()) + 1
            block = enclosing_literal(src, m.start())
            if block is None:
                fail("A", f"{rel}:{line} dash extension is not inside an object literal - "
                          "cannot verify its width units")
                continue
            block = strip_comments(block)
            if not PIXEL_UNITS_RE.search(block):
                fail("A", f"{rel}:{line} enables the dash extension without "
                          "widthUnits/lineWidthUnits: 'pixels', so the dash period is in "
                          "METRES and the line renders solid when zoomed out")
            if "dashJustified" not in block:
                fail("B", f"{rel}:{line} enables the dash extension without dashJustified")
            if not DASH_ARRAY_RE.search(block):
                fail("C", f"{rel}:{line} enables the dash extension but supplies no "
                          "getDashArray, so the path draws solid")


def check_colors() -> None:
    if not CONSTANTS.exists():
        fail("D", f"{CONSTANTS.relative_to(REPO)} not found - cannot verify that the empty "
                  "leg is distinguishable from the baseline")
        return
    found = {m.group(1): tuple(int(m.group(i)) for i in (2, 3, 4))
             for m in COLOR_RE.finditer(CONSTANTS.read_text(encoding="utf-8"))}
    for name in ("COLOR_LEG_EMPTY", "COLOR_LEG_BASELINE"):
        if name not in found:
            fail("D", f"{CONSTANTS.relative_to(REPO)} does not export {name} as an RGB "
                      "triple - the two map lines can no longer be compared")
    if len(found) < 2:
        return
    empty, base = found["COLOR_LEG_EMPTY"], found["COLOR_LEG_BASELINE"]
    delta = max(abs(a - b) for a, b in zip(empty, base))
    if delta < 60:
        fail("D", f"COLOR_LEG_EMPTY {empty} and COLOR_LEG_BASELINE {base} differ by only "
                  f"{delta} per channel - on a zoomed-out map, where the dash gaps are "
                  "sparse, the plan's empty leg and the no-backload baseline read as the "
                  "same line")


def main() -> int:
    check_dash_sites()
    check_colors()
    # Vacuity counter: the whole gate is scan-driven, so a broken regex or a
    # moved tree would otherwise report a clean pass having graded nothing.
    if sites < 3:
        print(f"FAILED: dash units gate found only {sites} dash site(s) - expected at "
              "least 3; the scan is passing vacuously")
        return 1
    if failures:
        print("FAILED: dash units gate\n" + "\n".join(failures))
        return 1
    print(f"PASSED: dash units gate ({sites} dash sites inspected)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
