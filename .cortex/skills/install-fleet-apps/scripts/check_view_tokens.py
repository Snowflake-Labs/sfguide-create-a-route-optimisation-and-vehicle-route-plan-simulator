#!/usr/bin/env python3
"""
check_view_tokens.py - every {{...}} token in an authored view spec must (a) sit
on a path the renderer actually interpolates and (b) name a group.key the paired
display config actually defines.

WHY THIS IS A GATE AND NOT A REVIEW NOTE

The neutral vocabulary is the point of the config-driven app: an author writes
"{{labels.operator_plural}}" and the deployment decides whether that reads
"Drivers", "Couriers" or "Operators". When a field is rendered without passing
through interpolateTokens the token is not merely un-substituted - the literal
braces appear on screen. Nothing fails: the query runs, the panel renders, the
numbers are right, and a chart legend reads

    {{labels.operator_plural}}: 32

That shipped. `series[].label` was the ONE authored string the renderer never
interpolated - view-renderer handles the area title, so a titled chart looked
correct while its own legend and tooltip did not - and it reached a live account.
Fixing that field is not enough, because the defect is a CLASS: the same audit
found `emptyMessage` rendered raw in three components with two views already
authoring tokens into it, plus map legend labels, map toggle labels and map
tooltips. A gate is what keeps the next added field honest.

WHY AN EXPLICIT PATH LIST, AND WHY DEFAULT-DENY

The first version of this gate derived the allowed set from the renderer sources
by collecting the field NAMES passed to interpolateTokens. It was rejected by its
own negative test. `label` is interpolated on a metric card and on a detail-panel
action, so "label" landed in the derived set, so a token on the chart's
`series[].label` PASSED - the gate could not catch the one defect it was written
for. A name-keyed allowlist is default-ALLOW for every other container that
happens to reuse the name, which is the wrong polarity for a silent failure.

So the allowlist is keyed on the normalized PATH, and anything not listed FAILS.
A new authored field carrying a token cannot ship until someone confirms it is
interpolated and records the render site here. That is the property worth having:
the failure mode this guards is invisible on screen, so the default must be no.

The cost is that this list is maintained by hand. Two things keep it honest: each
entry names the render site, so a claim here is checkable in one grep; and a
DERIVED cross-check reports any entry whose leaf field appears in no
interpolateTokens call anywhere in the UI. The cross-check is advisory, not
blocking, because some call sites legitimately pass a local (ViewMap interpolates
its tooltip template as `interpolateTokens(tpl, display)`), which no static field
scan can attribute back to `layers[].tooltip`.

NORMALIZATION

A concrete path is `labor_overtime.areas.trend.config.series.[].label`. The view id
and the area name are author-chosen, so both are collapsed to `*` before matching:
`*.areas.*.config.series.[].label`.

THE NAME CHECK

Sitting on an interpolated path is necessary but not sufficient: a token still has
to name something. `{{labels.operatr_plural}}` (a typo) or `{{labels.rider}}` (a
key this config never defined) resolves to nothing, and interpolateTokens leaves
the literal braces on screen - the identical invisible failure. So each token's
group.key is checked against the display config PAIRED with that surface
(app-config.json for the fleet views, starter/app-config.json for the starter
views), built to mirror interpolateTokens: a name resolves iff display[group] is a
string map that contains key.

Exit 0 clean, 1 on any violation.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
SKILL = REPO / ".cortex/skills/install-fleet-apps"
APP = SKILL / "fleet_sa_app/app"
UI_SRC = SKILL / "fleet_sa_app/ui/src"

# The authoring surfaces, each paired with the display config whose vocabulary its
# tokens resolve against. app-views.json is the declarative one; pack-views lives
# under the UI because the pack registers its views in code; both resolve against
# the shipped app-config.json. The starter pair is what a fresh retarget begins
# from, and it ships too, so a broken token there is a broken starting point - it
# is scanned against its OWN config, not the fleet one.
SURFACES = [
    (APP / "app-views.json", APP / "app-config.json"),
    (UI_SRC / "lib/packs/fleet/pack-views.json", APP / "app-config.json"),
    (APP / "starter/app-views.json", APP / "starter/app-config.json"),
]

# Normalized path -> the render site that interpolates it. Adding an entry is a
# claim that must be checkable by grepping the named file for interpolateTokens.
INTERPOLATED_PATHS: dict[str, str] = {
    # Left panel / view chrome - lib/load-views.tsx
    "*.label": "load-views.tsx interpolates view.label",
    "*.description": "load-views.tsx interpolates view.description",
    # Agent grounding (Channel C) - lib/load-views.tsx
    "*.agentKnowledge.keyMetrics.[]": "load-views.tsx maps keyMetrics through interpolateTokens",
    "*.agentKnowledge.exampleQuestions.[]": "load-views.tsx maps exampleQuestions",
    "*.agentKnowledge.gotchas": "load-views.tsx interpolates gotchas",
    # Use case / 'i' overlay (Channel D) - lib/load-views.tsx `list()` helper
    "*.useCase.headline": "load-views.tsx interpolates headline",
    "*.useCase.businessQuestion": "load-views.tsx interpolates businessQuestion",
    "*.useCase.method": "load-views.tsx interpolates method",
    "*.useCase.caveats": "load-views.tsx interpolates caveats",
    "*.useCase.audience.[]": "load-views.tsx list(uc.audience)",
    "*.useCase.industries.[]": "load-views.tsx list(uc.industries)",
    "*.useCase.talkTrack.[]": "load-views.tsx list(uc.talkTrack)",
    "*.useCase.snowflakeCapabilities.[]": "load-views.tsx list(uc.snowflakeCapabilities)",
    "*.useCase.dataRequired.[]": "load-views.tsx list(uc.dataRequired)",
    "*.useCase.valueDrivers.[]": "load-views.tsx list(uc.valueDrivers)",
    # Area header bar - components/views/view-renderer.tsx
    "*.areas.*.title": "view-renderer.tsx interpolates the area title",
    "*.areas.*.subtitle": "view-renderer.tsx interpolates the area subtitle",
    "*.areas.*.config.title": "view-renderer.tsx falls back to config.title for the header",
    # Charts - components/views/areas/view-chart.tsx
    "*.areas.*.config.series.[].label": "view-chart.tsx interpolates each series label",
    # Metric cards - components/views/areas/metric-cards.tsx
    "*.areas.*.data.mapping.metrics.[].label": "metric-cards.tsx interpolates m.label",
    # Detail panel - components/views/areas/detail-panel.tsx via its `tr` wrapper
    "*.areas.*.config.actions.[].label": "detail-panel.tsx tr(action.label)",
    "*.areas.*.config.properties.[].label": "detail-panel.tsx tr(prop.label)",
    "*.areas.*.config.sections.[].title": "detail-panel.tsx tr(section.title)",
    # Empty states - detail-panel.tsx, detail-sections.tsx, view-map.tsx
    "*.areas.*.config.emptyMessage": "detail-panel/detail-sections/view-map interpolate emptyMessage",
    "*.areas.*.config.sections.[].emptyMessage": "detail-sections.tsx interpolates section.emptyMessage",
    # Map overlays - components/views/areas/view-map.tsx
    "*.areas.*.config.legend.[].label": "view-map.tsx MapLegend tr(it.label)",
    "*.areas.*.config.legend.[].minLabel": "view-map.tsx MapLegend tr(it.minLabel)",
    "*.areas.*.config.legend.[].maxLabel": "view-map.tsx MapLegend tr(it.maxLabel)",
    "*.areas.*.config.categoryLegend.[].label": "view-map.tsx MapLegend tr(it.label)",
    "*.areas.*.config.toggles.[].label": "view-map.tsx MapToggles interpolates t.label",
    "*.areas.*.config.layers.[].tooltip": "view-map.tsx getTooltip interpolates the template",
    # Markdown areas render their whole body through interpolateTokens.
    "*.areas.*.config.content": "markdown-area.tsx interpolates the raw body",
    "*.areas.*.content": "markdown-area.tsx interpolates the raw body",
}

TOKEN_RE = re.compile(r"\{\{\s*[\w.]+\s*\}\}")
# The renderer's own token grammar (display-config.ts): {{group.key}} where group
# is a display subsection and key is a leaf. Kept in lockstep so the NAME check
# below accepts exactly what interpolateTokens will resolve and no more.
TOKEN_NAME_RE = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\s*\}\}")


def normalize(path: str) -> str:
    """Collapse the author-chosen view id and area name to '*'."""
    segs = path.split(".")
    if segs:
        segs[0] = "*"
    if "areas" in segs:
        i = segs.index("areas")
        if len(segs) > i + 1:
            segs[i + 1] = "*"
    return ".".join(segs)


def leaf_field(path: str) -> str:
    for seg in reversed(path.split(".")):
        if seg not in ("[]", "*"):
            return seg
    return path


def token_paths(spec: Path) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []

    def walk(node, path: list[str]) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                walk(value, path + [key])
        elif isinstance(node, list):
            for value in node:
                walk(value, path + ["[]"])
        elif isinstance(node, str) and TOKEN_RE.search(node):
            found.append((".".join(path), node))

    walk(json.loads(spec.read_text(encoding="utf-8")), [])
    return found


def token_names(text: str) -> list[tuple[str, str]]:
    """(group, key) for every {{group.key}} in a string, renderer grammar."""
    return TOKEN_NAME_RE.findall(text)


def token_vocab(config: Path) -> dict[str, set[str]]:
    """The set of resolvable {{group.key}} names for a display config.

    Mirrors interpolateTokens exactly: a token resolves iff cfg.display[group] is
    an object and cfg.display[group][key] is a STRING. So labels and units qualify,
    and so would icons or statusEnums whose values are strings - anything whose
    values are objects (thresholds) is not a string map and cannot be a token
    target. Building the vocabulary from the config, rather than hardcoding
    'labels'/'units', keeps the check honest if a new string section is added.
    """
    disp = (json.loads(config.read_text(encoding="utf-8")).get("display") or {})
    vocab: dict[str, set[str]] = {}
    for group, bag in disp.items():
        if isinstance(bag, dict):
            keys = {k for k, v in bag.items() if isinstance(v, str)}
            if keys:
                vocab[group] = keys
    return vocab


def interpolated_field_names() -> set[str]:
    """Advisory cross-check: field names reaching interpolateTokens anywhere."""
    names: set[str] = set()
    sources = sorted(UI_SRC.rglob("*.ts")) + sorted(UI_SRC.rglob("*.tsx"))
    if not sources:
        sys.exit(f"check_view_tokens: no renderer sources under {UI_SRC}")
    for src in sources:
        text = src.read_text(encoding="utf-8")
        if "interpolateTokens" not in text:
            continue
        wrappers = set(re.findall(r"const\s+(\w+)\s*=[^\n;]*interpolateTokens\s*\(", text))
        wrappers.discard("interpolateTokens")
        callers = "|".join(sorted({"interpolateTokens", *wrappers}, key=len, reverse=True))
        names.update(re.findall(rf"(?:{callers})\(\s*\w+\.(\w+)", text))
        names.update(
            re.findall(rf"\w+\.(\w+)\??\.map\(\s*\([^)]*\)\s*=>\s*(?:{callers})\(", text)
        )
        if re.search(r"const\s+list\s*=[^\n;]*interpolateTokens\s*\(", text):
            names.update(re.findall(r"\blist\(\s*\w+\.(\w+)\s*\)", text))
    return names


def main() -> int:
    violations: list[str] = []
    checked = 0

    for spec, config in SURFACES:
        if not spec.exists():
            print(f"  note: {spec.relative_to(REPO)} absent, skipped")
            continue
        rel = spec.relative_to(REPO)
        vocab = token_vocab(config) if config.exists() else {}
        for path, text in token_paths(spec):
            checked += 1
            norm = normalize(path)
            if norm not in INTERPOLATED_PATHS:
                snippet = text if len(text) <= 90 else text[:87] + "..."
                violations.append(
                    f"{rel}: {path}\n"
                    f"      '{norm}' is not a known interpolated path, so the braces\n"
                    f"      print on screen: {snippet}"
                )
            # NAME check: even on an interpolated path, a token whose group/key is
            # not in the paired display config resolves to nothing and interpolateTokens
            # leaves the literal braces on screen - the same visible failure, from a
            # typo ({{labels.operatr_plural}}) or a token the config never defined.
            for group, key in token_names(text):
                if group not in vocab or key not in vocab[group]:
                    known = (
                        f"config defines {group}.{{{', '.join(sorted(vocab[group]))}}}"
                        if group in vocab
                        else f"config has no '{group}' string section"
                    )
                    violations.append(
                        f"{rel}: {path}\n"
                        f"      token {{{{{group}.{key}}}}} is not in "
                        f"{config.relative_to(REPO)} - {known}"
                    )

    # Advisory only - see the module docstring for why this cannot block.
    derived = interpolated_field_names()
    unbacked = sorted(
        {p for p in INTERPOLATED_PATHS if leaf_field(p) not in derived}
    )

    if violations:
        print("FAILED: authored token(s) on path(s) the renderer does not interpolate.\n")
        for v in violations:
            print("  - " + v)
        print(
            "\n  Fix by interpolating the field at its render site - it is an on-screen\n"
            "  string like every other - and then add the normalized path to\n"
            "  INTERPOLATED_PATHS with that site named. Removing the token is the other\n"
            "  valid fix. Do NOT add a path you have not verified: the whole point is\n"
            "  that this failure is invisible in the rendered page."
        )
        return 1

    print(
        f"PASSED: {checked} authored token(s) all sit on one of "
        f"{len(INTERPOLATED_PATHS)} known interpolated path(s)."
    )
    if unbacked:
        print(
            "  advisory: no interpolateTokens call names these fields directly "
            "(expected for templates passed as locals):"
        )
        for p in unbacked:
            print(f"    {p}  <- {INTERPOLATED_PATHS[p]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
