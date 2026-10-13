#!/usr/bin/env python3
"""Fail when a dashboard chart plots two incompatible scales on one axis.

Why this exists
---------------
The labor view's "Weekly Overtime Trend" panel drew two series: an OT premium in
dollars and a count of at-risk drivers. Measured on the deployed data:

    2026-08-02  United States of America   premium 94,542   at-risk 84
    2026-09-06  US Texas                   premium 19,340   at-risk 22
    2026-09-13  San Francisco              premium 17,907   at-risk 33

~880x. The count series rendered as a bar roughly 0.1% of plot height: drawn,
present in the legend, hoverable, and invisible. Nothing errored, no axis was
missing, and the tooltip reported both numbers correctly - which is exactly why
it survived. A chart that is wrong is noticed; a chart that is merely unreadable
reads as "that week had no at-risk drivers".

TWO defects produced it, and either one alone keeps the series invisible:

1. Per-series ``type`` was not honoured. ``hasBar`` is a ``some()``, so the bar
   branch won for ANY config containing a bar and then mapped EVERY series to
   ``<Bar>``. The panel authored ``type: "line"`` and had never once drawn a
   line - the legend swatch was a filled square. A reviewer reading
   app-views.json saw a combo chart; the screen showed two bars.

2. ``yAxis: "right"`` was read only by ``<Line>`` inside the line-ONLY branch.
   The config type declared the field and the SeriesConfig interface carried it,
   so authoring it looked supported and did nothing. No view in app-views.json
   authored it, so the feature had never executed.

What it checks
--------------
1. RULE A - the renderer imports ComposedChart and RENDERS it. An import alone
   satisfies a substring check while the branch is gone.
2. RULE B - the combo branch is evaluated BEFORE the ``hasBar`` branch. This is
   the whole fix: ``hasBar`` returns for any config containing a bar, so a combo
   branch placed after it is dead code that still satisfies RULE A. Asserted on
   source offsets, because moving a block is invisible to every other check.
3. RULE C - every mark type in the combo branch carries ``yAxisId``. Recharts
   drops a series whose yAxisId matches no mounted axis, so omitting it on the
   left-axis marks empties the plot instead of raising. It is a one-word
   omission per mark and only bites the configs that use a second axis.
4. RULE D - no authored chart area puts a currency-scaled field and a count
   field on the SAME axis. This is the rule that catches the NEXT panel rather
   than the two already fixed, which is the actual recurrence risk: the same
   clash shipped twice (trend as bar+line, "Overtime Premium by Depot Team" as
   bar+bar) and neither was caught by anything.
5. RULE E - vacuity. Reports how many areas RULE D inspected and how many
   matched the money+count shape, and fails if either is zero. A `REPO =
   parents[N]` that is one directory short makes a gate in this repo inspect
   zero files and pass, twice now; and a RULE D whose field patterns stop
   matching anything is a rule that has been silently switched off.

Run with no arguments; exits non-zero naming the rule and the file.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

SKILL = pathlib.Path(__file__).resolve().parent.parent
UI = SKILL / "fleet_sa_app" / "ui" / "src"
CHART = UI / "components" / "views" / "areas" / "view-chart.tsx"
APP_VIEWS = SKILL / "fleet_sa_app" / "app" / "app-views.json"

# Field-name shapes for the two unit families that cannot share an axis. Money
# is bounded by scale (thousands) and counts by headcount (tens), so any pair of
# these on one axis flattens the smaller one.
MONEY = re.compile(r"premium|cost|usd|revenue|margin|price|spend|dollar|_amt\b|amount", re.I)
COUNT = re.compile(r"operators|drivers|count|vehicles|assets|headcount|_num\b|breaches", re.I)

MARKS = ("Bar", "Line", "Area")


def strip_comments(src: str) -> str:
    """Source with `//` lines and `/* */` blocks removed.

    Mandatory here, not cosmetic. The combo branch this gate guards carries a
    comment block that names `ComposedChart`, `yAxisId`, `yAxis` and `hasBar` -
    every token the rules below assert on. check_chart_rendering.py was burned
    by exactly this three separate times: a rule matching the sentence that
    DESCRIBES the defect rather than the code avoiding it.
    """
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    # JSX `{/* ... */}` comments survive the above only when nested oddly; the
    # line filter below catches the common single-line form.
    return "\n".join(
        l for l in src.split("\n")
        if not l.lstrip().startswith("//") and not l.lstrip().startswith("{/*")
    )


def main() -> int:
    problems: list[str] = []

    if not CHART.exists():
        print(f"FAIL: {CHART} is missing")
        return 1
    code = strip_comments(CHART.read_text())

    # ---- RULE A: ComposedChart imported AND rendered ----
    if not re.search(r"\bComposedChart\b", code):
        problems.append(
            "RULE A: view-chart.tsx does not reference ComposedChart. recharts "
            "cannot mix a bar and a line in any other chart container, so without "
            "it an authored `type: \"line\"` beside a bar is silently drawn as a "
            "second bar.")
    elif not re.search(r"<ComposedChart\b", code):
        problems.append(
            "RULE A: ComposedChart is imported but never rendered as an element. "
            "The import satisfies a grep while the branch that uses it is gone.")

    # ---- RULE B: the combo branch precedes the bar branch ----
    combo = re.search(r"if\s*\(\s*isCombo\s*\)\s*\{", code)
    bar = re.search(r"if\s*\(\s*hasBar\s*\)\s*\{", code)
    if not combo:
        problems.append(
            "RULE B: view-chart.tsx has no `if (isCombo)` branch. Per-series type "
            "and the second axis are honoured nowhere else.")
    elif not bar:
        problems.append(
            "RULE B: view-chart.tsx has no `if (hasBar)` branch, so the branch "
            "ordering this rule exists to pin cannot be verified.")
    elif combo.start() > bar.start():
        problems.append(
            "RULE B: the combo branch is placed AFTER the `hasBar` branch, so it "
            "is dead code for every chart containing a bar - which is every chart "
            "this fix exists for. `hasBar` is a some(): it returns first and maps "
            "EVERY series to <Bar>. Moving the block back up is the entire fix; "
            "nothing else in this gate, or in tsc, can see it.")

    # ---- RULE C: every mark in the combo branch carries yAxisId ----
    if combo and bar and combo.start() < bar.start():
        body = code[combo.start():bar.start()]
        if not re.search(r"yAxisId\s*=", body):
            problems.append(
                "RULE C: no mark in the combo branch sets yAxisId. With two axes "
                "mounted, recharts renders a series against no axis at all.")
        for mark in MARKS:
            for el in re.finditer(r"<" + mark + r"\b(.*?)/>", body, re.S):
                if "yAxisId" not in el.group(1):
                    problems.append(
                        f"RULE C: a <{mark}> in the combo branch has no yAxisId. "
                        f"recharts DROPS a series whose yAxisId matches no mounted "
                        f"axis, so the mark vanishes silently - the same invisible "
                        f"series this gate exists to prevent, reintroduced by a "
                        f"one-word omission.")
                    break
        # A mark's axis must be DERIVED FROM the series' own `yAxis` field, and
        # the assertion has to be anchored to the MARK.
        #
        # Two earlier drafts of this clause passed a mutation that pinned every
        # mark to the left axis. The first matched `yAxisId="right"`, which is the
        # mounted <YAxis> - an axis with nothing plotted on it. The second matched
        # `s.yAxis === 'right' ? 'right'` anywhere in the branch, which is also
        # how the axis LABEL helper decides which series own an axis. Mounting an
        # axis and labelling it are not routing a series to it.
        #
        # So: read the value each mark passes to yAxisId, resolve it through its
        # local declaration if it is an identifier, and require `s.yAxis` to be
        # what determines it.
        for mark in MARKS:
            for el in re.finditer(r"<" + mark + r"\b(.*?)/>", body, re.S):
                attr = re.search(r"yAxisId=\{([^}]*)\}", el.group(1))
                if not attr:
                    continue
                expr = attr.group(1).strip()
                if "s.yAxis" in expr:
                    continue
                if re.fullmatch(r"[A-Za-z_$][\w$]*", expr):
                    decl = re.search(
                        r"\b(?:const|let|var)\s+" + re.escape(expr) + r"\s*=\s*([^;]*);", body)
                    if decl and "s.yAxis" in decl.group(1):
                        continue
                    problems.append(
                        f"RULE C: the <{mark}> in the combo branch takes its yAxisId "
                        f"from `{expr}`, which is not derived from the series' own "
                        f"`yAxis` field. The authored `yAxis: \"right\"` then reaches "
                        f"no series: the right axis is still MOUNTED and drawn with "
                        f"tick labels while every mark sits on the left one. That "
                        f"looks like a working dual-axis chart and is the original "
                        f"invisible-series defect with an extra axis painted on.")
                    break
                problems.append(
                    f"RULE C: the <{mark}> in the combo branch computes yAxisId from "
                    f"an expression that never reads `s.yAxis`, so the authored "
                    f"second axis cannot reach it.")
                break

    # ---- RULE D: no authored area mixes money and count on one axis ----
    inspected = 0
    matched = 0
    try:
        views = json.loads(APP_VIEWS.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        problems.append(f"RULE D: cannot read {APP_VIEWS.name} ({exc})")
        views = {}

    for view_key, view in views.items():
        if not isinstance(view, dict):
            continue
        for area_key, area in (view.get("areas") or {}).items():
            if not isinstance(area, dict):
                continue
            cfg = area.get("config") or {}
            series = cfg.get("series") or []
            if len(series) < 2:
                continue
            # A grouped chart derives one value column per category from a SINGLE
            # series, so there are no two authored fields to separate.
            if any(s.get("groupBy") for s in series):
                continue
            inspected += 1
            money = [s for s in series if MONEY.search(str(s.get("field", "")))]
            counts = [s for s in series if COUNT.search(str(s.get("field", "")))]
            if not money or not counts:
                continue
            matched += 1
            left = [s for s in (money + counts) if s.get("yAxis") != "right"]
            # Both families on the default axis is the defect. One of them must be
            # moved to the right axis; which one is an authoring choice.
            if len(left) == len(money) + len(counts):
                problems.append(
                    f"RULE D: {view_key}/{area_key} plots a currency field "
                    f"({', '.join(str(s.get('field')) for s in money)}) and a count "
                    f"field ({', '.join(str(s.get('field')) for s in counts)}) on the "
                    f"same y axis. Measured on this data the ratio is ~880x, so the "
                    f"count draws at 0.1% of plot height - visible in the legend and "
                    f"the tooltip, invisible in the plot. Put the count on "
                    f"`\"yAxis\": \"right\"`.")

    # ---- RULE E: vacuity ----
    if inspected == 0:
        problems.append(
            f"RULE E: RULE D inspected ZERO multi-series areas in {APP_VIEWS}. "
            f"Either the path is wrong or the config shape moved; either way the "
            f"rule is switched off while still reporting success.")
    elif matched == 0:
        problems.append(
            "RULE E: RULE D matched no money+count area. Two are known to exist "
            "(labor_overtime/trend and labor_overtime/team), so the MONEY/COUNT "
            "field patterns have stopped matching the authored field names and the "
            "rule now guards nothing.")

    if problems:
        print("FAIL: a dashboard chart can plot two scales on one axis:")
        for p in problems:
            print(f"  - {p}")
        return 1
    print(f"OK: ComposedChart honours per-series type and yAxis before the bar "
          f"branch, every mark carries yAxisId, and {matched} of {inspected} "
          f"multi-series areas separate money from counts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
