#!/usr/bin/env python3
"""Negative tests for check_dynamic_allowlist.py - the dynamic read allowlist is
encoded in four places (runtime filter, render_map verb, the reader role's
grants, the agents' map guidance); each case breaks ONE agreement the way the
shipped ROUTING_PLATFORM drift did, and the gate must name the rule."""
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SKILL = ".cortex/skills/install-fleet-apps"
ROUTE = f"{SKILL}/fleet_sa_app/ui/src/app/api/query/route.ts"
CODES = f"{SKILL}/fleet_tools/user/src/codes.ts"
ROLE = f"{SKILL}/fleet_sa_app/app/role_binding.sql"
APP = f"{SKILL}/fleet_sa_app/app"
ROUTE_LIST = "const ALLOWED_DYNAMIC_DBS = new Set(['FLEET_APP', 'SNOWFLAKE', 'ROUTING_PLATFORM']);"
CODES_LIST = "export const ALLOWED_DYNAMIC_DBS = ['FLEET_APP', 'SNOWFLAKE', 'ROUTING_PLATFORM'] as const;"
HEAD = "DRAWING A MAP INLINE (render_map - THE SA APP PATH):\n"

h = Harness("check_dynamic_allowlist.py")


def files_case(name: str, edits: dict, expect: str) -> None:
    """edits: rel -> fn(text) -> text, applied together as ONE case."""
    originals = {rel: h.path(rel).read_text() for rel in edits}

    def apply():
        for rel, fn in edits.items():
            changed = fn(originals[rel])
            assert changed != originals[rel], f"mutation leaves {rel} unchanged"
            h.path(rel).write_text(changed)

    def undo():
        for rel, text in originals.items():
            h.path(rel).write_text(text)

    h.custom(name, apply, undo, expect)


def sub(old: str, new: str):
    def fn(text: str) -> str:
        assert old in text, f"anchor not found: {old[:60]!r}"
        return text.replace(old, new, 1)
    return fn


def drop_grant(db: str):
    def fn(text: str) -> str:
        out, n = re.subn(rf"GRANT USAGE ON DATABASE {db}\s+TO ROLE FLEET_APP_DYNAMIC_READER;\n", "", text)
        assert n == 1, f"{db} reader grant anchor drifted"
        return out
    return fn


def map_block_edit(fn):
    """Edit only the render_map block of a spec's orchestration."""
    def apply(text: str) -> str:
        d = json.loads(text)
        o = d["instructions"]["orchestration"]
        start = o.index(HEAD)
        end = o.find("\nDRAWING A MAP IN COWORK", start)
        assert end > start, "map block end anchor drifted"
        d["instructions"]["orchestration"] = o[:start] + fn(o[start:end]) + o[end:]
        return json.dumps(d, indent=2, ensure_ascii=False) + "\n"
    return apply


def drop_routing_platform(block: str) -> str:
    assert "ROUTING_PLATFORM" in block
    return block.replace("ROUTING_PLATFORM.CONTRACT.", "").replace("ROUTING_PLATFORM", "routing")


# RULE A - the runtime filter and the verb disagree (the shipped drift)
files_case("A: runtime filter lacks ROUTING_PLATFORM (shipped)",
           {ROUTE: sub(ROUTE_LIST, "const ALLOWED_DYNAMIC_DBS = new Set(['FLEET_APP', 'SNOWFLAKE']);")},
           expect="only in codes.ts: ROUTING_PLATFORM")
files_case("A: verb list lacks ROUTING_PLATFORM",
           {CODES: sub(CODES_LIST, "export const ALLOWED_DYNAMIC_DBS = ['FLEET_APP', 'SNOWFLAKE'] as const;")},
           expect="only in route.ts: ROUTING_PLATFORM")

# RULE B - allowlisted but never granted to the reader role (the shipped drift)
files_case("B: no USAGE grant on ROUTING_PLATFORM (shipped)", {ROLE: drop_grant("ROUTING_PLATFORM")},
           expect="RULE B: 'ROUTING_PLATFORM' is in the allowlist but role_binding.sql never grants")
files_case("B: FLEET_APP usage granted to the wrong role",
           {ROLE: sub("GRANT USAGE ON DATABASE FLEET_APP TO ROLE FLEET_APP_DYNAMIC_READER;",
                      "GRANT USAGE ON DATABASE FLEET_APP TO ROLE FLEET_APP_USER;")},
           expect="RULE B: 'FLEET_APP' is in the allowlist")

# RULE C - the map guidance promises a database the code refuses
files_case("C: specs promise ROUTING_PLATFORM the code refuses (shipped)",
           {ROUTE: sub(ROUTE_LIST, "const ALLOWED_DYNAMIC_DBS = new Set(['FLEET_APP', 'SNOWFLAKE']);"),
            CODES: sub(CODES_LIST, "export const ALLOWED_DYNAMIC_DBS = ['FLEET_APP', 'SNOWFLAKE'] as const;")},
           expect="RULE C: agent-spec.json tells the agent a map layer may query 'ROUTING_PLATFORM.*'")
files_case("C: map block names a non-allowlisted database",
           {f"{APP}/agent-spec.json": map_block_edit(
               lambda b: b.replace(HEAD, HEAD + "- A layer may also read FLEET_INTELLIGENCE.SEMANTIC.SV_FLEET_OPS.\n", 1))},
           expect="RULE C: agent-spec.json tells the agent a map layer may query 'FLEET_INTELLIGENCE.*'")

# RULE D - an allowed database the map guidance never mentions
files_case("D: super spec map block never mentions ROUTING_PLATFORM",
           {f"{APP}/super-agent-spec.json": map_block_edit(drop_routing_platform)},
           expect="RULE D: 'ROUTING_PLATFORM' is allowed by the code but the map-authoring block of "
                  "super-agent-spec.json never mentions it")

# Vacuity - a subject renamed away must fail, not pass on nothing.
files_case("map block header renamed away",
           {f"{APP}/agent-spec.json": map_block_edit(lambda b: b.replace("DRAWING A MAP INLINE", "INLINE MAPS", 1))},
           expect="agent-spec.json: no 'DRAWING A MAP INLINE' block")
files_case("verb allowlist renamed away",
           {CODES: sub("export const ALLOWED_DYNAMIC_DBS =", "export const DYNAMIC_DB_ALLOWLIST =")},
           expect="codes.ts: no ALLOWED_DYNAMIC_DBS declaration found")
files_case("runtime allowlist emptied",
           {ROUTE: sub(ROUTE_LIST, "const ALLOWED_DYNAMIC_DBS = new Set([]);")},
           expect="route.ts: ALLOWED_DYNAMIC_DBS is empty")

sys.exit(h.finish())
