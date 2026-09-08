#!/usr/bin/env python3
"""Guard: no contract view may be scoped to ONE region by a singleton CONFIG row,
and no semantic view over a multi-region fact may omit a region dimension.

Why this needs a static gate: every failure in this class is SILENT. A view
filtered to one region returns rows, compiles, passes every does-it-exist probe,
and renders a populated panel. Nothing distinguishes "this region has no data"
from "this region was excluded before the first aggregate".

The original defect. Each domain layer filtered on a per-schema CONFIG table that
holds exactly ONE row:

    WHERE t.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.<X>.CONFIG LIMIT 1)

So a CoWork question about San Francisco dwell density was answered "there is no
San Francisco data" while 15,091 San Francisco sessions sat in the view. Three
properties made it worse than a stale filter:

  1. CONFIG is WRITABLE AT RUNTIME - the /api/region promote path and the ops verb
     set_active_context, which an AGENT can call - so the same question returned
     different data at different times.
  2. Three writers carried three different schema lists (8 vs 3 vs 3), so the
     CONFIG tables drifted apart and a cross-domain question silently mixed San
     Francisco e-bikes with European trucks.
  3. A semantic view cannot pass a function argument, so the F_*_SCOPED scope-arg
     migration could never fix the agent path. Region has to be a DIMENSION.

Three rules, each mapping to one observed failure:

  RULE 1 (config-scoped view): a CREATE VIEW / CREATE FUNCTION body in an install
          artifact must not filter on `... CONFIG LIMIT 1`. Reading CONFIG to
          EXPOSE the active context is fine (that is what it is for now) - the
          allowlist below names those.

  RULE 2 (region dimension): a semantic view whose base tables are multi-region
          must declare a region dimension, or Cortex Analyst cannot filter it and
          an unfiltered aggregate silently merges regions.

  RULE 3 (spoken place name): a semantic view exposing region must also expose a
          readable LABEL. Region keys are CamelCase identifiers, so a filter on
          the phrase a person types - region = 'San Francisco' - matches NOTHING
          against 'SanFrancisco'. This is the rule that closes the original bug.

Usage:
    python3 .cortex/skills/install-fleet-apps/scripts/check_region_scoping.py

Exit 0 = clean, 1 = a violation.
"""
from __future__ import annotations

import pathlib
import re
import sys

SKILL_DIR = pathlib.Path(__file__).resolve().parents[1]
APP_DIR = SKILL_DIR / "fleet_sa_app" / "app"

# ---------------------------------------------------------------------------
# RULE 1 - no CONFIG-singleton filter inside a view/function body.
# ---------------------------------------------------------------------------
# Files a fresh install consumes. The pack setup.sql files are GENERATED, so the
# authoring surfaces (data-model.yaml / entity-mapping.yaml) are scanned too -
# checking only the generated output would report a violation at a path nobody is
# supposed to edit.
RULE1_GLOBS = [
    (SKILL_DIR / "scripts", "*.sql"),
    (APP_DIR, "*.sql"),
    (APP_DIR / "packs", "**/*.yaml"),
    (APP_DIR / "packs", "**/setup.sql"),
    (SKILL_DIR / "fleet_admin_app" / "ui" / "src" / "server", "**/*.ts"),
]

# A filter predicate: something is compared to a scalar read of CONFIG.
# Deliberately NOT just "CONFIG LIMIT 1" - a bare read is legal (see allowlist).
CONFIG_FILTER = re.compile(
    r"""(?:=|IN)\s*\(\s*SELECT\s+[A-Z_]+\s+FROM\s+"""
    r"""(?:FLEET_INTELLIGENCE\.[A-Z_]+|\{schema\})\.(?:VW_)?CONFIG\s+LIMIT\s+1""",
    re.IGNORECASE | re.VERBOSE,
)
# The `WITH cfg AS (SELECT ... FROM ...CONFIG LIMIT 1)` shape, then joined. Same
# defect, different spelling - this is how the asset-velocity views did it.
CONFIG_CTE = re.compile(
    r"""[A-Z_]+\s+AS\s*\(\s*SELECT\s+[A-Z_,\s]+\s+FROM\s+"""
    r"""(?:FLEET_INTELLIGENCE\.[A-Z_]+|\{schema\})\.(?:VW_)?CONFIG\s+LIMIT\s+1\s*\)""",
    re.IGNORECASE | re.VERBOSE,
)

# Legal readers of CONFIG. These EXPOSE the active context (the app's context bar
# preselection, the deployment-facts report, the ops verb that WRITES it, and the
# realigner). None of them filters analytic data by it.
RULE1_ALLOW_FILES = {
    "deployment_facts.sql",       # reports the active context
    "region.ts",                  # currentRegionScalar helper, deprecated + documented
    "fleet-config/route.ts",      # admin app reads the context bar default
    "route.ts",                   # SA app /api/region GET reads it
    "useRegion.ts",               # client hook reads it
    "set_active_context.ts",      # the WRITER
    "drop_region.ts",             # refuses to drop the ACTIVE region
}
# Procedural reads (`SELECT REGION INTO rg FROM ...CONFIG LIMIT 1`) inside an
# ingest proc choose WHICH region to ingest. That is a legitimate parameter, not
# a consumer filter, and the shape is distinct enough to exempt by pattern.
PROCEDURAL_READ = re.compile(r"SELECT\s+REGION\s+INTO\s+", re.IGNORECASE)


def _iter_files():
    seen = set()
    for base, pattern in RULE1_GLOBS:
        if not base.exists():
            continue
        for p in base.glob(pattern):
            if p.is_file() and p not in seen:
                seen.add(p)
                yield p


def check_rule1() -> list[str]:
    problems: list[str] = []
    for path in _iter_files():
        if path.name in RULE1_ALLOW_FILES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for rx, label in ((CONFIG_FILTER, "CONFIG-singleton filter"),
                          (CONFIG_CTE, "CONFIG-singleton CTE")):
            for m in rx.finditer(text):
                line = text[: m.start()].count("\n") + 1
                # Skip prose: a comment line explaining the defect is not the defect.
                line_text = text.splitlines()[line - 1].lstrip()
                if line_text.startswith(("--", "#", "//", "*")):
                    continue
                if PROCEDURAL_READ.search(text[max(0, m.start() - 80): m.start() + 40]):
                    continue
                rel = path.relative_to(SKILL_DIR.parents[2])
                problems.append(
                    f"{rel}:{line}: {label} - this pins the layer to ONE region.\n"
                    f"    Carry REGION as a dimension and let the consumer filter "
                    f"(scope arg for the app, WHERE for Cortex Analyst)."
                )
    return problems


# ---------------------------------------------------------------------------
# RULES 2 + 3 - semantic views must model region, and a readable label.
# ---------------------------------------------------------------------------
SV_FILE = APP_DIR / "semantic_views.sql"
SV_SPLIT = re.compile(r"CREATE\s+OR\s+REPLACE\s+SEMANTIC\s+VIEW\s+([A-Z0-9_.]+)", re.IGNORECASE)

# Semantic views over facts that are single-region BY NATURE (a catchment POI set,
# a procedural hazard grid, an estate) rather than by a hidden filter. Each must
# say why, so adding a name here is a deliberate act.
SV_EXEMPT = {
    "SV_CATCHMENT": "POI/city fact - already carries city + state as dimensions",
    "SV_EMERGENCY_RESPONSE": "procedural hazard grid seeded per region at request time",
    "SV_LOCATION": "store estate keyed by ZIP; carries zip + store geography",
    "SV_SOURCING": "plant/customer estate keyed by site, not region",
    "SV_DELIVERY_SYNC": "site visits carry SITE_ID + REGION on the base view",
    "SV_FLEET_DEPLOYMENT": "ops/installer history; region is an ORS host attribute",
}
REGION_DIM = re.compile(r"\.\s*region\s+AS\s+REGION\b", re.IGNORECASE)
LABEL_DIM = re.compile(r"\.\s*(?:region_label|city)\s+AS\s+(?:REGION_LABEL|CITY)\b", re.IGNORECASE)


def check_semantic_views() -> list[str]:
    problems: list[str] = []
    if not SV_FILE.exists():
        return [f"{SV_FILE} not found"]
    text = SV_FILE.read_text(encoding="utf-8")
    marks = [(m.start(), m.group(1)) for m in SV_SPLIT.finditer(text)]
    for i, (pos, fqn) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(text)
        body = text[pos:end]
        name = fqn.rsplit(".", 1)[-1].upper()
        if name in SV_EXEMPT:
            continue
        rel = SV_FILE.relative_to(SKILL_DIR.parents[2])
        line = text[:pos].count("\n") + 1
        if not REGION_DIM.search(body):
            problems.append(
                f"{rel}:{line}: {name} has no `region AS REGION` dimension.\n"
                f"    Its facts hold every loaded region, so an unfiltered aggregate "
                f"MERGES regions and Cortex Analyst cannot filter them apart.\n"
                f"    Add the dimension, or add {name} to SV_EXEMPT with a reason."
            )
        elif not LABEL_DIM.search(body):
            problems.append(
                f"{rel}:{line}: {name} exposes region but no readable label "
                f"(`region_label AS REGION_LABEL` or `city AS CITY`).\n"
                f"    Region keys are CamelCase, so a filter on the phrase a person "
                f"types - region = 'San Francisco' - matches NOTHING against "
                f"'SanFrancisco'.\n"
                f"    Project FLEET_APP.CORE.REGION_LABEL(REGION) and model it."
            )
    return problems


def main() -> int:
    problems = check_rule1() + check_semantic_views()
    if problems:
        print("check_region_scoping: FAILED\n")
        for p in problems:
            print(f"  {p}\n")
        print(f"{len(problems)} violation(s).")
        print("Background: .cortex/skills/install-fleet-apps/scripts/check_region_scoping.py")
        return 1
    print("check_region_scoping: OK (no CONFIG-scoped views; semantic views model region + label)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
