#!/usr/bin/env python3
"""Enforce `--enable-templating NONE` when deploying SQL that contains `&&`.

THE DEFECT THIS PREVENTS
------------------------
`snow sql` defaults to `--enable-templating LEGACY,STANDARD`. LEGACY is SnowSQL
`&var` substitution, in which `&&` is the ESCAPE SEQUENCE for a literal `&`. So
deploying a JavaScript stored procedure without `--enable-templating NONE`
rewrites every LOGICAL AND (`&&`) into a BITWISE AND (`&`).

Bitwise `&` does not short-circuit. Every null guard of the shape

    if (a && a.b) { ... }

therefore becomes

    if (a & a.b) { ... }

which evaluates `a.b` even when `a` is null, and throws.

MEASURED, not theorised: routing-agent/references/deploy-agent.sql contains 75
`&&`. The procedure deployed from it, TOOL_BACKLOAD_SOLVE, contained **0 `&&` and
25 bare `&`** - `(resp && resp.routes && resp.routes.length)` had silently become
`(resp & resp.routes & resp.routes.length)`. Symptom: `backload_solve` with
`max_loads >= ~600` returned `{"error":"unknown error","reason":"ERROR"}` after
8.5s, thrown as "Cannot read properties of null (reading 'routes')" whenever the
solver legitimately returned null - while the verb's own description tells the
agent `max_loads` is "clamped to 1000". 8 of the 9 JavaScript TOOL_* procs shipped
corrupted on EVERY install; TOOL_BACKLOAD_CHAIN_SOLVE alone has 29 such guards.

This is nastier than the ampersand-in-prose case the repo already knew about:
mangled prose is visible, a mangled guard is a latent null-dereference that only
fires on the null path.

WHAT IT CHECKS
--------------
For every `.sql` file in the skill tree that contains `&&`, every shell
invocation that deploys it with `snow sql ... -f` must pass
`--enable-templating NONE`. Files are matched both by literal name and through a
shell variable assigned that path, because the installer deploys via
`$ROUTING_TOOLS_SQL` rather than by name.

Exit 0 clean, 1 on any finding. Read-only.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent      # .../.cortex/skills/install-fleet-apps
SKILLS_ROOT = SKILL_DIR.parent                          # .../.cortex/skills
REPO_ROOT = SKILLS_ROOT.parent.parent                   # repo root (skills -> .cortex -> repo)

SKIP_PARTS = {"_installed", "node_modules", ".next", "__pycache__"}


def interesting(path: Path) -> bool:
    return not (set(path.parts) & SKIP_PARTS)


def sql_files_with_logical_and() -> dict[str, Path]:
    """SQL files containing `&&` - i.e. those LEGACY templating would corrupt."""
    out: dict[str, Path] = {}
    if not SKILLS_ROOT.exists():
        return out
    for p in sorted(SKILLS_ROOT.rglob("*.sql")):
        if not interesting(p) or not p.is_file():
            continue
        try:
            if "&&" in p.read_text(encoding="utf-8", errors="replace"):
                out[p.name] = p
        except OSError:
            continue
    return out


def shell_files() -> list[Path]:
    if not SKILLS_ROOT.exists():
        return []
    return [p for p in sorted(SKILLS_ROOT.rglob("*.sh")) if interesting(p) and p.is_file()]


def main() -> int:
    at_risk = sql_files_with_logical_and()
    if not at_risk:
        print("PASS: no .sql file in the skill tree contains `&&` (nothing LEGACY "
              "templating could corrupt)")
        return 0

    findings: list[str] = []
    checked = 0

    for sh in shell_files():
        try:
            text = sh.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        lines = text.split("\n")

        # Shell variables holding a path to an at-risk SQL file, so a deploy via
        # "$ROUTING_TOOLS_SQL" is still attributed to deploy-agent.sql.
        var_to_sql: dict[str, str] = {}
        for m in re.finditer(r'^\s*([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|(\S+))', text, re.M):
            val = m.group(2) or m.group(3) or ""
            for name in at_risk:
                if val.endswith(name):
                    var_to_sql[m.group(1)] = name

        for i, line in enumerate(lines, start=1):
            if "snow sql" not in line or " -f " not in line:
                continue
            # Which at-risk SQL does this line deploy?
            target = next((n for n in at_risk if n in line), None)
            if target is None:
                for var, name in var_to_sql.items():
                    if f"${var}" in line or f'"${var}"' in line or f"${{{var}}}" in line:
                        target = name
                        break
            if target is None:
                continue
            checked += 1
            if "--enable-templating" not in line or not re.search(
                r"--enable-templating\s+NONE", line
            ):
                rel = sh.relative_to(REPO_ROOT)
                findings.append(
                    f"{rel}:{i}: deploys {target} (contains `&&`) without "
                    f"`--enable-templating NONE`. LEGACY templating will rewrite every "
                    f"`&&` to a bitwise `&`, turning `a && a.b` null guards into "
                    f"null-dereferences.\n      {line.strip()[:150]}"
                )

    if findings:
        print("FAIL: JavaScript-bearing SQL deployed with LEGACY templating\n")
        for f in findings:
            print(f"  {f}")
        print(f"\n{len(findings)} finding(s). Add `--enable-templating NONE` to each "
              f"`snow sql -f` above.")
        return 1

    names = ", ".join(sorted(at_risk))
    print(f"PASS: {checked} deploy site(s) of {len(at_risk)} `&&`-bearing SQL file(s) "
          f"pass --enable-templating NONE ({names})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
