#!/usr/bin/env python3
"""
check_number_formatting.py - a number a user reads must not carry more decimals
than the display policy allows, at either layer that can produce them.

WHY THIS IS A GATE

The defect it guards is silent and arrives from two directions at once.

Direction 1, SQL. A row-level view rounds to 2dp and casts back to FLOAT. 2dp is
not exactly representable in binary, so a SUM over a few hundred rows accumulates
the error and a semantic-view metric returns 21289.670000000002. Nothing fails:
the query is correct, the total is right to the cent, and the extra digits are an
artifact of the type. The app's own declarative views already wrapped the same
sums in ROUND, so only the Analyst / SV_* path was ugly - which is exactly the
kind of asymmetry nobody notices until a customer screenshots it.

Direction 2, display. Every render site used to stringify rows verbatim
(`String(row[col.key])`). That means SQL discipline alone cannot fix this: a
verb result, an agent-invented column, or any future unrounded view prints
whatever it is handed. And formatting alone cannot fix it either, because the
agent's PROSE never passes through a React component. Both layers, or neither.

FOUR RULES

  A. Render sites listed in FORMATTED_SITES must route cell values through the
     shared formatter. Keyed on the FILE, with the banned pattern named, because
     the failure is a value that renders fine and reads wrong.
  B. Every SV_* METRIC whose expression aggregates or does arithmetic must be
     wrapped in ROUND(). COUNT/COUNT_IF are exempt: integral by construction.
  C. Both apps' format-number.ts must exist and must still contain the 2dp cap
     AND the coordinate exemption. Asserting that the exemption is PRESENT BY
     NAME is deliberate - a mutation that widens the cap or drops the exemption
     leaves every other rule passing.
  D. Vacuity counters. Each rule reports how many sites/metrics/constants it
     actually inspected and fails on zero. A gate whose paths have gone stale
     passes by inspecting nothing, which is worse than no gate: it reports a
     property it never checked.
"""

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
SKILL = REPO / ".cortex/skills/install-fleet-apps"
SA_UI = SKILL / "fleet_sa_app/ui/src"
ADMIN_UI = SKILL / "fleet_admin_app/ui/src"

FORMAT_MODULES = [
    SA_UI / "lib/format-number.ts",
    ADMIN_UI / "lib/format-number.ts",
]

# Files that render query values into cells, tooltips or tiles, each with the
# reason it is here. A raw stringify in one of these is the defect.
FORMATTED_SITES = {
    SA_UI / "components/inline/data-table.tsx":
        "chat tool_result grid - the surface the original report came from",
    SA_UI / "components/inline/stat-card.tsx":
        "agent-supplied KPI tile",
    SA_UI / "components/inline/render-map-inline.tsx":
        "render_map tooltip - the agent's map, drawn inside a chat answer",
    SA_UI / "components/views/areas/view-table.tsx":
        "view table cells",
    SA_UI / "components/views/areas/view-clickable-table.tsx":
        "clickable table cells + its agent memo",
    SA_UI / "components/views/areas/view-map.tsx":
        "deck.gl tooltip {COLUMN} substitution",
    SA_UI / "components/views/areas/view-chart.tsx":
        "recharts axis ticks and tooltip values",
    SA_UI / "components/views/areas/metric-cards.tsx":
        "KPI tiles, which also publish to the agent memo",
    SA_UI / "components/views/areas/detail-sections.tsx":
        "detail rows and the drawer's related tables",
    SA_UI / "components/views/areas/view-combo-box.tsx":
        "dropdown option TEXT (the value attribute stays raw - it binds queries)",
    SA_UI / "components/views/areas/view-filter-bar.tsx":
        "filter option TEXT (the value attribute stays raw - it binds queries)",
    ADMIN_UI / "components/shared/DataTable.tsx":
        "admin generic grid",
    ADMIN_UI / "components/shared/MetricCard.tsx":
        "admin KPI tile",
}

# Reviewed and found to render NO numeric row value, so they need no formatter -
# but "reviewed" is a claim with a shelf life. Each entry records the exact
# properties the component reads; reading anything else fails, because that is how
# a numeric field gets added to a surface nobody re-checks. Keyed on the same
# default-deny principle as check_view_tokens.py's INTERPOLATED_PATHS.
STRING_ONLY_SITES = {
    SA_UI / "components/inline/route-map-inline.tsx": (
        "routing-geometry tooltip: Overture place/address strings only",
        {"name", "category", "city", "postcode"},
    ),
}
PROPS_READ = re.compile(r"\bprops\.([A-Za-z_$][\w$]*)")
# Scoped to the getTooltip callback: a React component's own `props.height` is not
# a feature property, and conflating the two made this check report three
# false positives on its first run.
TOOLTIP_BODY = re.compile(r"getTooltip\s*=\s*useCallback\((.*?)\n  \}", re.S)

# A cell rendered straight out of a row object. Matches `{String(row[...]` and
# `{row[...]}` / `{item.value}`-style bare interpolation of a row value.
#
# The negative lookbehind on `=` is load-bearing: `value={String(row[valueField])}`
# is a JSX ATTRIBUTE, and in ComboBox / FilterBar that attribute is written into
# viewState and bound into dependent queries. Formatting it would change the
# filter rather than its presentation, so only the option TEXT is in scope. This
# is the same default-deny-by-path lesson as `label` being a column in ComboBox
# and display text in MetricCards.
RAW_CELL = re.compile(
    r"(?<![=])\{\s*String\(\s*(?:row|r|item|object)\b[^)]*\)"
    r"|(?<![=])\{\s*(?:row|r)\[[^\]]+\]\s*(?:\?\?[^}]*)?\}"
)
FORMATTER_CALL = re.compile(r"\b(formatCellValue|formatNumber|formatCell|fmtValue|formatValue)\s*\(")

# Semantic-view metric line: `qualifier.metric_name AS <expr>`, optionally with a
# leading comma and a trailing WITH SYNONYMS / COMMENT clause on the same line.
METRIC_LINE = re.compile(r"^(\s*,?\s*)([A-Za-z_0-9]+\.[A-Za-z_0-9]+) AS (.+)$")
METRIC_TAIL = re.compile(r"\s+(WITH\s+SYNONYMS|COMMENT\s*=)", re.I)
INTEGRAL_AGG = re.compile(r"^(COUNT|COUNT_IF)\s*\(", re.I)
NEEDS_ROUND = re.compile(r"\b(SUM|AVG|MIN|MAX|MEDIAN|STDDEV|VARIANCE|DIV0|PERCENTILE_CONT)\s*\(", re.I)

# ── Derived cross-check (rule E) ─────────────────────────────────────────────
# FORMATTED_SITES is maintained by hand, and a hand list is exactly how the
# render_map tooltip in components/inline/render-map-inline.tsx shipped with a
# verbatim copy of the view-map defect: the gate written for that class did not
# list the file, so it inspected 10 sites and reported no violations. Two more
# (view-combo-box, view-filter-bar) were missing for the same reason.
#
# The signal is deliberately narrow: a component that pulls a value out of a row
# or picked feature BY DYNAMIC KEY *and* emits it unformatted into rendered output
# or a tooltip string. A file that reads rows and hands them to a child does not
# match, which is why this is not just a second copy of rule A - it answers "is
# any un-listed component emitting a raw row value?", and the answer must be no.
COMPONENT_ROOTS = [
    (SA_UI / "components/inline", "inline (chat) components"),
    (SA_UI / "components/views/areas", "view area components"),
]
DYNAMIC_ROW_READ = re.compile(r"\b(?:row|r|item|object|props|feature|rec)\s*\[\s*[A-Za-z_$][\w.$]*\s*\]")
RAW_EMIT = re.compile(
    r"escapeHtml\(\s*(?:v|value|val)\b"
    r"|\{\s*String\(\s*(?:row|r|item|object|props|feature|rec)\b"
    r"|\{\s*(?:row|r|item|object|props|feature|rec)\["
)


def semantic_view_files() -> list[Path]:
    """Every file that can CREATE a semantic view, wherever it lives."""
    found = []
    for pattern in ("**/*.sql",):
        for p in list(REPO.glob(pattern)):
            if "node_modules" in p.parts or ".next" in p.parts:
                continue
            try:
                text = p.read_text()
            except (UnicodeDecodeError, OSError):
                continue
            if "SEMANTIC VIEW" in text and "METRICS" in text:
                found.append(p)
    return sorted(found)


def rule_a() -> tuple[list[str], int]:
    """Render sites must use the shared formatter and no raw row stringify."""
    violations, checked = [], 0
    for path, why in FORMATTED_SITES.items():
        rel = path.relative_to(REPO)
        if not path.exists():
            violations.append(f"{rel}: listed render site is missing ({why})")
            continue
        checked += 1
        text = path.read_text()
        if not FORMATTER_CALL.search(text):
            violations.append(
                f"{rel}: no shared formatter call ({why}). Import from "
                f"lib/format-number and format the value."
            )
        for i, line in enumerate(text.split("\n"), 1):
            if line.lstrip().startswith("//"):
                continue
            m = RAW_CELL.search(line)
            if m:
                violations.append(
                    f"{rel}:{i}: raw row value rendered - {m.group(0).strip()} ({why})"
                )

    # Reviewed string-only sites: assert the review still holds by pinning the
    # properties the component reads. A new numeric property is the way this class
    # of defect re-enters a file nobody looks at twice.
    for path, (why, allowed) in STRING_ONLY_SITES.items():
        rel = path.relative_to(REPO)
        if not path.exists():
            violations.append(f"{rel}: reviewed string-only site is missing ({why})")
            continue
        checked += 1
        text = path.read_text()
        # Only the tooltip body reads FEATURE properties; the component's own
        # React props are a different namespace that happens to share the name.
        body = TOOLTIP_BODY.search(text)
        if not body:
            violations.append(
                f"{rel}: no getTooltip callback found - the string-only review "
                f"cannot be verified ({why})"
            )
            continue
        read = {m.group(1) for m in PROPS_READ.finditer(body.group(1))}
        extra = sorted(read - allowed)
        if extra:
            violations.append(
                f"{rel}: reads propert{'y' if len(extra) == 1 else 'ies'} "
                f"{', '.join(extra)} not covered by the string-only review ({why}). "
                f"If any can be numeric, format it and move this file to FORMATTED_SITES."
            )
    return violations, checked


def rule_b() -> tuple[list[str], int]:
    """Aggregate METRIC expressions must be wrapped in ROUND()."""
    violations, checked = [], 0
    for path in semantic_view_files():
        rel = path.relative_to(REPO)
        in_metrics = False
        for i, line in enumerate(path.read_text().split("\n"), 1):
            stripped = line.strip()
            if re.match(r"^METRICS\s*\(", stripped):
                in_metrics = True
                continue
            if in_metrics and stripped == ")":
                in_metrics = False
                continue
            if not in_metrics:
                continue
            m = METRIC_LINE.match(line)
            if not m:
                continue
            name, rest = m.group(2), m.group(3)
            tail = METRIC_TAIL.search(rest)
            expr = (rest[: tail.start()] if tail else rest).strip()
            if INTEGRAL_AGG.match(expr):
                continue
            if not NEEDS_ROUND.search(expr):
                continue
            checked += 1
            if not expr.upper().startswith("ROUND("):
                violations.append(
                    f"{rel}:{i}: metric {name} aggregates a FLOAT with no ROUND - {expr}"
                )
    return violations, checked


def rule_c() -> tuple[list[str], int]:
    """The policy constants and the coordinate exemption must both survive."""
    violations, checked = [], 0
    required = {
        "MAX_DECIMALS = 2": "the 2-decimal cap itself",
        "COORD_DECIMALS = 5": "the coordinate exemption's precision",
        "isCoordinateColumn": "the coordinate exemption's predicate",
        "SMALL_MAGNITUDE_DECIMALS": "the sub-1 magnitude exemption",
        "isIdentifierColumn": "the identifier/date-part grouping exemption's predicate",
        "useGroupingFor": "the grouping decision that applies that exemption",
    }
    for path in FORMAT_MODULES:
        rel = path.relative_to(REPO)
        if not path.exists():
            violations.append(f"{rel}: shared formatter module is missing")
            continue
        text = path.read_text()
        for needle, why in required.items():
            checked += 1
            if needle not in text:
                violations.append(f"{rel}: lost `{needle}` - {why}")
        # The exemption must be REACHABLE from the decimal decision, not merely
        # defined: an unused predicate is the same as no predicate.
        decimals_fn = re.search(r"export function decimalsFor\([^)]*\)[^{]*\{(.*?)\n\}", text, re.S)
        checked += 1
        if not decimals_fn:
            violations.append(f"{rel}: decimalsFor() not found - cannot verify the cap is applied")
        elif "isCoordinateColumn" not in decimals_fn.group(1):
            violations.append(
                f"{rel}: decimalsFor() no longer consults isCoordinateColumn - "
                f"coordinates would be truncated to {required and '2dp'}"
            )

        # Same reachability requirement for the grouping exemption, and for the
        # same reason: `YEAR 2026` rendered as "2,026" while every constant above
        # was present and correct, because nothing consulted the predicate.
        grouping_fn = re.search(r"export function useGroupingFor\([^)]*\)[^{]*\{(.*?)\n\}", text, re.S)
        checked += 1
        if not grouping_fn:
            violations.append(
                f"{rel}: useGroupingFor() not found - cannot verify the identifier "
                f"exemption is applied"
            )
        elif "isIdentifierColumn" not in grouping_fn.group(1):
            violations.append(
                f"{rel}: useGroupingFor() no longer consults isIdentifierColumn - "
                f"a year or a postcode would render with a thousands separator"
            )

        # And formatNumber must route its grouping THROUGH that decision rather
        # than taking the caller's flag straight to toLocaleString.
        checked += 1
        if "useGroupingFor(value, column" not in text:
            violations.append(
                f"{rel}: formatNumber() does not pass its grouping flag through "
                f"useGroupingFor(), so the identifier exemption is bypassed"
            )
    return violations, checked


def rule_e() -> tuple[list[str], int]:
    """No UN-LISTED component may emit a row/feature value unformatted."""
    violations, checked = [], 0
    known = set(FORMATTED_SITES) | set(STRING_ONLY_SITES)
    for root, label in COMPONENT_ROOTS:
        if not root.is_dir():
            violations.append(f"{root.relative_to(REPO)}: component root missing ({label})")
            continue
        for path in sorted(root.rglob("*.tsx")):
            checked += 1
            text = path.read_text()
            # Comments are stripped first: this gate's own explanations and the
            # in-file notes about the defect name the very patterns it bans.
            code = "\n".join(
                l for l in text.split("\n") if not l.lstrip().startswith(("//", "*", "/*"))
            )
            if not (DYNAMIC_ROW_READ.search(code) and RAW_EMIT.search(code)):
                continue
            if path in known:
                continue
            m = RAW_EMIT.search(code)
            violations.append(
                f"{path.relative_to(REPO)}: emits a row/feature value unformatted "
                f"({m.group(0).strip()}) and is in neither FORMATTED_SITES nor "
                f"STRING_ONLY_SITES ({label})"
            )
    return violations, checked


def main() -> int:
    results = [
        ("A render sites", *rule_a()),
        ("B semantic metrics", *rule_b()),
        ("C policy constants", *rule_c()),
        ("E unlisted emitters", *rule_e()),
    ]

    failed = False
    for label, violations, checked in results:
        # Rule D: a rule that inspected nothing has proved nothing.
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
            "\n  Fix by routing the value through lib/format-number (display) or by\n"
            "  wrapping the metric in ROUND(expr, 2) - 4 for ratios and unit rates.\n"
            "  Do not widen the cap to make this pass: a float artifact on screen is\n"
            "  read as data, and the agent quotes it back as fact."
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
