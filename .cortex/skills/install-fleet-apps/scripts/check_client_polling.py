#!/usr/bin/env python3
"""Keep client-side polling on the shared, visibility-guarded hook.

WHY THIS GATE EXISTS
--------------------
Warehouse credits are billed for the time a warehouse is UP, not for work done.
The admin app polls Snowflake from the browser, so a loop that keeps ticking
while the tab sits in the background holds an X-Small awake for nothing.
`hooks/useVisiblePolling.ts` solves this and says so in its own doc comment
("Cost hygiene (Tier E)") - but it had only three call sites, while SIX loops
rolled their own `setInterval` and lost the guard:

  useProvisionJobs      3s   GET_PROVISION_STATUS, for the whole build
  useBuildProgress      5s   ORS_STATUS + 1000-line GET_SERVICE_LOGS, per region
  BuildSummaryCard     15s   service logs, while a panel was expanded
  function-tester      15s   LIST_REGIONS + ORS_STATUS per region
  matrix-builder        5s   jobs + inventory
  diagnostics           5s   in-process ring buffer (not a warehouse cost)

Measured: those two region-builder loops alone were why the interactive warehouse
never reached its 60s idle during a multi-hour region build.

WHY DEFAULT-DENY
----------------
The obvious implementation - flag a `setInterval` whose callback contains
`fetch('/api/...')` - would have caught NONE of the six. Every one of them called
an indirect helper (`fetchProvisionJobs()`, `refreshRegions()`, `fetchLogs()`),
so a body-level fetch check passes them all. A gate that cannot catch the defect
it was written for is worse than no gate, because it certifies the problem.

So this is default-DENY by construction: any `setInterval` under a scanned UI
directory is a finding unless the file carries an explicit marker declaring the
timer is UI-only, with a reason. Three timers legitimately qualify (an undo
countdown, a relative-timestamp re-render, a slider animation) and each now
states why. That is the point: opting out is possible but must be deliberate and
readable, rather than the silent default.

MARKER
------
Put this on or above the `setInterval` line (or anywhere in the file):

    // polling-gate: ui-only -- <why this timer touches no server state>

Exit 0 clean, 1 on any unmarked interval. Read-only: parses files, touches no
account.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent

# Scanned roots: the BROWSER-side trees of both apps only.
#
# Deliberately NOT `ui/src` wholesale. That tree also holds Node-process code -
# `instrumentation.ts`, `server/studio/jobs.ts`, and the SSE route under
# `app/api/.../stream/` - which legitimately runs long-lived intervals in the
# container, where a React hook is meaningless and `document.hidden` does not
# exist. The first version of this gate scanned `ui/src` and produced four such
# findings, i.e. it told the truth about the pattern and the wrong thing about
# the fix.
SCAN_ROOTS = [
    SKILL_DIR / "fleet_admin_app" / "ui" / "src" / "components",
    SKILL_DIR / "fleet_admin_app" / "ui" / "src" / "hooks",
    SKILL_DIR / "fleet_sa_app" / "ui" / "src" / "components",
    SKILL_DIR / "fleet_sa_app" / "ui" / "src" / "hooks",
]

# The canonical hook is the ONE place a raw setInterval belongs.
ALLOWED_FILES = {"useVisiblePolling.ts"}

MARKER_RE = re.compile(r"polling-gate:\s*ui-only\s*--\s*(\S.*)", re.IGNORECASE)
SET_INTERVAL_RE = re.compile(r"\bsetInterval\s*\(")

# Only flag real timer creation, not a type reference like
# `ReturnType<typeof setInterval>`.
TYPE_CONTEXT_RE = re.compile(r"typeof\s+setInterval")


def strip_comments_and_strings(text: str) -> str:
    """Blank out comments and string/template literals, preserving newlines.

    Load-bearing: these files DISCUSS `setInterval` in prose explaining why they
    no longer call it, and a naive scan reports those sentences as violations.
    (The warehouse-DDL gate in this repo failed exactly that way on its first
    run.) Newlines are preserved so reported line numbers stay accurate.
    """
    def blank(m: re.Match) -> str:
        return "\n" * m.group(0).count("\n")

    # Block comments, line comments, then the three string forms.
    text = re.sub(r"/\*.*?\*/", blank, text, flags=re.DOTALL)
    text = re.sub(r"//[^\n]*", "", text)
    text = re.sub(r"'(?:\\.|[^'\\\n])*'", "''", text)
    text = re.sub(r'"(?:\\.|[^"\\\n])*"', '""', text)
    text = re.sub(r"`(?:\\.|[^`\\])*`", blank, text, flags=re.DOTALL)
    return text


def main() -> int:
    findings: list[str] = []
    marked: list[str] = []
    scanned = 0

    for root in SCAN_ROOTS:
        if not root.exists():
            continue
        for path in sorted(root.rglob("*")):
            if path.suffix not in {".ts", ".tsx"} or not path.is_file():
                continue
            if "node_modules" in path.parts or ".next" in path.parts:
                continue
            if path.name in ALLOWED_FILES:
                continue

            raw = path.read_text(encoding="utf-8", errors="replace")
            code = strip_comments_and_strings(raw)
            scanned += 1

            hits = [
                code[: m.start()].count("\n") + 1
                for m in SET_INTERVAL_RE.finditer(code)
                if not TYPE_CONTEXT_RE.search(code[max(0, m.start() - 40): m.start() + 12])
            ]
            if not hits:
                continue

            # The marker is read from the RAW text: it lives in a comment.
            marker = MARKER_RE.search(raw)
            rel = path.relative_to(SKILL_DIR)
            if marker:
                marked.append(f"{rel} ({len(hits)} timer(s)): {marker.group(1).strip()}")
                continue
            for line in hits:
                findings.append(
                    f"{rel}:{line}: raw setInterval. Use "
                    f"useVisiblePolling(cb, intervalMs, enabled) so the loop pauses "
                    f"while the tab is hidden, or declare it UI-only with "
                    f"'// polling-gate: ui-only -- <reason>'."
                )

    if findings:
        print("FAIL: unguarded client-side polling\n")
        for f in findings:
            print(f"  {f}")
        print(
            f"\n{len(findings)} finding(s). A background tab must not hold a warehouse "
            f"awake: credits are billed for uptime, not for work done."
        )
        return 1

    print(f"PASS: {scanned} client file(s) scanned, no unguarded setInterval")
    if marked:
        print("  declared UI-only:")
        for m in marked:
            print(f"    {m}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
