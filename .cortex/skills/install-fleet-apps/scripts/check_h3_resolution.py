#!/usr/bin/env python3
"""Fail when a semantic view exposes an H3 cell without saying what it can do.

Why this exists
---------------
Asked "show me dwell density in the SF" the agent drew a resolution-7 hexmap.
Asked "use resolution 9" it could not, and spent four minutes finding that out.

Nothing was broken. The renderer is resolution-agnostic (deck.gl derives hex
geometry from the index; `cellToBoundary` is valid res 0-15), and Snowflake has
the functions. The defect was that `SV_DWELL_ANALYTICS` published `H3_CELL_R7` and
no point to re-bin from, so the ONLY way to reach another resolution was `run_sql`
- an MCP verb, whose result CoWork's `data_to_map` rejects. A pre-binned column
with no stated resolution and no re-bin path is a map that can only ever be drawn
one way, and nothing says so.

Two failure shapes, both silent:

1. The agent cannot answer, and blames the wrong thing. It invented three
   Snowflake functions that do not exist (`H3_CELL_TO_BOUNDARY_WKT`,
   `H3_CELL_TO_GEOGRAPHY`, `H3_CELL_TO_CHILDREN`) before giving up.

2. FAR WORSE - the agent fabricates. Household density is stored at resolution 8
   and keeps no sub-cell position, so a finer map is impossible. The transcript
   shows the agent composing `SUM(total_dwell_minutes / 49.0)` to spread a cell's
   measure over its 49 children. That renders a detailed, plausible, entirely
   invented map. Nothing errors.

So a view carrying an H3 cell must state three things, and this gate asserts them.
Prose in a SQL string literal that several workstreams edit, where deleting a
sentence breaks no build and fails no test - the same argument as
check_map_guidance.py, which this file sits beside.

What it checks (per semantic view exposing an H3 dimension)
----------------------------------------------------------
RULE A  The STORED resolution is stated as a number. `SV_LOCATION` documented its
        resolution NOWHERE - not in the dimension comment, not in the prose - so
        an agent could not report the grain of its own answer, never mind change
        it. "resolution 8" is checked near the H3 dimension, not merely somewhere
        in the file.

RULE B  The view declares which DIRECTION it can be re-binned, and backs it:
          * re-binnable both ways -> must expose a lat/lon (or point) pair on the
            SAME table, and name the function that uses it.
          * coarsen-only -> must say so, and name H3_CELL_TO_PARENT.
        A view claiming arbitrary resolution with no point is the original defect
        restated; a coarsen-only view that stays silent invites shape 2.

RULE C  A coarsen-only view must FORBID sub-dividing a cell's measure. Naming the
        limit is not enough: "resolution 8 is the finest stored" reads as a fact
        about storage, not as a prohibition, and the agent's own reasoning treated
        even distribution as a reasonable approximation of missing data.

RULE D  Only functions that EXIST may be prescribed. Prescribing
        `H3_CELL_TO_CHILDREN` and friends sends the agent down the exact dead end
        it already found on its own. Naming them as non-existent is fine and is
        distinguished from prescribing them.

Read-only. Run with no arguments. Exits non-zero naming the view and what is missing.
"""

from __future__ import annotations

import pathlib
import re
import sys

APP_DIR = pathlib.Path(__file__).resolve().parent.parent / "fleet_sa_app" / "app"
SV_FILES = ["semantic_views.sql", "semantic_views_emergency.sql"]

# An H3 dimension is a dimension whose OUTPUT name or source column is an H3 cell.
H3_DIM_RE = re.compile(r"^\s*,?\s*(\w+)\.(\w*(?:h3|cell_h3)\w*)\s+AS\s+(\w+)", re.IGNORECASE)

# A point pair on the same table makes arbitrary re-binning possible.
POINT_DIM_RE = re.compile(r"^\s*,?\s*(\w+)\.(\w*_lat|\w*lat|\w*_lon|\w*lon)\s+AS\s+(\w+)",
                          re.IGNORECASE)

# Functions that exist in Snowflake, measured on tib85385.
REAL_FNS = ["h3_latlng_to_cell_string", "h3_point_to_cell_string",
            "h3_cell_to_parent", "h3_get_resolution"]
# Functions the agent invented. Prescribing one is a defect; calling it absent is not.
FAKE_FNS = ["h3_cell_to_children", "h3_cell_to_geography", "h3_cell_to_boundary_wkt"]

STORED_RES_RE = re.compile(r"stored\s+at\s+resolution\s+(\d+)", re.IGNORECASE)
COARSEN_ONLY_RE = re.compile(r"coarsen[\s-]only|coarser\s+only", re.IGNORECASE)
# The prohibition, not the fact. Must forbid the ACT of dividing a measure.
NO_SUBDIVIDE_RE = re.compile(
    r"never\s+divide|do\s+not\s+divide|never\s+split|must\s+not\s+divide", re.IGNORECASE
)
# "does NOT exist" style framing that makes naming a fake function legitimate.
ABSENT_FRAMING_RE = re.compile(r"do(?:es)?\s+NOT\s+exist", re.IGNORECASE)


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").lower()


def split_semantic_views(sql: str) -> list[tuple[str, str]]:
    """(view_name, body) pairs, body ending at the statement's terminating `;`.

    Same boundary as check_map_guidance.py and for the same measured reason: the
    file documents each view in a `--` block ABOVE its CREATE, so a next-CREATE
    boundary attributes those comments to the PREVIOUS view.
    """
    starts = [
        (m.start(), m.group(1))
        for m in re.finditer(
            r"CREATE\s+OR\s+REPLACE\s+SEMANTIC\s+VIEW\s+[\w.]*?([A-Z_0-9]+)\s", sql
        )
    ]
    out: list[tuple[str, str]] = []
    for i, (pos, name) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(sql)
        body = sql[pos:end]
        term = re.search(r"\n;\s*$|\n;\n", body)
        if term:
            body = body[: term.end()]
        out.append((name, body))
    return out


def dimensions_block(body: str) -> str:
    m = re.search(r"\bDIMENSIONS\s*\((.*?)\n\s*\)\s*\n", body, re.DOTALL | re.IGNORECASE)
    return m.group(1) if m else ""


def main() -> int:
    problems: list[str] = []
    h3_views: list[str] = []
    views_scanned = 0

    for fname in SV_FILES:
        path = APP_DIR / fname
        if not path.exists():
            problems.append(f"{fname}: expected semantic-view file is missing")
            continue
        sql = path.read_text()
        for name, body in split_semantic_views(sql):
            views_scanned += 1
            dims = dimensions_block(body)
            if not dims:
                continue

            h3_dims = [m for m in (H3_DIM_RE.match(ln) for ln in dims.split("\n")) if m]
            if not h3_dims:
                continue
            h3_views.append(name)
            nbody = norm(body)

            # --- RULE A: state the stored resolution -------------------------
            if not STORED_RES_RE.search(body):
                problems.append(
                    f"{fname} {name}: exposes an H3 cell "
                    f"({h3_dims[0].group(3)}) but never states the STORED resolution "
                    f"as 'stored at resolution N'. An agent cannot report the grain of "
                    f"its own map, and cannot tell whether a request for another "
                    f"resolution is answerable."
                )

            # --- RULE B: declare the direction, and back it ------------------
            h3_tables = {m.group(1).lower() for m in h3_dims}
            point_tables = {
                m.group(1).lower()
                for m in (POINT_DIM_RE.match(ln) for ln in dims.split("\n"))
                if m
            }
            has_point = bool(h3_tables & point_tables)
            coarsen_only = bool(COARSEN_ONLY_RE.search(body))

            if coarsen_only:
                if "h3_cell_to_parent" not in nbody:
                    problems.append(
                        f"{fname} {name}: declares itself coarsen-only but never names "
                        f"H3_CELL_TO_PARENT, so it states a limit without giving the "
                        f"one operation that IS allowed."
                    )
                # --- RULE C: forbid the fabrication --------------------------
                if not NO_SUBDIVIDE_RE.search(body):
                    problems.append(
                        f"{fname} {name}: is coarsen-only but never FORBIDS dividing a "
                        f"cell's measure among child cells. Stating the stored grain is "
                        f"not a prohibition - the agent read a missing finer grain as "
                        f"something to approximate, and composed SUM(measure / 49.0), "
                        f"which draws a detailed invented map with no error."
                    )
            elif has_point:
                # The function must be APPLIED TO THE EXPOSED COLUMNS, not merely
                # named. First draft accepted a mention, and M3 of the negative
                # suite false-passed on it: the prose lists the four functions that
                # exist, so deleting the one actually prescribed still left a
                # match. A list of function names is a glossary, not an instruction.
                point_names = sorted(
                    m.group(3).lower()
                    for m in (POINT_DIM_RE.match(ln) for ln in dims.split("\n"))
                    if m and m.group(1).lower() in h3_tables
                )
                called = any(
                    re.search(
                        r"h3_(?:latlng|point)_to_cell_string\s*\([^)]*" + re.escape(pn),
                        nbody,
                    )
                    for pn in point_names
                )
                if not called:
                    problems.append(
                        f"{fname} {name}: exposes an H3 cell AND a point "
                        f"({', '.join(point_names) or 'lat/lon'}) on the same table, "
                        f"but names no re-bin function CALLED ON those columns. "
                        f"Listing H3_LATLNG_TO_CELL_STRING among functions that exist "
                        f"is a glossary; the prose has to show the call, or arbitrary "
                        f"resolution stays possible and undocumented."
                    )
            else:
                problems.append(
                    f"{fname} {name}: exposes an H3 cell ({h3_dims[0].group(3)}) with "
                    f"NO point dimension on table '{sorted(h3_tables)[0]}' and no "
                    f"coarsen-only declaration. That is the original defect: the only "
                    f"route to another resolution is run_sql, and CoWork's data_to_map "
                    f"rejects an MCP result, so 'use resolution N' is unanswerable. "
                    f"Either expose a lat/lon pair or declare the view coarsen-only."
                )

            # --- RULE D: do not prescribe functions that do not exist -------
            for fake in FAKE_FNS:
                if fake not in nbody:
                    continue
                # Legitimate only when framed as absent, in the same sentence.
                idx = nbody.find(fake)
                window = nbody[max(0, idx - 200): idx + 200]
                if not ABSENT_FRAMING_RE.search(window):
                    problems.append(
                        f"{fname} {name}: prescribes {fake.upper()}, which does not "
                        f"exist in Snowflake. That is the dead end the agent already "
                        f"found by itself; name it as absent or drop it."
                    )

    print("H3 resolution gate (a stored cell must say what it can become)\n")
    print(f"  semantic views scanned        {views_scanned}")
    print(f"  views exposing an H3 cell     {len(h3_views)}"
          f"{' (' + ', '.join(h3_views) + ')' if h3_views else ''}")
    print()

    if not h3_views:
        print("FAIL: no semantic view with an H3 dimension was found. Every rule here "
              "is scoped to those views, so this run checked NOTHING - which passes "
              "silently unless it is treated as a failure.")
        return 1

    if problems:
        print(f"FAIL: H3 resolution guidance is incomplete in {len(problems)} place(s):")
        for p in problems:
            print(f"  - {p}")
        return 1

    print(f"PASSED: all {len(h3_views)} H3 view(s) state a stored resolution, declare "
          f"which direction they re-bin, and name only functions that exist")
    return 0


if __name__ == "__main__":
    sys.exit(main())
