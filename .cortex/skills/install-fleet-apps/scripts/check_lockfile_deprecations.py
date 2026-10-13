#!/usr/bin/env python3
"""Guard: no committed package-lock.json resolves a deprecated package.

What happened (wgb26798, fresh-machine install on dev): `npm ci` / `npm
install` printed `npm warn deprecated ...` into the install logs while every
step reported OK:
  - fleet_sa_app/ui and fleet_admin_app/ui: recharts@2.15.4 ("1.x and 2.x
    branches are no longer active")
  - fleet_tools/vendor/synapse: @aws-sdk/node-http-handler@3.374.0,
    @azure/core-http@3.0.5, glob@10.5.0, uuid@8.3.2, uuid@9.0.1, all pulled by
    snowflake-sdk 1.x (and node-domexception@1.0.0 still pulled by 3.x)
npm records the registry's deprecation message in the lockfile entry it
resolved (`"deprecated": "..."`), and that recorded entry is what an install
from the lockfile warns about. So the warning is visible statically.

Rule: every tracked package-lock.json outside node_modules has no package entry
carrying `deprecated`. Fix by upgrading the direct dependency, or with an npm
`overrides` entry in the ROOT package.json of that lockfile (npm ignores
overrides declared by a dependency).

Limit: a package the registry deprecates AFTER the lockfile was written is not
in the file yet; this gate catches it at the next relock, not before.

Usage:  python3 .cortex/skills/install-fleet-apps/scripts/check_lockfile_deprecations.py
Exit:   0 clean, 1 violation
"""
from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys

REPO = pathlib.Path(os.environ.get("GATE_REPO") or pathlib.Path(__file__).resolve().parents[4])
MIN_LOCKFILES = 5


def main() -> int:
    files = subprocess.run(["git", "-C", str(REPO), "ls-files", "--cached", "--others",
                            "--exclude-standard"], capture_output=True, text=True,
                           check=True).stdout.split("\n")
    locks = sorted(f for f in files if f.endswith("package-lock.json") and "node_modules/" not in f)
    failures: list[str] = []
    scanned = 0
    for rel in locks:
        p = REPO / rel
        if not p.is_file():
            continue
        try:
            data = json.loads(p.read_text())
        except json.JSONDecodeError as e:
            failures.append(f"{rel}: not valid JSON ({e})")
            continue
        scanned += 1
        for key, entry in (data.get("packages") or {}).items():
            if isinstance(entry, dict) and entry.get("deprecated"):
                name = key.split("node_modules/")[-1] or "(root)"
                failures.append(f"{rel}: {name}@{entry.get('version', '?')} is deprecated - "
                                f"\"{str(entry['deprecated'])[:110]}\" (npm prints this as "
                                "`npm warn deprecated` on every install)")
    if scanned < MIN_LOCKFILES:
        failures.append(f"only {scanned} package-lock.json file(s) found (expected at least "
                        f"{MIN_LOCKFILES}) - the scan is not seeing the lockfiles it exists for")
    if failures:
        print("FAILED: deprecated packages in committed lockfiles")
        for f in failures:
            print("  - " + f)
        return 1
    print(f"PASSED: {scanned} lockfile(s), no deprecated package.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
