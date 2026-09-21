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
# Repo root, ASSERTED rather than assumed. An off-by-one here makes every glob
# below match nothing and the whole gate pass while inspecting zero files - a
# failure this repo has already shipped once.
REPO_ROOT = SKILL_DIR.parents[2]
if not (REPO_ROOT / "AGENTS.md").is_file():
    raise SystemExit(
        f"check_region_scoping: REPO_ROOT resolved to {REPO_ROOT}, which has no "
        f"AGENTS.md - the parents[] index is wrong and every rule below would "
        f"inspect nothing."
    )

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

# The demo skills' reference SQL, scanned under a NARROWER rule (see
# TWIN_ONLY_GLOBS). These files were not scanned at all, which is exactly how
# FLEET_INTELLIGENCE.BACKLOAD_MATCHING kept its CONFIG pin while the parallel
# FLEET_APP contract views of the SAME NAMES were de-scoped - two layers with
# opposite region semantics, neither of which the gate could see.
#
# They are NOT held to the full RULE 1 because these are legacy per-vehicle demo
# skills carrying 42 pre-existing pins, most of them in seed loaders where a
# CONFIG read legitimately chooses which region to INGEST. Failing the commit on
# that backlog would gate nothing and block everything. The hazard worth catching
# here is specifically DIVERGENCE FROM A TWIN: a physical view that shares its
# name with a de-scoped contract view, because then one name means two different
# region semantics depending on which schema you happen to read.
TWIN_ONLY_GLOBS = [
    (SKILL_DIR.parent, "*/references/*.sql"),
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

# KNOWN, ACCEPTED divergences. Unlike RULE1_ALLOW_FILES above (files that only
# EXPOSE the active context), these really do filter analytic data by CONFIG.
# They are recorded rather than fixed because the migration is not free, so each
# entry must state the cost and what it does NOT break.
RULE1_KNOWN_DIVERGENCE = {
    # 3 base views + 6 derived cockpit views (candidates, scoring, leg-1,
    # triangles), each defined TWICE - here and in fleet_admin_app init.ts, which
    # is the runtime owner. De-scoping means re-deriving every per-region
    # computation (the home_anchor AVG, the internal pool-cap QUALIFY, and the
    # candidate/triangle self-joins plus their scoring) in both places at once.
    #
    # Not fixed because it breaks nothing today: Backload Proposals and Triangle
    # Proposals read these views AND display the region from the same CONFIG row,
    # so they are self-consistent. The bug this gate exists for was in the
    # PARALLEL FLEET_APP contract views, which are de-scoped, and in the
    # Backload Matching page that read them with no region predicate (RULE 4).
    #
    # What it still costs: the app's region selector can disagree with CONFIG, in
    # which case these two pages show the CONFIG region's data. Removing this
    # entry is the deliberate act that starts the migration.
    "bootstrap.sql": "FLEET_INTELLIGENCE.BACKLOAD_MATCHING base views - see note above",
    "proposals-schema.sql": "FLEET_INTELLIGENCE.BACKLOAD_MATCHING cockpit views - see note above",
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


def _iter_twin_files():
    seen = set()
    for base, pattern in TWIN_ONLY_GLOBS:
        if not base.exists():
            continue
        for p in base.glob(pattern):
            if p.is_file() and p not in seen:
                seen.add(p)
                yield p


CREATE_VIEW = re.compile(r"CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([A-Z0-9_.]+)", re.IGNORECASE)


def _enclosing_view(text: str, pos: int) -> str | None:
    """Name of the view whose body contains `pos`, or None."""
    last = None
    for m in CREATE_VIEW.finditer(text, 0, pos):
        last = m
    if last is None:
        return None
    return last.group(1).rsplit(".", 1)[-1].upper()


def check_rule1() -> list[str]:
    problems: list[str] = []
    for path in _iter_files():
        if path.name in RULE1_ALLOW_FILES or path.name in RULE1_KNOWN_DIVERGENCE:
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


# ---------------------------------------------------------------------------
# RULE 4 - an app read of a MULTI-REGION contract view must bind a region.
# ---------------------------------------------------------------------------
# De-scoping a view moves the filtering responsibility to the consumer, and
# nothing checked that the consumer accepted it. `SELECT * FROM
# FLEET_APP.BACKLOAD_MATCHING.VW_TRAILERS` compiles, returns rows, and renders a
# populated page - it just returns EVERY loaded region. Measured on a two-region
# account: 91 Europe trailers plus 100 San Francisco ones, 332 Europe loads plus
# 5000 San Francisco ones. The page then sliced an unsorted pool and posted 29
# San Francisco coordinates to the Europe road graph, which rejected the matrix
# in 5 ms (ORS 6010, "out of bounds").
#
# Only views that are KNOWN multi-region are checked, by name. A name-based list
# is deliberate: it is the same short list that a de-scope migration edits, so
# adding a view to the contract without listing it here is the one gap left, and
# it is a gap in the direction of a false PASS rather than a false failure.
MULTI_REGION_VIEWS = {
    "VW_TRAILERS",
    "VW_INTERNAL_VOLUMES",
    "VW_EXTERNAL_OFFERS",
}

RULE4_GLOBS = [
    (SKILL_DIR / "fleet_sa_app" / "ui" / "src", "**/*.ts"),
    (SKILL_DIR / "fleet_sa_app" / "ui" / "src", "**/*.tsx"),
]

# A read of one of the views above. `{BM}` / `${BM}` template prefixes are as
# common as a literal FQN in this codebase, so both spellings are matched.
RULE4_READ = re.compile(
    r"""FROM\s+(?:\$\{[A-Za-z_]+\}|FLEET_APP)\.?(?:[A-Z_]+\.)?(""" +
    "|".join(sorted(MULTI_REGION_VIEWS)) +
    r""")\b(?P<tail>[^`;\n]*)""",
    re.IGNORECASE,
)
# Anything that constrains the region: a bound `:region` param, an explicit
# equality, or an IN list.
RULE4_SCOPED = re.compile(r"REGION\s*(?:=|IN)\s*[:(']", re.IGNORECASE)


def check_rule4() -> list[str]:
    problems: list[str] = []
    seen: set[pathlib.Path] = set()
    for base, pattern in RULE4_GLOBS:
        if not base.exists():
            continue
        for path in base.glob(pattern):
            if not path.is_file() or path in seen or "node_modules" in path.parts:
                continue
            seen.add(path)
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            for m in RULE4_READ.finditer(text):
                line = text[: m.start()].count("\n") + 1
                line_text = text.splitlines()[line - 1].lstrip()
                # Prose naming a view is not a read of it.
                if line_text.startswith(("--", "#", "//", "*")):
                    continue
                if RULE4_SCOPED.search(m.group("tail")):
                    continue
                rel = path.relative_to(SKILL_DIR.parents[2])
                problems.append(
                    f"{rel}:{line}: read of multi-region {m.group(1).upper()} with no "
                    f"region predicate.\n"
                    f"    The view carries REGION as a DIMENSION, so this returns every "
                    f"loaded region - which reaches the routing engine as off-graph\n"
                    f"    coordinates and fails the matrix pre-compute (ORS 6010). "
                    f"Add `WHERE REGION = :region` and bind it."
                )
    return problems


# ---------------------------------------------------------------------------
# RULE 1b - a physical view must not disagree with its de-scoped contract twin.
# ---------------------------------------------------------------------------
def check_rule1_twins() -> list[str]:
    problems: list[str] = []
    for path in _iter_twin_files():
        if path.name in RULE1_ALLOW_FILES or path.name in RULE1_KNOWN_DIVERGENCE:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for rx, label in ((CONFIG_FILTER, "CONFIG-singleton filter"),
                          (CONFIG_CTE, "CONFIG-singleton CTE")):
            for m in rx.finditer(text):
                view = _enclosing_view(text, m.start())
                if view not in MULTI_REGION_VIEWS:
                    continue
                line = text[: m.start()].count("\n") + 1
                line_text = text.splitlines()[line - 1].lstrip()
                if line_text.startswith(("--", "#", "//", "*")):
                    continue
                rel = path.relative_to(SKILL_DIR.parents[2])
                problems.append(
                    f"{rel}:{line}: {view} carries a {label}, but a contract view of the "
                    f"SAME NAME is de-scoped (multi-region).\n"
                    f"    One name now means two different region semantics depending on "
                    f"which schema is read, which is how a Europe page\n"
                    f"    loaded San Francisco rows. De-scope it too, or add "
                    f"{path.name} to RULE1_KNOWN_DIVERGENCE with the cost written down."
                )
    return problems


# ---------------------------------------------------------------------------
# RULE 5 - a JS proc that KNOWS the region must not resolve the vehicle class
#          from the CONFIG singleton unconditionally.
#
# RULE 1 covers CREATE VIEW / CREATE FUNCTION bodies. Stored procedures are not
# view bodies, so they were outside every glob it uses - and that is exactly
# where the defect survived: TOOL_BACKLOAD_SOLVE accepted P_REGION, scoped all
# three of its feeds with it, and then resolved vehicle_type from
# `SELECT VEHICLE_TYPE FROM ...VW_CONFIG LIMIT 1`. CONFIG holds ONE row, so a
# SanFrancisco solve over 100 ebikes reported hgv, resolved the driving-hgv
# profile and priced the objective at 0.85/km instead of 0.08/km. Nothing threw.
#
# The rule is deliberately not "never read CONFIG": as a documented FALLBACK it
# is correct, and that is what the code does now. What must hold is ORDER - the
# region-scoped resolution has to come FIRST, so CONFIG can only be reached when
# the region genuinely yields nothing. Asserting mere co-presence would pass on
# the original defect if someone bolted a region read on afterwards, which is
# the shape mutation M-A2 in the negative tests.
# ---------------------------------------------------------------------------
RULE5_GLOBS = [
    (REPO_ROOT / ".cortex" / "skills", "**/*.sql"),
]

# Start of a stored procedure and the body delimiters used throughout this repo.
PROC_START = re.compile(r"^CREATE\s+OR\s+REPLACE\s+PROCEDURE\s+([A-Za-z0-9_.]+)\s*\(",
                        re.IGNORECASE | re.MULTILINE)

# An unconditional read of the vehicle type off the CONFIG singleton.
RULE5_CONFIG_VT = re.compile(
    r"SELECT\s+VEHICLE_TYPE\s+FROM\s+[A-Za-z0-9_.${}]*CONFIG\s+LIMIT\s+1",
    re.IGNORECASE)

# A resolution keyed on the region: any read that both selects the vehicle type
# (VEHICLE_TYPE or its VW_TRAILERS spelling CURRENT_LOAD) and constrains REGION.
RULE5_REGION_VT = re.compile(
    r"(?:CURRENT_LOAD|VEHICLE_TYPE)[\s\S]{0,400}?WHERE\s+REGION\s*=\s*\?",
    re.IGNORECASE)


def _proc_bodies(text: str):
    """Yield (proc_name, body_text, body_offset) for each JS proc in a file."""
    lines = text.split("\n")
    starts = [i for i, l in enumerate(lines)
              if re.match(r"^CREATE\s+OR\s+REPLACE\s+PROCEDURE\s", l, re.IGNORECASE)]
    for s in starts:
        try:
            a = next(i for i in range(s, len(lines)) if lines[i].strip() == "$$")
            b = next(i for i in range(a + 1, len(lines)) if lines[i].strip() == "$$;")
        except StopIteration:
            continue
        name = lines[s].split("(")[0].split()[-1]
        yield name, "\n".join(lines[a + 1:b]), a + 2


def check_rule5() -> tuple[list[str], int, int]:
    """Returns (problems, procs_seen, procs_in_scope).

    procs_seen counts EVERY JavaScript stored procedure the globs found, and it
    is what the vacuity counter checks. Counting only the in-scope ones (those
    taking a region argument) conflates a broken glob with a tree where no proc
    happens to take a region - the negative harness proved that by renaming the
    argument and getting a vacuity failure instead of a clean pass.
    """
    problems: list[str] = []
    seen = 0
    inspected = 0
    for base, pattern in RULE5_GLOBS:
        if not base.exists():
            continue
        for path in sorted(base.glob(pattern)):
            if not path.is_file() or "node_modules" in path.parts:
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            if "LANGUAGE JAVASCRIPT" not in text.upper():
                continue
            for name, body, first_line in _proc_bodies(text):
                seen += 1
                # Only procs that KNOW the region. A proc with no region argument
                # has nothing better than CONFIG to read, so it is out of scope.
                if "P_REGION" not in body:
                    continue
                inspected += 1
                cfg = RULE5_CONFIG_VT.search(body)
                if not cfg:
                    continue
                reg = RULE5_REGION_VT.search(body)
                rel = path.relative_to(REPO_ROOT)
                line = first_line + body[: cfg.start()].count("\n")
                if not reg:
                    problems.append(
                        f"{rel}:{line}: {name} takes P_REGION but resolves the vehicle "
                        f"type from the CONFIG singleton only.\n"
                        f"    CONFIG holds ONE row, so this describes the wrong fleet for "
                        f"every other region - silently: the class lookup\n"
                        f"    succeeds and the solve returns. Resolve it from the region "
                        f"being solved (VW_TRAILERS ... WHERE REGION = ?) and keep\n"
                        f"    CONFIG as the fallback."
                    )
                elif reg.start() > cfg.start():
                    problems.append(
                        f"{rel}:{line}: {name} reads the CONFIG singleton BEFORE its "
                        f"region-scoped vehicle-type read.\n"
                        f"    Order is the whole rule: CONFIG must only be reachable when "
                        f"the region yields nothing. As written, the singleton\n"
                        f"    still wins and the region read is dead code."
                    )
    return problems, seen, inspected


# ---------------------------------------------------------------------------
# RULE 6 - SOURCE is a channel, not provenance.
#
# The external offer generator round-robined four channel labels and one of them
# was the literal 'INTERNAL'. Every row it produces is an EXTERNAL offer
# (IS_INTERNAL=FALSE in VW_LOADS), so a quarter of the external pool - measured
# 75 rows of 300 - claimed to be internal in the one column consumers reached
# for. Nothing was malformed, so nothing failed; the badge coloured wrong and
# the internal_matched figure published to the agent memo over-counted by
# exactly those rows.
#
# Two halves, because fixing either alone leaves the defect reachable: the
# vocabulary must not contain the token, AND no consumer may read provenance out
# of the channel column.
# ---------------------------------------------------------------------------
RULE6_GLOBS = [
    (REPO_ROOT / ".cortex" / "skills", "**/*.ts"),
    (REPO_ROOT / ".cortex" / "skills", "**/*.tsx"),
]

# `a.SOURCE === 'INTERNAL'` and friends. The column half is matched
# CASE-SENSITIVELY on purpose: query rows are upper-keyed, so `row.SOURCE` is the
# data column, while a lowercase `filters.source === 'internal'` is a UI filter
# TOKEN compared against a select value - a different thing that happens to share
# the word. Case-folding both halves produced exactly that false positive on
# backload-proposals.tsx, whose row test already reads p.isInternal. The literal
# is still matched either way, since only the left side disambiguates.
# DECISION_SOURCE is deliberately NOT matched: on PROPOSAL_DECISIONS the value
# INTERNAL is the reserved provenance token for the own-fleet pool, which is
# legitimate - hence the negative lookbehind covering an underscore-joined name.
RULE6_COMPARE = re.compile(
    r"(?<![A-Za-z_])SOURCE\s*(?:===|==|!==|!=)\s*['\"][Ii][Nn][Tt][Ee][Rr][Nn][Aa][Ll]['\"]")

# A source-vocabulary array literal containing the token.
RULE6_VOCAB = re.compile(
    r"(?:SOURCES?|CHANNELS?)\s*(?::\s*[^=]*)?=\s*\[[^\]]*['\"]INTERNAL['\"][^\]]*\]",
    re.IGNORECASE)

# The idempotent repair idiom is the one legal place the token is compared in
# SQL: it exists precisely to remove the value. Anything else in a SQL channel
# vocabulary is a violation.
RULE6_SQL_VOCAB = re.compile(
    r"DECODE\s*\(\s*MOD[^)]*\)[^;]*?['\"]INTERNAL['\"]",
    re.IGNORECASE)
RULE6_SQL_GLOBS = [
    (REPO_ROOT / ".cortex" / "skills", "**/*.sql"),
]


def check_rule6() -> tuple[list[str], int]:
    problems: list[str] = []
    inspected = 0
    for globs, patterns in ((RULE6_GLOBS, ((RULE6_COMPARE, "compare"), (RULE6_VOCAB, "vocab"))),
                            (RULE6_SQL_GLOBS, ((RULE6_SQL_VOCAB, "vocab"),))):
        for base, pattern in globs:
            if not base.exists():
                continue
            for path in sorted(base.glob(pattern)):
                if not path.is_file() or "node_modules" in path.parts:
                    continue
                try:
                    text = path.read_text(encoding="utf-8")
                except (UnicodeDecodeError, OSError):
                    continue
                inspected += 1
                for rx, kind in patterns:
                    for m in rx.finditer(text):
                        line = text[: m.start()].count("\n") + 1
                        line_text = text.splitlines()[line - 1].lstrip()
                        if line_text.startswith(("--", "#", "//", "*")):
                            continue
                        rel = path.relative_to(REPO_ROOT)
                        if kind == "compare":
                            problems.append(
                                f"{rel}:{line}: provenance read out of the SOURCE channel "
                                f"column.\n"
                                f"    SOURCE says HOW a load arrived, not WHETHER it is ours. "
                                f"Use the structural flag (IS_INTERNAL) - it cannot\n"
                                f"    be flipped by a relabelled channel.\n"
                                f"    {line_text[:110]}"
                            )
                        else:
                            problems.append(
                                f"{rel}:{line}: 'INTERNAL' in an EXTERNAL source vocabulary.\n"
                                f"    Every row this vocabulary labels is an external offer, so "
                                f"the token is not merely ambiguous, it is untrue.\n"
                                f"    Use a channel name such as BROKER and carry provenance in "
                                f"IS_INTERNAL.\n"
                                f"    {line_text[:110]}"
                            )
    return problems, inspected


def main() -> int:
    rule5, rule5_seen, rule5_scoped = check_rule5()
    rule6, rule6_seen = check_rule6()
    problems = (
        check_rule1() + check_rule1_twins() + check_semantic_views() + check_rule4()
        + rule5 + rule6
    )
    # Vacuity counters. A rule that inspected nothing is not a rule, and this
    # repo has shipped exactly that failure before (a gate whose repo-root index
    # was one level short silently scanned zero files and passed).
    if rule5_seen == 0:
        problems.append(
            "RULE 5 found ZERO JavaScript stored procedures - the glob or the "
            "$$ body-delimiter detection is broken, not the code."
        )
    if rule6_seen == 0:
        problems.append(
            "RULE 6 inspected ZERO files - the glob is broken, not the code."
        )
    if problems:
        print("check_region_scoping: FAILED\n")
        for p in problems:
            print(f"  {p}\n")
        print(f"{len(problems)} violation(s).")
        print("Background: .cortex/skills/install-fleet-apps/scripts/check_region_scoping.py")
        return 1
    print(
        "check_region_scoping: OK (no CONFIG-scoped views; semantic views model "
        "region + label; app reads of multi-region views are scoped; "
        f"{rule5_scoped} of {rule5_seen} proc(s) are region-aware and resolve their "
        f"vehicle class from the region; "
        f"{rule6_seen} file(s) clean of SOURCE-as-provenance)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
