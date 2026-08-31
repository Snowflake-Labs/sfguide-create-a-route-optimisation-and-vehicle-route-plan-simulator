#!/usr/bin/env python3
"""Guard: every SA app view must carry a presenter/agent `useCase` block.

Tenet 10 (Channel D). A view without a `useCase` shows no "i" overlay and is
invisible to the chat agent's solution catalog, so a Solution Engineer cannot see
what it is for and the agent cannot offer it when a customer describes a problem.
That failure is silent - the view renders perfectly - which is exactly why it
needs a check rather than a convention.

Covers both authoring surfaces:
  * config views   - fleet_sa_app/app/app-views.json + app/starter/app-views.json
  * code-registered - fleet_sa_app/ui/src/lib/packs/fleet/pack-views.json

The code-registered showcase views used to declare their blocks as inline object
literals in packs/fleet/index.ts. That surface was checked for `useCase` only,
never for `agentKnowledge`, which is how two of the five (the VRP simulator and
the ops console) shipped with no agent grounding at all; and because the catalog
generator reads JSON, none of the five reached VIEW_CATALOG. The metadata now
lives in pack-views.json and is held to the SAME rules as app-views.json, with a
regression guard below asserting index.ts does not re-inline it.

Also enforces two rules learned the hard way:
  * no top-level `info` key (the retired free-text field). A generator that owns a
    view block silently reverted one view to `info`, costing it its icon while the
    other 23 kept theirs. Nested `areas.*.config.info` is a DIFFERENT mechanism
    (the per-control slider popover) and is deliberately ignored.
  * no Unicode dashes, literal or \\u-escaped. The useCase blocks are now the
    largest body of prose in the repo and the house style is ASCII hyphens only.
  * every `areas.*.config.columns[].field` must equal its own lowercase form. The
    app's /api/query lowercases each returned column name into the row key
    (`col.name.toLowerCase()`), so a field carrying display case - e.g. `"On site
    (min)"` from a quoted SQL alias - matches no key and every cell renders BLANK
    with no error, no failing query and no type error. Shipped exactly that way
    once; display text belongs in `header`, not `field`.

Usage:
    python3 .cortex/skills/install-fleet-apps/scripts/check_view_usecases.py

Exit 0 = clean, 1 = problems (each printed with the offending view id).
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

SKILL_DIR = pathlib.Path(__file__).resolve().parents[1]
APP_DIR = SKILL_DIR / "fleet_sa_app" / "app"
PACK_DIR = SKILL_DIR / "fleet_sa_app" / "ui" / "src" / "lib" / "packs" / "fleet"
# pack-views.json holds the code-registered showcase views' metadata and is held
# to exactly the same rules as the declarative sources.
CONFIG_FILES = [
    APP_DIR / "app-views.json",
    APP_DIR / "starter" / "app-views.json",
    PACK_DIR / "pack-views.json",
]
PACK_FILE = PACK_DIR / "index.ts"

# Fields a useCase cannot be useful without: the headline is what the catalog
# shows the agent, the business question is what an SE opens with.
REQUIRED = ("headline", "businessQuestion")

DASHES = (("\u2013", "en dash"), ("\u2014", "em dash"),
          ("\\u2013", "escaped en dash"), ("\\u2014", "escaped em dash"))


def check_config(path: pathlib.Path, problems: list[str]) -> int:
    if not path.exists():
        problems.append(f"{path}: missing")
        return 0
    try:
        views = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        problems.append(f"{path}: invalid JSON ({exc})")
        return 0
    rel = path.relative_to(SKILL_DIR)
    for view_id, view in views.items():
        if "info" in view:
            problems.append(
                f"{rel}: {view_id} carries the retired top-level 'info' key - move "
                f"its prose into useCase.method / useCase.caveats. If a script in "
                f"scripts/ generates this view block, fix the GENERATOR too or the "
                f"next run reverts it."
            )
        uc = view.get("useCase")
        if not isinstance(uc, dict) or not uc:
            problems.append(
                f"{rel}: {view_id} has no useCase block - it will show no 'i' overlay "
                f"and stay absent from the agent's solution catalog (Tenet 10, Channel D)."
            )
            continue
        for field in REQUIRED:
            if not str(uc.get(field) or "").strip():
                problems.append(f"{rel}: {view_id}.useCase.{field} is missing or empty")
        # Tenet 10 Channel C. A view with no agentKnowledge still renders, so
        # nothing else notices, but the left-panel agent then has no idea which
        # tool to prefer, which metrics matter, or where the traps are - it
        # answers questions about the view from general knowledge. Checked here
        # because this is already the Tenet 10 gate; `preferredTool` stays
        # optional on purpose (the tenet says to omit it when no semantic view
        # models the data, and naming one that does not is worse than none).
        ak = view.get("agentKnowledge")
        if not isinstance(ak, dict) or not ak:
            problems.append(
                f"{rel}: {view_id} has no agentKnowledge block - the chat agent is "
                f"ungrounded for this view (Tenet 10, Channel C)."
            )
        elif not str(ak.get("keyMetrics") or ak.get("exampleQuestions") or "").strip():
            problems.append(
                f"{rel}: {view_id}.agentKnowledge carries neither keyMetrics nor "
                f"exampleQuestions, so it grounds nothing."
            )
    return len(views)


def check_pack(path: pathlib.Path, problems: list[str]) -> int:
    """Regression guard: index.ts must not re-inline view metadata.

    The five showcase views' useCase/agentKnowledge blocks live in
    pack-views.json so build_view_catalog.py can read them. If a future edit
    puts an inline `useCase:` back into index.ts, that view silently drops out
    of VIEW_CATALOG again - the app still renders it, so nothing else notices.
    Returns the number of registrations found.
    """
    if not path.exists():
        problems.append(f"{path}: missing")
        return 0
    src = path.read_text()
    rel = path.relative_to(SKILL_DIR)
    blocks = src.split("viewRegistry.register({")[1:]
    for block in blocks:
        m = re.search(r"id:\s*'([^']+)'", block)
        view_id = m.group(1) if m else "<unknown id>"
        for key in ("useCase:", "agentKnowledge:"):
            if key in block:
                problems.append(
                    f"{rel}: {view_id} declares an inline '{key}' block. That "
                    f"metadata must live in pack-views.json, which is the only "
                    f"copy build_view_catalog.py can read - inlining it here "
                    f"drops the view from VIEW_CATALOG silently."
                )
    return len(blocks)


def check_column_fields(path: pathlib.Path, problems: list[str]) -> int:
    """Assert every table column `field` is lowercase (the row-key contract).

    Returns the number of column definitions inspected.
    """
    if not path.exists():
        return 0
    try:
        views = json.loads(path.read_text())
    except json.JSONDecodeError:
        return 0  # check_config already reported the parse failure
    rel = path.relative_to(SKILL_DIR)
    seen = 0
    for view_id, view in views.items():
        for area_id, area in (view.get("areas") or {}).items():
            if not isinstance(area, dict):
                continue
            cols = (area.get("config") or {}).get("columns")
            if not isinstance(cols, list):
                continue
            for col in cols:
                if not isinstance(col, dict):
                    continue
                field = col.get("field")
                if not isinstance(field, str):
                    continue
                seen += 1
                if field != field.lower():
                    problems.append(
                        f"{rel}: {view_id}.{area_id} column field {field!r} is not "
                        f"lowercase - /api/query lowercases every column name into "
                        f"the row key, so this renders BLANK cells silently. Use the "
                        f"lowercased SQL alias as 'field' and put the display text in "
                        f"'header'. Fix the GENERATOR too if a script owns this view."
                    )
    return seen


def check_dashes(paths: list[pathlib.Path], problems: list[str]) -> None:
    for path in paths:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        rel = path.relative_to(SKILL_DIR)
        for needle, name in DASHES:
            n = text.count(needle)
            if n:
                problems.append(f"{rel}: {n} {name}(s) found - use ASCII hyphens only")


def main() -> int:
    problems: list[str] = []
    n_config = sum(check_config(p, problems) for p in CONFIG_FILES)
    n_pack = check_pack(PACK_FILE, problems)
    n_cols = sum(check_column_fields(p, problems) for p in CONFIG_FILES)
    check_dashes(CONFIG_FILES + [PACK_FILE], problems)

    if problems:
        print("FAILED: view useCase check")
        for p in problems:
            print(f"  - {p}")
        return 1

    print(
        f"PASSED: useCase + agentKnowledge present on {n_config} view(s) across "
        f"the declarative and pack sources; {n_pack} code-registered view(s) "
        f"carry no inlined metadata; no retired 'info' keys; "
        f"{n_cols} column field(s) lowercase; no Unicode dashes."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
