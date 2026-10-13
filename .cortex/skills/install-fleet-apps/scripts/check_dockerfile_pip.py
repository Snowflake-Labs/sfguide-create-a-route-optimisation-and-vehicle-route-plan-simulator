#!/usr/bin/env python3
"""Guard: an image build that runs pip as root must not print pip's root-user
WARNING into the install log.

What happened (wgb26798, fresh-machine install on dev): the downloader and
routing_reverse_proxy images run `pip install` as root, and every uncached
build printed, twice per image,

    WARNING: Running pip as the 'root' user can result in broken permissions ...

into /tmp/ifa_img_<name>.log. The step still reported OK, so the only signal was
a WARNING line in a sub-log that no check read. Root is deliberate here (a
single-purpose image with no system Python to protect), so the fix is to say so
with PIP_ROOT_USER_ACTION=ignore, which pip honours since 22.1.

Rule (Dockerfile comments are stripped first, so a commented-out ENV does not
count): in every tracked Dockerfile, each build stage that runs pip install has
`ENV PIP_ROOT_USER_ACTION=ignore` BEFORE its first pip RUN, or passes
`--root-user-action=ignore` to every pip install in that RUN. An ENV in an
earlier stage does not carry over: each FROM starts a fresh environment.

Usage:  python3 .cortex/skills/install-fleet-apps/scripts/check_dockerfile_pip.py
Exit:   0 clean, 1 violation
"""
from __future__ import annotations

import os
import pathlib
import re
import subprocess
import sys

REPO = pathlib.Path(os.environ.get("GATE_REPO") or pathlib.Path(__file__).resolve().parents[4])

PIP_INSTALL = re.compile(r"\b(?:pip3?|python3?\s+-m\s+pip)\s+install\b")
ENV_IGNORE = re.compile(r"^ENV\s+(?:.*\s)?PIP_ROOT_USER_ACTION\s*=\s*ignore\b", re.I)


def instructions(text: str) -> list[str]:
    """Dockerfile instructions with comments dropped and `\\` continuations joined."""
    out: list[str] = []
    cur = ""
    for raw in text.splitlines():
        line = raw.strip()
        if not cur and (not line or line.startswith("#")):
            continue
        if line.startswith("#"):
            continue
        if line.endswith("\\"):
            cur += line[:-1] + " "
            continue
        cur += line
        out.append(cur.strip())
        cur = ""
    if cur.strip():
        out.append(cur.strip())
    return out


def main() -> int:
    files = subprocess.run(["git", "-C", str(REPO), "ls-files", "--cached", "--others",
                            "--exclude-standard"], capture_output=True, text=True,
                           check=True).stdout.split("\n")
    dockerfiles = [f for f in files if f and pathlib.PurePosixPath(f).name.startswith("Dockerfile")
                   and "node_modules/" not in f]
    failures: list[str] = []
    pip_files = 0
    for rel in sorted(dockerfiles):
        p = REPO / rel
        if not p.is_file():
            continue
        env_ok = False
        uses_pip = False
        stage = 0
        for ins in instructions(p.read_text()):
            word = ins.split(None, 1)[0].upper()
            if word == "FROM":
                stage += 1
                env_ok = False
            elif word == "ENV" and ENV_IGNORE.match(ins):
                env_ok = True
            elif word == "RUN" and PIP_INSTALL.search(ins):
                uses_pip = True
                calls = re.split(r"&&|;|\|\|", ins)
                flagged = all("--root-user-action=ignore" in c
                              for c in calls if PIP_INSTALL.search(c))
                if not (env_ok or flagged):
                    failures.append(
                        f"{rel} stage {stage}: `{ins[:90]}` runs pip install as root with no "
                        "ENV PIP_ROOT_USER_ACTION=ignore before it (and no "
                        "--root-user-action=ignore on the call) - the build prints pip's "
                        "root-user WARNING into the install log")
        pip_files += uses_pip
    if pip_files == 0:
        failures.append("no tracked Dockerfile runs pip install - the scan found nothing to "
                        "check (did the Dockerfiles move?)")
    if failures:
        print("FAILED: Dockerfile pip root-user warning")
        for f in failures:
            print("  - " + f)
        return 1
    print(f"PASSED: {pip_files} Dockerfile(s) run pip install and each declares "
          "PIP_ROOT_USER_ACTION=ignore first.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
