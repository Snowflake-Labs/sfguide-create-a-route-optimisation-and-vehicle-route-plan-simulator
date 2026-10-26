#!/usr/bin/env python3
"""Negative test for check_no_tracked_ignored.py.

Builds a scratch repo with the repo's own `**/logs/*.md` rule and asserts:
  M1 a dated log committed before the rule exists -> gate FAILS (the shipped defect)
  M2 the same log force-added after the rule      -> gate FAILS
  C1 only logs/README.md tracked (un-ignored)     -> gate PASSES
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(HERE, "check_no_tracked_ignored.py")
RULES = "**/logs/*.md\n!**/logs/README.md\n"


def sh(repo: str, *args: str) -> None:
    subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True,
                   env={**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null",
                        "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})


def write(repo: str, rel: str, text: str) -> None:
    path = os.path.join(repo, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def gate(repo: str) -> int:
    return subprocess.run([sys.executable, GATE, repo],
                          capture_output=True).returncode


def scratch() -> str:
    repo = tempfile.mkdtemp()
    sh(repo, "init", "-q")
    write(repo, "logs/README.md", "readme\n")
    return repo


def main() -> int:
    fails = 0

    r = scratch()
    write(r, "logs/friction-log_2026-06-24_08-43.md", "old run\n")
    sh(r, "add", "-A"); sh(r, "commit", "-qm", "before rule")
    write(r, ".gitignore", RULES)
    sh(r, "add", ".gitignore"); sh(r, "commit", "-qm", "rule")
    if gate(r) == 0:
        print("M1 SURVIVED: log tracked before the rule passed"); fails += 1

    r = scratch()
    write(r, ".gitignore", RULES)
    write(r, "logs/friction-log_x.md", "run\n")
    sh(r, "add", ".gitignore", "logs/README.md")
    sh(r, "add", "-f", "logs/friction-log_x.md"); sh(r, "commit", "-qm", "f")
    if gate(r) == 0:
        print("M2 SURVIVED: force-added log passed"); fails += 1

    r = scratch()
    write(r, ".gitignore", RULES)
    write(r, "logs/friction-log_y.md", "local only\n")
    sh(r, "add", "-A"); sh(r, "commit", "-qm", "clean")
    if gate(r) != 0:
        print("C1 FALSE POSITIVE: README-only repo failed"); fails += 1

    print("[no_tracked_ignored negative] " +
          ("OK: 2/2 mutations convicted, control passes" if not fails
           else f"FAIL: {fails}"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
