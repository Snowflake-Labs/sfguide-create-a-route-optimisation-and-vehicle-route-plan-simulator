#!/usr/bin/env python3
"""Negative test for check_chat_table_scroll.py.

Each mutation restores a real pre-fix state, or one of the near-misses that looks
like the fix. The gate must reject all of them - a gate never seen to fail has
proved nothing, which this repo has now demonstrated several times over.

The real files are patched and restored in a `finally`; nothing else may edit the
tree while this runs.
"""

import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
SCRIPTS = Path(__file__).resolve().parent
GATE = SCRIPTS / "check_chat_table_scroll.py"
SA_UI = REPO / ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src"
MARKDOWN_SITE = SA_UI / "components/chat/message-part.tsx"
GLOBAL_CSS = SA_UI / "app/globals.css"
DATA_TABLE = SA_UI / "components/inline/data-table.tsx"


def run_gate() -> int:
    return subprocess.run([sys.executable, str(GATE)], capture_output=True).returncode


MUTATIONS = [
    # M1: the pre-fix state - no table override at all.
    ("M1 table override removed", MARKDOWN_SITE,
     lambda s: re.sub(r"\n\s*table: \(\{ children \}\) => \(.*?\n\s*\),", "", s,
                      count=1, flags=re.S)),
    # M2: the override kept but the wrapper dropped. Looks handled, clips identically.
    ("M2 override no longer wraps in the scroll class", MARKDOWN_SITE,
     lambda s: s.replace('<div className="markdown-table-scroll">', "<div>", 1)),
    # M3: the stylesheet rule gone, so the wrapper is a plain div.
    ("M3 .markdown-table-scroll rule deleted", GLOBAL_CSS,
     lambda s: re.sub(r"\.markdown-table-scroll \{[^}]*\}", "", s, count=1)),
    # M4: the wrapper kept but its overflow removed - the half-fix.
    ("M4 scroll wrapper loses its overflow", GLOBAL_CSS,
     lambda s: s.replace(".markdown-table-scroll {\n  overflow: auto;",
                         ".markdown-table-scroll {", 1)),
    # M5: width: 100% back on the table. This is the squeeze itself, and it survives
    # every other check because the wrapper is still present and still scrolls.
    ("M5 table pinned back to width 100%", GLOBAL_CSS,
     lambda s: s.replace("  min-width: 100%;\n  width: max-content;",
                         "  width: 100%;", 1)),
    # M6: the React grid back to a single hidden wrapper.
    ("M6 data-table loses its horizontal scroll", DATA_TABLE,
     lambda s: s.replace(
         "      <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '380px' }}>",
         "      <div>", 1)),
    # M7: sticky header dropped, so scrolled rows are unlabelled numbers.
    ("M7 data-table header no longer sticky", DATA_TABLE,
     lambda s: s.replace("                  position: 'sticky',", "", 1)),
]


def main() -> int:
    if run_gate() != 0:
        print("ABORT: the gate is already failing on an unmutated tree.")
        return 1

    failures = []
    for label, path, mutate in MUTATIONS:
        original = path.read_text()
        try:
            mutated = mutate(original)
            if mutated == original:
                failures.append(f"{label}: mutation did not apply - the anchor has "
                                f"moved, so this case tested NOTHING")
                continue
            path.write_text(mutated)
            if run_gate() == 0:
                failures.append(f"{label}: gate PASSED on a mutated tree")
            else:
                print(f"  convicted: {label}")
        finally:
            path.write_text(original)

    if run_gate() != 0:
        failures.append("the tree was not restored cleanly - the gate fails after the run")

    if failures:
        print("FAIL: check_chat_table_scroll.py is not watertight:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"OK: all {len(MUTATIONS)} mutations convicted by check_chat_table_scroll.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
