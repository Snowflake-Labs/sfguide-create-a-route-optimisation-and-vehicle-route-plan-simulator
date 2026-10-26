#!/usr/bin/env python3
"""Guard: no tracked file may match a .gitignore rule.

Why this exists
---------------
`.gitignore` declares `**/logs/*.md` local run artifacts, but 72 dated run logs
were committed before the rule existed, and an ignore rule never untracks a
file. Every fresh clone shipped them, and the install summary's
"friction log:" line points the customer into the same logs/ directory, where
the first thing they see is a June run against another account, with that
account's app endpoints. Three dev scratch scripts in logs/ (one hardcoding a
developer's checkout path and connection) shipped the same way.

`git ls-files -ci --exclude-standard` lists exactly the tracked files an
ignore rule matches. It must be empty.

Usage:
  python3 check_no_tracked_ignored.py            gate on this checkout
  python3 check_no_tracked_ignored.py <repo>     gate on another checkout
"""
from __future__ import annotations

import subprocess
import sys


def tracked_ignored(repo: str) -> list[str]:
    out = subprocess.run(
        ["git", "-C", repo, "ls-files", "-ci", "--exclude-standard"],
        capture_output=True, text=True, check=True).stdout
    return [p for p in out.splitlines() if p.strip()]


def main() -> int:
    repo = sys.argv[1] if len(sys.argv) > 1 else "."
    bad = tracked_ignored(repo)
    if bad:
        print(f"[no_tracked_ignored] FAIL: {len(bad)} tracked file(s) match a "
              ".gitignore rule and ship in every clone:")
        for p in bad[:20]:
            print(f"  {p}")
        print("  fix: git rm --cached <path> (keeps the local copy)")
        return 1
    print("[no_tracked_ignored] OK: no tracked file matches a .gitignore rule")
    return 0


if __name__ == "__main__":
    sys.exit(main())
