#!/usr/bin/env python3
"""Negative tests for check_view_usecases.py (Tenet 10, Channels C and D).

One case per rule in the gate's docstring, spread across all three authoring
surfaces it claims to cover (app-views.json, starter/app-views.json and the
code-registered pack-views.json), because a rule enforced on one surface and not
another is how two showcase views once shipped with no agent grounding.

JSON sources are mutated by parse -> edit -> dump, so a case targets one field of
one named view instead of a text anchor that drifts with every edit. The dash
characters are built with chr() so this file carries neither the literal nor
the escaped form itself."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

APP = ".cortex/skills/install-fleet-apps/fleet_sa_app/app"
VIEWS = f"{APP}/app-views.json"
STARTER = f"{APP}/starter/app-views.json"
PACK_DIR = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/lib/packs/fleet"
PACK = f"{PACK_DIR}/pack-views.json"
EM_DASH = chr(0x2014)
ESCAPED_EN_DASH = "\\" + "u" + "2013"


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


def first_columns(views, view_id):
    for area in views[view_id]["areas"].values():
        cols = (area.get("config") or {}).get("columns")
        if isinstance(cols, list):
            return cols
    raise AssertionError(f"{view_id} has no config.columns")


h = Harness("check_view_usecases.py")

json_case(h, VIEWS, lambda v: v["labor_overtime"].pop("useCase"),
          expect="labor_overtime has no useCase block",
          name="D: declarative view loses its useCase block")
json_case(h, VIEWS, lambda v: v["dwell_sla"]["useCase"].update(headline="  "),
          expect="dwell_sla.useCase.headline is missing or empty",
          name="D: useCase.headline blanked")
json_case(h, PACK, lambda v: v["backload_matching"]["useCase"].pop("businessQuestion"),
          expect="backload_matching.useCase.businessQuestion is missing or empty",
          name="D: pack view loses useCase.businessQuestion")
json_case(h, STARTER, lambda v: v["movements"].pop("useCase"),
          expect="movements has no useCase block",
          name="D: starter view loses its useCase block")
json_case(h, PACK, lambda v: v["vrp_simulator"].pop("agentKnowledge"),
          expect="vrp_simulator has no agentKnowledge block",
          name="C: pack view ships with no agentKnowledge (the original defect)")
json_case(h, VIEWS,
          lambda v: v["catchment"].update(
              agentKnowledge={"gotchas": v["catchment"]["agentKnowledge"].get("gotchas", "x")}),
          expect="catchment.agentKnowledge carries neither keyMetrics nor exampleQuestions",
          name="C: agentKnowledge that grounds nothing")
json_case(h, VIEWS, lambda v: v["site_impact"].update(info="Free-text prose."),
          expect="site_impact carries the retired top-level 'info' key",
          name="retired top-level info key reintroduced")
h.replace(f"{PACK_DIR}/index.ts", "    ...metaFor('vrp_simulator'),",
          "    ...metaFor('vrp_simulator'),\n    useCase: { headline: 'inline' },",
          expect="vrp_simulator declares an inline 'useCase:' block",
          name="pack metadata re-inlined into index.ts")
json_case(h, VIEWS,
          lambda v: first_columns(v, "journey_inspector")[0].update(field="Trip ID"),
          expect="column field 'Trip ID' is not lowercase",
          name="table column field carries display case")
h.replace(VIEWS, '"headline": "', f'"headline": "{EM_DASH} ',
          expect="1 em dash(s) found",
          name="literal em dash in authored prose")
h.replace(PACK, '"headline": "', f'"headline": "{ESCAPED_EN_DASH} ',
          expect="1 escaped en dash(s) found",
          name="JSON-escaped en dash in pack prose")
h.replace(STARTER, "{", "{,", expect="invalid JSON",
          name="starter source no longer parses")
sys.exit(h.finish())
