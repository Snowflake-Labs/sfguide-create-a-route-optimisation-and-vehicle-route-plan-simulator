#!/usr/bin/env python3
"""check_chat_table_scroll.py - a table in the chat panel must be reachable.

WHY THIS IS A GATE

The tables a user reads in the agent tab are MARKDOWN, written by the agent:
`agent-spec.json` instructs it to "present it as a MARKDOWN TABLE" for every
backload, chain and verb result, and the analyst results are suppressed so the
agent narrates them. Those tables are styled by exactly one rule in globals.css,
and that rule said `width: 100%`.

The failure is quiet and total. `width: 100%` squeezes a result wider than the
panel until the columns collide, and the only `overflow` in the chain was
`hidden`, so whatever did not fit was CUT OFF with no scrollbar and no indication
that anything was missing. An answer with twelve columns silently became an answer
with seven. Nothing errors, nothing logs, and the table still looks like a table -
which is why it survived.

THREE RULES

  A. The markdown `table` element is wrapped in a scroll container by the
     component that renders agent prose. CSS alone cannot fix this: the element
     that overflows and the element with a bounded size must be different ones, so
     the wrapper has to exist in the React tree.
  B. That container's class carries `overflow` in the stylesheet, and the table
     itself no longer declares the `width: 100%` that caused the squeeze.
  C. The React grid (`data-table.tsx`) scrolls too, and its header is sticky. It is
     the same defect from a different direction - `overflow: hidden` on its own
     wrapper - and it renders the same results when a verb result is bound to it.

Every check reads COMMENT-STRIPPED source. Three rules in check_chart_rendering.py
have already passed on the prose describing a defect rather than the code avoiding
it, and both files here name every property in their explanations.
"""

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
SA_UI = REPO / ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src"
MARKDOWN_SITE = SA_UI / "components/chat/message-part.tsx"
GLOBAL_CSS = SA_UI / "app/globals.css"
DATA_TABLE = SA_UI / "components/inline/data-table.tsx"

SCROLL_CLASS = "markdown-table-scroll"


def strip_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return "\n".join(l for l in src.split("\n") if not l.lstrip().startswith("//"))


def rule_a(problems: list[str]) -> int:
    """The markdown table is wrapped in a scroll container in the React tree."""
    if not MARKDOWN_SITE.exists():
        problems.append(f"RULE A: {MARKDOWN_SITE.relative_to(REPO)} is missing")
        return 0
    code = strip_comments(MARKDOWN_SITE.read_text())
    override = re.search(r"table:\s*\(\{[^}]*\}\)\s*=>\s*\((.*?)\n\s*\),", code, re.S)
    if not override:
        problems.append(
            "RULE A: components/chat/message-part.tsx declares no `table` component "
            "override, so an agent's markdown table renders bare. A table wider than "
            "the chat panel is then squeezed and clipped - columns disappear with no "
            "scrollbar and no error.")
        return 1
    if SCROLL_CLASS not in override.group(1):
        problems.append(
            f"RULE A: the `table` override does not wrap the table in "
            f"`{SCROLL_CLASS}`. The element that overflows and the element with a "
            f"bounded height must be different ones, so the wrapper is load-bearing "
            f"and cannot be replaced by a CSS rule on the table.")
    return 1


def rule_b(problems: list[str]) -> int:
    """The stylesheet scrolls the wrapper and no longer pins the table to 100%."""
    if not GLOBAL_CSS.exists():
        problems.append(f"RULE B: {GLOBAL_CSS.relative_to(REPO)} is missing")
        return 0
    css = re.sub(r"/\*.*?\*/", "", GLOBAL_CSS.read_text(), flags=re.S)
    wrapper = re.search(rf"\.{SCROLL_CLASS}\s*\{{([^}}]*)\}}", css)
    if not wrapper:
        problems.append(
            f"RULE B: globals.css has no .{SCROLL_CLASS} rule, so the wrapper "
            f"RULE A requires has no scroll behaviour and the clip is unchanged.")
    elif "overflow" not in wrapper.group(1):
        problems.append(
            f"RULE B: .{SCROLL_CLASS} sets no overflow. Without it the wrapper is a "
            f"plain div and the table is still cut off at the panel edge.")

    table_rule = re.search(r"\.markdown-body table\s*\{([^}]*)\}", css)
    if not table_rule:
        problems.append("RULE B: globals.css has no .markdown-body table rule")
    elif re.search(r"(?<!min-)width:\s*100%", table_rule.group(1)):
        problems.append(
            "RULE B: .markdown-body table is back to `width: 100%`. That is the "
            "squeeze itself - it forces twelve columns into the panel width and the "
            "cells collide. Use `min-width: 100%; width: max-content` so the columns "
            "keep their natural size and the wrapper scrolls.")
    return 1


def rule_c(problems: list[str]) -> int:
    """The React grid scrolls in both axes and pins its header."""
    if not DATA_TABLE.exists():
        problems.append(f"RULE C: {DATA_TABLE.relative_to(REPO)} is missing")
        return 0
    code = strip_comments(DATA_TABLE.read_text())
    if "overflowX" not in code:
        problems.append(
            "RULE C: components/inline/data-table.tsx sets no horizontal overflow. Its "
            "outer wrapper is `overflow: hidden` for the rounded corners, so without "
            "an inner scroll box a wide tool result loses its trailing columns.")
    if not re.search(r"position:\s*'sticky'", code):
        problems.append(
            "RULE C: data-table.tsx has no sticky header. The registry mounts it with "
            "maxHeight 400, so the header scrolls away and the remaining rows are "
            "unlabelled numbers.")
    if re.search(r"<table style=\{\{\s*width:\s*'100%'", code):
        problems.append(
            "RULE C: data-table.tsx pins its table to width 100%, which squeezes the "
            "columns rather than letting the container scroll.")
    return 1


def main() -> int:
    problems: list[str] = []
    checked = rule_a(problems) + rule_b(problems) + rule_c(problems)

    # Vacuity counter, matching check_number_formatting.py rule D: a gate whose
    # paths have gone stale passes by inspecting nothing.
    if checked < 3:
        print(f"FAILED: inspected {checked} of 3 surfaces - paths are stale, so this "
              f"gate is partly vacuous.")
        return 1
    if problems:
        print("FAILED: a table in the chat panel is unreachable:")
        for p in problems:
            print(f"  - {p}")
        print("\n  A clipped table is not a styling nit: the columns that fall off the "
              "edge\n  are simply absent from the answer, and nothing says so.")
        return 1
    print(f"OK: markdown tables wrapped and scrollable, .{SCROLL_CLASS} styled, "
          f"React grid scrolls with a sticky header ({checked} surfaces).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
