#!/usr/bin/env python3
"""Negative tests for lib/discovery.py (the skill-eval discovery floor).

A floor that was set on one machine and fails on every other is the defect this
guards: discovery used to `rglob` the disk, so two SKILL.md files inside
node_modules/playwright-core counted as authored skills on the developer machine
(23) while a fresh clone found the real 21 and aborted. Each case below builds a
throwaway git repo and asserts discovery sees exactly the committed skills:

  1. an ignored SKILL.md (node_modules)      -> not counted
  2. an untracked SKILL.md                   -> not counted
  3. a tracked generated cowork_skills file  -> excluded by path
  4. a floor above the committed count       -> aborts (SystemExit)
  5. outside a git checkout                  -> dependency trees still skipped

Reverting discovery to a plain disk walk fails cases 1 and 2.
"""
from __future__ import annotations

import pathlib
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from lib import discovery  # noqa: E402

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {name}{(' - ' + detail) if detail and not ok else ''}")
    if not ok:
        failures.append(name)


def skill(root: pathlib.Path, rel: str) -> None:
    p = root / rel / "SKILL.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("---\nname: x\n---\n")


def run(root: pathlib.Path, floor: int) -> list[str] | None:
    cfg = root.parent / f"config_{floor}.yaml"
    cfg.write_text(f'exclude_paths:\n  - "**/cowork_skills/**"\nmin_authored_skills: {floor}\n')
    discovery.CONFIG_PATH = cfg
    discovery._announced = True  # keep the output to this driver's lines
    try:
        return [p.relative_to(root).parent.as_posix()
                for p in discovery.discover_skill_files(str(root), announce=False)]
    except SystemExit:
        return None


with tempfile.TemporaryDirectory() as tmp:
    repo = pathlib.Path(tmp) / "repo"
    skills = repo / "skills"
    for rel in ("alpha", "beta", "x/cowork_skills/view_a"):
        skill(skills, rel)
    (repo / ".gitignore").write_text("node_modules/\n")
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
    # Added AFTER staging: present on disk, never committed.
    skill(skills, "ui/node_modules/playwright-core/lib/tools/trace")
    skill(skills, "gamma_untracked")

    got = run(skills, 2)
    check("ignored node_modules SKILL.md is not counted",
          got is not None and not any("node_modules" in g for g in got), str(got))
    check("untracked SKILL.md is not counted",
          got is not None and "gamma_untracked" not in got, str(got))
    check("tracked cowork_skills artifact is excluded by path",
          got is not None and not any("cowork_skills" in g for g in got), str(got))
    check("exactly the two committed authored skills are found",
          got == ["alpha", "beta"], str(got))
    check("a floor above the committed count aborts", run(skills, 3) is None)

    plain = pathlib.Path(tmp) / "plain" / "skills"
    skill(plain, "alpha")
    skill(plain, "ui/node_modules/pkg")
    got = run(plain, 1)
    check("outside git, dependency trees are still skipped", got == ["alpha"], str(got))

if failures:
    print(f"FAIL: {len(failures)} discovery negative case(s) not convicted")
    sys.exit(1)
print("OK: discovery counts only committed skills (6 cases)")
