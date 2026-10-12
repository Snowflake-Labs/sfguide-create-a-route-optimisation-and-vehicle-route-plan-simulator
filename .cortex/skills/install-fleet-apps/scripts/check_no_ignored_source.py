#!/usr/bin/env python3
"""Guard: no source file may exist only on a developer's disk because a
.gitignore rule swallowed it.

Why this exists
---------------
The generic rules `env/` (Python virtualenvs) and `build/` (build output) match
by directory NAME anywhere in the tree, and real source directories share those
names. Three files lived only on the machine that wrote them:

  fleet_admin_app/ui/src/app/api/diagnostics/env/route.ts  (Diagnostics page)
  fleet_admin_app/ui/src/app/api/matrix/build/route.ts     (Matrix Builder "Build")
  fleet_tools/vendor/synapse/tests/unit/build/json-schema.test.ts

A fresh clone has none of them, so the two admin routes 404 - and no install
run can see it, because a test clone is MISSING the file rather than carrying a
broken one, and nothing in the install clicks those pages. The same rule had
already eaten synapse `src/build/` once (see the un-ignore in .gitignore). The
only place the defect is observable is the machine where the file was written,
which is where this runs: `.githooks/pre-commit`, and as the first gate of
routing-solution-cleanup/scripts/reset_local_state.sh (which would otherwise
delete the only copy).

How it decides
--------------
Every ignored path is classified by the .gitignore RULE that matches it, never
by guessing from its name:

  GENERATED  rebuilt by the installer or tooling - safe to delete
  PERSONAL   local notes, logs, keys, session artefacts - never deleted
  AMBIGUOUS  generic names that collide with real source dirs (`env/`, `build/`)

An AMBIGUOUS match containing a source file fails the gate (a genuine venv,
marked by pyvenv.cfg, is GENERATED). A rule this file does not know fails the
gate too, so adding a .gitignore rule forces a decision about which class it is.

Usage:
  python3 check_no_ignored_source.py              gate (exit 0 clean, 1 defect)
  python3 check_no_ignored_source.py --manifest   CLASS<TAB>path<TAB>rule per
                                                  entry, for the reset script
  python3 check_no_ignored_source.py --compare-clone <dir>
        the decisive fresh-clone check: the file list of this checkout, minus
        PERSONAL paths (nothing an install runs reads them), must equal the
        file list of <dir>, a fresh `git clone` of the same branch
"""
from __future__ import annotations

import os
import subprocess
import sys

GENERATED = {
    "__pycache__/", "*.py[cod]", "*$py.class", "*.so", ".Python",
    ".DS_Store", "node_modules/", "tsconfig.tsbuildinfo", "dist/",
    "dist-server/", "*.egg-info/", "**/.next/", ".next/", "out/", "venv/",
    ".venv/", "*.swp", "*.swo", "/Native_app/output",
    "playwright-report/", "test-results/",
    "**/_installed/**/install.sql", "**/_installed/**/install.json",
    "**/_installed/**/runtime.js", "**/_installed/**/server.js",
    "**/_installed/**/package.json", "**/_installed/**/.claude-plugin/",
}
# `*.log` is PERSONAL: inside the repo it only ever matches dated run histories
# under logs/ (the installer writes its own logs to /tmp, cleared separately).
PERSONAL = {
    "*.log", "**/logs/*.md", "/logs/sa_regression/", ".env", ".env.local", "*.p8",
    "*.pem", "rsa_key*", ".idea/", ".vscode/", ".snowflake/cortex/plans/",
    "drafts/FINAL.md", "drafts/PLAN.md", "drafts/v1-critique.md",
    "drafts/v1.md", "drafts/v2-critique.md", "drafts/v2.md", "/docs/blogpost",
    "/docs/old", "benchmarks/matrix-access/results/blogpost-blurb.md", "/tmp",
    ".cortex/skills/evals/results/agent/",
}
AMBIGUOUS = {"env/", "build/"}

SOURCE_EXT = (".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx",
              ".sql", ".py", ".sh", ".yaml", ".yml", ".json", ".css")


def git(*args: str, stdin: str | None = None) -> str:
    return subprocess.run(["git", *args], input=stdin, capture_output=True,
                          text=True, check=False).stdout


def rules_for(paths: list[str]) -> dict[str, str]:
    """path -> matching pattern ('' when the path itself matches no rule)."""
    out: dict[str, str] = {}
    if not paths:
        return out
    for line in git("check-ignore", "-v", "-n", "--stdin",
                    stdin="\n".join(paths) + "\n").splitlines():
        meta, _, path = line.partition("\t")
        # meta is "<source>:<linenum>:<pattern>"; the pattern may contain ':'
        parts = meta.split(":", 2)
        out[path] = parts[2] if len(parts) == 3 else ""
    return out


def walk_files(d: str) -> list[str]:
    files = []
    for root, _dirs, names in os.walk(d):
        files.extend(os.path.join(root, n) for n in names)
    return sorted(files)


def children(d: str) -> list[str]:
    """Direct children of d, directories with a trailing '/' like git prints."""
    with os.scandir(d) as it:
        return sorted(e.path + "/" if e.is_dir(follow_symlinks=False) else e.path
                      for e in it)


def classify() -> list[tuple[str, str, str]]:
    # `--directory` lists nested entries (`.snowflake/`, `.snowflake/cortex/`,
    # `.snowflake/cortex/plans/`). Expand an unruled directory ONE level at a
    # time and dedupe, so a directory that carries its own rule is classified
    # as a unit and never also walked into - each path is reported exactly once.
    pending = git("ls-files", "-o", "-i", "--exclude-standard",
                  "--directory").splitlines()
    result: list[tuple[str, str, str]] = []
    seen: set[str] = set()
    while pending:
        pending = [p for p in dict.fromkeys(pending) if p not in seen]
        seen.update(pending)
        rules = rules_for(pending)
        expand: list[str] = []
        for p in pending:
            rule = rules.get(p, "")
            if not rule:
                if p.endswith("/") and os.path.isdir(p):
                    # Listed only because every child is ignored: classify children.
                    expand.extend(children(p.rstrip("/")))
                else:
                    result.append(("UNKNOWN", p, "(no rule reported)"))
                continue
            if rule in GENERATED:
                cls = "GENERATED"
            elif rule in PERSONAL:
                cls = "PERSONAL"
            elif rule in AMBIGUOUS:
                cls = "AMBIGUOUS"
            else:
                cls = "UNKNOWN"
            result.append((cls, p, rule))
        pending = expand
    return result


def ambiguous_source(path: str) -> list[str]:
    """Source files under an AMBIGUOUS match; [] for a genuine virtualenv."""
    if os.path.isdir(path):
        if os.path.exists(os.path.join(path, "pyvenv.cfg")):
            return []
        files = walk_files(path.rstrip("/"))
    else:
        files = [path]
    return [f for f in files if f.endswith(SOURCE_EXT)]


def file_list(root: str, skip: list[str]) -> set[str]:
    """Every file under root (relative, '/'-separated), minus .git and skip."""
    out: set[str] = set()
    for d, dirs, names in os.walk(root):
        rel_d = os.path.relpath(d, root)
        rel_d = "" if rel_d == "." else rel_d + "/"
        dirs[:] = [x for x in dirs if not (rel_d == "" and x == ".git")
                   and not any((rel_d + x + "/").startswith(s) for s in skip)]
        for n in names:
            rel = rel_d + n
            if not any(rel == s.rstrip("/") or rel.startswith(s) for s in skip):
                out.add(rel)
    return out


def compare_clone(clone: str, resolved: list[tuple[str, str, str]]) -> int:
    personal = [p for cls, p, _r in resolved if cls == "PERSONAL"]
    here, there = file_list(".", personal), file_list(clone, [])
    extra, missing = sorted(here - there), sorted(there - here)
    if not extra and not missing:
        print(f"check_no_ignored_source: IDENTICAL to the fresh clone ({len(here)} "
              f"files; {len(personal)} personal entries not compared)")
        return 0
    print("check_no_ignored_source: checkout DIFFERS from the fresh clone")
    for tag, paths in (("only here", extra), ("only in clone", missing)):
        for p in paths[:40]:
            print(f"  {tag}: {p}")
        if len(paths) > 40:
            print(f"  {tag}: ... {len(paths) - 40} more")
    return 1


def main() -> int:
    clone_dir = None
    if "--compare-clone" in sys.argv[1:]:
        i = sys.argv.index("--compare-clone")
        if i + 1 >= len(sys.argv) or not os.path.isdir(sys.argv[i + 1]):
            print("check_no_ignored_source: --compare-clone needs a clone directory")
            return 2
        clone_dir = os.path.abspath(sys.argv[i + 1])  # before the chdir below
    os.chdir(git("rev-parse", "--show-toplevel").strip() or ".")
    entries = classify()
    defects: list[str] = []
    resolved: list[tuple[str, str, str]] = []
    for cls, path, rule in entries:
        if cls == "AMBIGUOUS":
            src = ambiguous_source(path)
            if src:
                defects.extend(f"  {f}\n      swallowed by .gitignore rule '{rule}'"
                               for f in src)
                cls = "SOURCE"
            else:
                cls = "GENERATED"
        elif cls == "UNKNOWN":
            defects.append(f"  {path}\n      matched by unclassified rule '{rule}' -"
                           " add it to GENERATED or PERSONAL in this script")
        resolved.append((cls, path, rule))

    if "--manifest" in sys.argv[1:]:
        for cls, path, rule in resolved:
            print(f"{cls}\t{path}\t{rule}")
        return 1 if defects else 0

    if clone_dir:
        return compare_clone(clone_dir, resolved)

    if defects:
        print("check_no_ignored_source: FAILED - these files exist only on this"
              " machine; a fresh clone does not have them:")
        print("\n".join(defects))
        print("Fix: track the file and add a scoped '!<dir>/' + '!<dir>/**'"
              " un-ignore to .gitignore (see the synapse src/build/ precedent),"
              " or classify the rule above.")
        return 1
    counts: dict[str, int] = {}
    for cls, _p, _r in resolved:
        counts[cls] = counts.get(cls, 0) + 1
    print("check_no_ignored_source: OK - no source is hidden by .gitignore "
          f"({', '.join(f'{k}={v}' for k, v in sorted(counts.items()))} entries)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
