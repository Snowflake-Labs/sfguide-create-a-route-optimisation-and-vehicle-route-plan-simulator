#!/usr/bin/env python3
"""
build_view_catalog.py - generate the SA deployment catalog SQL from app-views.json.

WHY THIS EXISTS
---------------
Every view in app-views.json carries a `useCase` block (Tenet 10, Channel D) and
an `agentKnowledge` block (Channel C). Until now those blocks were read ONLY by
the SA app's own chat route (ui/src/app/api/chat/route.ts), which prepends the
"[Solution catalog ...]" context to each turn at request time. That makes the
knowledge invisible anywhere the app is not the client - most importantly in
Cowork / Snowflake Intelligence, where the same FLEET_AGENT has no idea the SA
app exists or which use cases this deployment can demonstrate.

This script projects those blocks into a durable Snowflake table
(FLEET_INTELLIGENCE.SEMANTIC.VIEW_CATALOG) plus a Cortex Search service over it,
so the in-app prefix and the agent-side catalog share ONE source of truth:
app-views.json stays authoritative, and the table is a generated artifact.

Neutral display tokens ({{labels.entity}}, {{units.distance}}) are interpolated
from app-config.json's `display` section, mirroring interpolateTokens() in
ui/src/lib/display-config.ts, because a Cowork user never sees the app's runtime
substitution and "{{labels.entity_plural}}" in an answer is a defect.

USAGE
  python3 build_view_catalog.py                  # rewrite view_catalog.sql
  python3 build_view_catalog.py --check          # verify the committed file is current (CI gate)
  python3 build_view_catalog.py --stdout         # print the SQL
  python3 build_view_catalog.py --views <path> --config <path> --out <path>

The generated SQL is idempotent (CREATE OR REPLACE) and carries the standard
tracking COMMENT / query_tag on every object per AGENTS.md.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

SKILL = pathlib.Path(__file__).resolve().parents[1]
APP_DIR = SKILL / "fleet_sa_app" / "app"
DEFAULT_VIEWS = APP_DIR / "app-views.json"
DEFAULT_CONFIG = APP_DIR / "app-config.json"
DEFAULT_OUT = APP_DIR / "view_catalog.sql"

TRACK = (
    '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps",'
    '"version":{"major":1,"minor":0},'
    '"attributes":{"is_quickstart":1,"source":"sql"}}'
)

TOKEN_RE = re.compile(r"\{\{\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s*\}\}")

# Ordered so the prose blob reads like a briefing rather than a field dump.
PROSE_SECTIONS = [
    ("Headline", "headline"),
    ("Business question", "businessQuestion"),
    ("Audience", "audience"),
    ("Industries", "industries"),
    ("Talk track", "talkTrack"),
    ("Snowflake capabilities", "snowflakeCapabilities"),
    ("Data required", "dataRequired"),
    ("Value drivers", "valueDrivers"),
    ("Method", "method"),
    ("Caveats", "caveats"),
]


def interpolate(text, display):
    """Mirror of interpolateTokens() in ui/src/lib/display-config.ts.

    {{group.key}} resolves against a string-map section of the display config;
    unknown tokens are left verbatim so a missing label is visible, not silent.
    """
    if not isinstance(text, str) or "{{" not in text:
        return text

    def sub(m):
        bag = display.get(m.group(1))
        if isinstance(bag, dict):
            v = bag.get(m.group(2))
            if isinstance(v, str):
                return v
        return m.group(0)

    return TOKEN_RE.sub(sub, text)


def walk(node, display):
    """Interpolate tokens through nested strings/lists/dicts."""
    if isinstance(node, str):
        return interpolate(node, display)
    if isinstance(node, list):
        return [walk(x, display) for x in node]
    if isinstance(node, dict):
        return {k: walk(v, display) for k, v in node.items()}
    return node


def as_list(v):
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x) for x in v if x is not None and str(x).strip() != ""]
    return [str(v)]


def as_text(v):
    if v is None:
        return ""
    if isinstance(v, list):
        return " ".join(str(x) for x in v)
    return str(v)


def dollar(s):
    """Dollar-quote a literal.

    AGENTS.md forbids single-quoted string literals for JSON/free text: the
    useCase prose is full of apostrophes. $$...$$ is the safe host, so the only
    failure mode is the text itself containing '$$' - fail loudly rather than
    emit SQL that silently truncates.
    """
    s = "" if s is None else str(s)
    if "$$" in s:
        raise SystemExit(f"ERROR: text contains '$$' which breaks dollar-quoting: {s[:120]!r}")
    return f"$${s}$$"


def json_array(values):
    """Emit an ARRAY literal without inlining JSON into a quoted string."""
    if not values:
        return "ARRAY_CONSTRUCT()"
    return "ARRAY_CONSTRUCT(" + ", ".join(dollar(v) for v in values) + ")"


def build_prose(view_id, label, domain, uc, ak):
    """Flatten one view into the retrieval blob Cortex Search indexes."""
    lines = [f"{label} ({domain} domain, view id: {view_id})."]
    for title, key in PROSE_SECTIONS:
        val = uc.get(key)
        if not val:
            continue
        if isinstance(val, list):
            lines.append(f"{title}: " + "; ".join(str(x) for x in val) + ".")
        else:
            lines.append(f"{title}: {val}")
    metrics = as_list(ak.get("keyMetrics"))
    if metrics:
        lines.append("Key metrics on screen: " + "; ".join(metrics) + ".")
    questions = as_list(ak.get("exampleQuestions"))
    if questions:
        lines.append("Example questions: " + " ".join(questions))
    if ak.get("gotchas"):
        lines.append(f"Gotchas: {ak['gotchas']}")
    if ak.get("preferredTool"):
        lines.append(f"Preferred analytics tool: {ak['preferredTool']}.")
    return "\n".join(lines)


def rows_from(views_path, config_path):
    views = json.loads(views_path.read_text())
    display = {}
    if config_path.exists():
        display = (json.loads(config_path.read_text()) or {}).get("display") or {}

    rows = []
    missing = []
    for view_id, raw in views.items():
        view = walk(raw, display)
        uc = view.get("useCase") or {}
        ak = view.get("agentKnowledge") or {}
        if not uc.get("headline") or not uc.get("businessQuestion"):
            missing.append(view_id)
            continue
        label = view.get("label") or view_id
        domain = view.get("category") or "Core"
        rows.append(
            {
                "view_id": view_id,
                "label": label,
                "domain": domain,
                "description": as_text(view.get("description")),
                "headline": uc.get("headline"),
                "business_question": uc.get("businessQuestion"),
                "audience": as_list(uc.get("audience")),
                "industries": as_list(uc.get("industries")),
                "talk_track": as_list(uc.get("talkTrack")),
                "capabilities": as_list(uc.get("snowflakeCapabilities")),
                "data_required": as_list(uc.get("dataRequired")),
                "value_drivers": as_list(uc.get("valueDrivers")),
                "method": as_text(uc.get("method")),
                "caveats": as_text(uc.get("caveats")),
                "preferred_tool": as_text(ak.get("preferredTool")),
                "key_metrics": as_list(ak.get("keyMetrics")),
                "example_questions": as_list(ak.get("exampleQuestions")),
                "chunk_text": build_prose(view_id, label, domain, uc, ak),
            }
        )

    if missing:
        # check_view_usecases.py is the authoritative Tenet 10 gate; this is a
        # second line of defence so a view can never land in the catalog with a
        # placeholder use case.
        raise SystemExit(
            "ERROR: views missing useCase.headline/businessQuestion (cannot build catalog): "
            + ", ".join(sorted(missing))
        )
    rows.sort(key=lambda r: (r["domain"], r["view_id"]))
    return rows


def render(rows, views_path):
    src = views_path.name
    out = [
        "-- view_catalog.sql - GENERATED by scripts/build_view_catalog.py. Do not edit by hand.",
        f"-- Source of truth: fleet_sa_app/app/{src} (+ app-config.json display tokens).",
        "--",
        "-- Projects every SA app view's useCase (Tenet 10, Channel D) and agentKnowledge",
        "-- (Channel C) blocks into a durable table + Cortex Search service, so the",
        "-- solution catalog is answerable OUTSIDE the app (Cowork / Snowflake",
        "-- Intelligence), where the app's request-time '[Solution catalog ...]' prefix",
        "-- does not exist. Regenerate after editing app-views.json:",
        "--   python3 .cortex/skills/install-fleet-apps/scripts/build_view_catalog.py",
        "--",
        "-- Idempotent: CREATE OR REPLACE throughout.",
        "--",
        "-- MUST be executed with client-side templating disabled:",
        "--   snow sql -c <conn> -f view_catalog.sql --enable-templating NONE",
        "-- The authored use-case prose contains ampersands (e.g. 'P&L'), which the",
        "-- snow CLI's default LEGACY/STANDARD substitution reads as a variable",
        "-- reference and fails on (\"'L' is undefined\"). The prose is kept",
        "-- byte-faithful rather than escaped, so the flag is required.",
        "",
        f"ALTER SESSION SET query_tag = '{TRACK}';",
        "",
        "CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.SEMANTIC",
        f"  COMMENT = '{TRACK}';",
        "",
        "CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.SEMANTIC.VIEW_CATALOG (",
        "  VIEW_ID               STRING,",
        "  LABEL                 STRING,",
        "  DOMAIN                STRING,",
        "  DESCRIPTION           STRING,",
        "  HEADLINE              STRING,",
        "  BUSINESS_QUESTION     STRING,",
        "  AUDIENCE              ARRAY,",
        "  INDUSTRIES            ARRAY,",
        "  TALK_TRACK            ARRAY,",
        "  SNOWFLAKE_CAPABILITIES ARRAY,",
        "  DATA_REQUIRED         ARRAY,",
        "  VALUE_DRIVERS         ARRAY,",
        "  METHOD                STRING,",
        "  CAVEATS               STRING,",
        "  PREFERRED_TOOL        STRING,",
        "  KEY_METRICS           ARRAY,",
        "  EXAMPLE_QUESTIONS     ARRAY,",
        "  CHUNK_TEXT            STRING",
        f") COMMENT = '{TRACK}';",
        "",
        "INSERT INTO FLEET_INTELLIGENCE.SEMANTIC.VIEW_CATALOG",
        "  (VIEW_ID, LABEL, DOMAIN, DESCRIPTION, HEADLINE, BUSINESS_QUESTION, AUDIENCE,",
        "   INDUSTRIES, TALK_TRACK, SNOWFLAKE_CAPABILITIES, DATA_REQUIRED, VALUE_DRIVERS,",
        "   METHOD, CAVEATS, PREFERRED_TOOL, KEY_METRICS, EXAMPLE_QUESTIONS, CHUNK_TEXT)",
    ]
    chunks = []
    for r in rows:
        chunks.append(
            "SELECT\n"
            f"  {dollar(r['view_id'])}, {dollar(r['label'])}, {dollar(r['domain'])},\n"
            f"  {dollar(r['description'])},\n"
            f"  {dollar(r['headline'])},\n"
            f"  {dollar(r['business_question'])},\n"
            f"  {json_array(r['audience'])},\n"
            f"  {json_array(r['industries'])},\n"
            f"  {json_array(r['talk_track'])},\n"
            f"  {json_array(r['capabilities'])},\n"
            f"  {json_array(r['data_required'])},\n"
            f"  {json_array(r['value_drivers'])},\n"
            f"  {dollar(r['method'])},\n"
            f"  {dollar(r['caveats'])},\n"
            f"  {dollar(r['preferred_tool'])},\n"
            f"  {json_array(r['key_metrics'])},\n"
            f"  {json_array(r['example_questions'])},\n"
            f"  {dollar(r['chunk_text'])}"
        )
    # ARRAY_CONSTRUCT cannot appear in a VALUES clause, so union per-row SELECTs.
    out.append("\nUNION ALL\n".join(chunks) + ";")
    out += [
        "",
        "-- Cortex Search over the flattened prose so any agent can answer 'what can",
        "-- this deployment show me' / 'what fits a retail customer' without the app.",
        "CREATE OR REPLACE CORTEX SEARCH SERVICE FLEET_INTELLIGENCE.SEMANTIC.SOLUTION_CATALOG_SEARCH",
        "  ON CHUNK_TEXT",
        "  ATTRIBUTES VIEW_ID, LABEL, DOMAIN, INDUSTRIES_TEXT, PREFERRED_TOOL",
        "  WAREHOUSE = MY_WH",
        "  TARGET_LAG = '1 hour'",
        f"  COMMENT = '{TRACK}'",
        "  AS",
        "    SELECT",
        "      VIEW_ID,",
        "      CHUNK_TEXT,",
        "      LABEL,",
        "      DOMAIN,",
        "      PREFERRED_TOOL,",
        "      ARRAY_TO_STRING(INDUSTRIES, ', ') AS INDUSTRIES_TEXT",
        "    FROM FLEET_INTELLIGENCE.SEMANTIC.VIEW_CATALOG;",
        "",
        "-- All three role-scoped bundles read the catalog (knowledge is shared even",
        "-- though ACTIONS stay role-isolated per Tenet 3). Roles are pre-created at",
        "-- install step 0.5. Best-effort per role so a partial role set still binds.",
    ]
    for role in ("FLEET_APP_USER", "FLEET_APP_OPS", "FLEET_APP_ADMIN"):
        out.append(f"GRANT SELECT ON TABLE FLEET_INTELLIGENCE.SEMANTIC.VIEW_CATALOG TO ROLE {role};")
        out.append(
            "GRANT USAGE ON CORTEX SEARCH SERVICE "
            f"FLEET_INTELLIGENCE.SEMANTIC.SOLUTION_CATALOG_SEARCH TO ROLE {role};"
        )
    out.append("")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description="Generate the SA deployment catalog SQL.")
    ap.add_argument("--views", default=str(DEFAULT_VIEWS))
    ap.add_argument("--config", default=str(DEFAULT_CONFIG))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--stdout", action="store_true", help="print SQL instead of writing it")
    ap.add_argument("--check", action="store_true", help="fail if the committed file is stale")
    args = ap.parse_args()

    views_path = pathlib.Path(args.views)
    rows = rows_from(views_path, pathlib.Path(args.config))
    sql = render(rows, views_path)
    out_path = pathlib.Path(args.out)

    if args.stdout:
        sys.stdout.write(sql)
        return 0
    if args.check:
        if not out_path.exists():
            print(f"FAIL: {out_path} does not exist - run build_view_catalog.py", file=sys.stderr)
            return 1
        if out_path.read_text() != sql:
            print(
                f"FAIL: {out_path} is stale vs app-views.json - "
                "run python3 .cortex/skills/install-fleet-apps/scripts/build_view_catalog.py",
                file=sys.stderr,
            )
            return 1
        print(f"OK: view catalog current ({len(rows)} views)")
        return 0

    out_path.write_text(sql)
    print(f"wrote {out_path} ({len(rows)} views)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
