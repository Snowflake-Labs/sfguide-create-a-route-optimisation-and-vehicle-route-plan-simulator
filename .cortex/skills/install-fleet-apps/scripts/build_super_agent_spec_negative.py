#!/usr/bin/env python3
"""Negative tests for `build_super_agent_spec.py --check`, the drift gate between
the three role specs and the generated super-agent-spec.json.

Both directions are covered. SOURCE edited without regenerating: the consumer
spec (instructions and the skills pass-through), an ops section the super spec
derives verbatim - the exact failure that left `recent_verb_attempts` documented
in the super agent and not in the ops agent that owns it - and a native tool that
only a role spec declares (the union). GENERATED file edited by hand, or deleted.
Plus the classification guarantees the generator asserts on every build: an
unclassified new role section, a derived section renamed away, a
"byte-identical" twin that diverged, a stale exclusion, and a wide dash.

--check is the only mode ever run here; the harness works on a temp copy."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from build_super_agent_spec import split_sections  # noqa: E402
from negtest import Harness  # noqa: E402

APP = ".cortex/skills/install-fleet-apps/fleet_sa_app/app"
CONSUMER = f"{APP}/agent-spec.json"
OPS = f"{APP}/ops-agent-spec.json"
ADMIN = f"{APP}/admin-agent-spec.json"
SUPER = f"{APP}/super-agent-spec.json"
STALE = "super-agent-spec.json is stale vs agent-spec.json"
EN_DASH = chr(0x2013)


def json_case(h, rel, edit, expect, name):
    p = h.path(rel)
    state = {}

    def apply():
        assert p.exists(), f"{rel} does not exist in the tree"
        state["orig"] = p.read_text()
        obj = json.loads(state["orig"])
        edit(obj)
        assert obj != json.loads(state["orig"]), f"mutation leaves {rel} unchanged"
        p.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n")

    def undo():
        if "orig" in state:
            p.write_text(state["orig"])

    h.custom(name, apply, undo, expect)


def orch(fn):
    """Edit instructions.orchestration with fn(text) -> text."""
    def edit(spec):
        ins = spec["instructions"]
        ins["orchestration"] = fn(ins["orchestration"])
    return edit


def header(old, new):
    def fn(text):
        assert f"\n{old}" in text, f"section header {old!r} not found"
        return text.replace(f"\n{old}", f"\n{new}", 1)
    return fn


def drop_section(key):
    def fn(text):
        body = split_sections(text).get(key)
        assert body and body in text, f"section {key!r} not found"
        return text.replace(body, "", 1)
    return fn


def add_tool(spec):
    spec["tools"].append({"tool_spec": {"type": "cortex_analyst_text_to_sql",
                                        "name": "query_negtest",
                                        "description": "ops-only tool"}})


h = Harness("build_super_agent_spec.py", args=["--check"])

# --- source edited, super spec not regenerated ----------------------------
json_case(h, CONSUMER, orch(lambda t: t + "\nOne more consumer routing rule."),
          expect=STALE, name="source: consumer orchestration edited")
json_case(h, CONSUMER,
          lambda s: s["instructions"].update(response=s["instructions"]["response"] + " Be brief."),
          expect=STALE, name="source: consumer response edited")
json_case(h, CONSUMER, lambda s: s["skills"].pop(), expect=STALE,
          name="source: consumer skills array changed (pass-through)")
json_case(h, OPS, orch(header("AUDIT TRAIL:", "AUDIT TRAIL: Check recent_verb_attempts first.")),
          expect=STALE, name="source: derived ops section edited (role edit must reach super)")
json_case(h, OPS, add_tool, expect=STALE,
          name="source: native tool declared only in the ops spec (union)")
# --- generated file edited by hand, or missing ----------------------------
json_case(h, SUPER, lambda s: s["mcp_servers"].pop(), expect=STALE,
          name="generated: hand-edited super spec")
h.delete(SUPER, expect="super-agent-spec.json does not exist - run build_super_agent_spec.py",
         name="generated: super spec deleted")
# --- classification guarantees --------------------------------------------
json_case(h, OPS, orch(lambda t: t + "\nNEGTEST ROUTING: a brand new section."),
          expect="ops-agent-spec.json: section 'NEGTEST ROUTING' is neither derived into the "
                 "super spec nor excluded from it",
          name="classify: new role section neither derived nor excluded")
json_case(h, OPS, orch(header("AUDIT TRAIL:", "AUDIT LOG:")),
          expect="ops-agent-spec.json: DERIVED_SECTIONS names section 'AUDIT TRAIL', which no "
                 "longer exists",
          name="classify: derived section renamed away")
json_case(h, ADMIN,
          orch(header("SANDBOX (code_execution):", "SANDBOX (code_execution): Admin-only tweak.")),
          expect="admin-agent-spec.json: section 'SANDBOX (code_execution)' is excluded because "
                 "it is byte-identical to agent-spec.json",
          name="classify: byte-identical twin diverged")
json_case(h, ADMIN, orch(drop_section("CATALOG")),
          expect="admin-agent-spec.json: EXCLUDED_SECTIONS names section 'CATALOG', which no "
                 "longer exists - drop the stale exclusion",
          name="classify: excluded section removed (stale exclusion)")
json_case(h, CONSUMER,
          lambda s: s["instructions"].update(
              response=s["instructions"]["response"] + f" Fast {EN_DASH} and right."),
          expect="generated spec contains a en dash",
          name="wide dash reaches the generated spec")
sys.exit(h.finish())
