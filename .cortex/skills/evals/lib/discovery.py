"""Which SKILL.md files the skill evals are allowed to score.

WHY THIS EXISTS
---------------
Four eval modules each did their own `Path(root).rglob("SKILL.md")` with a single
`"evals" in parts` exclusion. That walk cannot tell an AUTHORED Cortex Code skill
from a GENERATED deployment artifact, and the repo contains 26 of the latter:
`install-fleet-apps/fleet_sa_app/app/cowork_skills/<view>/SKILL.md`, emitted by
build_cowork_skills.py for Cortex Agents to read off a stage.

They are a different contract. Their folder names are the snake_case view ids that
check_cowork_surfaces.py RULE E matches against the agent spec's stage paths, and
they have no "error handling" section because they are not runbooks. So they could
never satisfy the authoring rules, and the effect was:

  quality  19/44 - the 25 failures were ALL CoWork artifacts; every authored
                   skill in scope passed. A permanently red gate is a gate nobody
                   reads, and a real regression would have hidden in the noise.
  xref/sql 44/44 - they pass trivially and inflate the denominator from 18 to 44,
                   overstating coverage 2.4x.

One artifact scored 13/13, which is the clearest sign these checks do not apply:
a generated file accidentally satisfying rules about kebab-case folder names.

EXCLUDE BY PATH, NOT BY NAME
----------------------------
config.yaml already has `exclude_skills` for retired skills, matched by name. It is
the wrong tool here: 26 names go stale the moment a view is added, and the list
would have to be regenerated alongside the artifacts it names. A path pattern
covers the whole generated tree, present and future.

THE FLOOR IS THE POINT
----------------------
An over-broad pattern would silently drop real skills and print a healthy
"18/18 pass" - strictly worse than the noise it replaced, because it fails green.
So `min_authored_skills` is a hard floor: if discovery finds fewer than that, the
exclusion is wrong and the run aborts rather than reporting success.
"""

from __future__ import annotations

import fnmatch
import sys
from pathlib import Path

import yaml

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.yaml"

# Fallbacks if config.yaml carries neither key, so discovery still excludes the
# known generated tree rather than silently reverting to the polluted walk.
DEFAULT_EXCLUDE_PATHS = ["**/cowork_skills/**"]
DEFAULT_MIN_AUTHORED = 1

_announced = False


def _config() -> dict:
    try:
        return yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        return {}


def discover_skill_files(skills_root: str, announce: bool = True) -> list[Path]:
    """Every authored SKILL.md under `skills_root`, sorted.

    Excludes the evals tree itself (pre-existing behaviour) and anything matching
    a `exclude_paths` pattern from config.yaml. Aborts if the result falls below
    `min_authored_skills` - see THE FLOOR IS THE POINT above.
    """
    global _announced
    cfg = _config()
    # ABSENT falls back to the default; an explicitly EMPTY list is honoured as
    # "exclude nothing". `cfg.get(key) or DEFAULT` conflated the two, so setting
    # `exclude_paths: []` silently kept the default exclusion - the config said
    # one thing and the run did another, which is the same silent-override class
    # of defect this whole gate exists to catch.
    patterns = cfg["exclude_paths"] if "exclude_paths" in cfg else DEFAULT_EXCLUDE_PATHS
    patterns = patterns or []
    floor = cfg.get("min_authored_skills") or DEFAULT_MIN_AUTHORED

    root = Path(skills_root)
    every = sorted(p for p in root.rglob("SKILL.md") if "evals" not in p.parts)

    kept: list[Path] = []
    excluded: list[Path] = []
    for path in every:
        # fnmatch over the repo-relative POSIX path, NOT PurePath.match: that
        # method does not treat `**` as a recursive wildcard (it behaves like a
        # single `*` segment before Python 3.13), so `**/cowork_skills/**`
        # silently matched NOTHING and discovery reported "0 excluded" while
        # every artifact stayed in scope. fnmatch's `*` crosses `/`, which is
        # what the pattern reads as.
        rel = path.relative_to(root).as_posix()
        if any(fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(path.as_posix(), pat)
               for pat in patterns):
            excluded.append(path)
        else:
            kept.append(path)

    if len(kept) < floor:
        print(
            f"FAIL: skill discovery found only {len(kept)} authored skill(s), "
            f"below the floor of {floor}. An exclude_paths pattern in "
            f"{CONFIG_PATH.name} is too broad - it is swallowing real skills, "
            f"which would make these evals pass while checking almost nothing.\n"
            f"       patterns: {patterns}\n"
            f"       excluded: {len(excluded)} file(s)",
            file=sys.stderr,
        )
        raise SystemExit(1)

    if announce and not _announced:
        _announced = True
        print(
            f"(skill discovery: {len(kept)} authored skill(s); "
            f"{len(excluded)} generated artifact(s) excluded by path)"
        )

    return kept
