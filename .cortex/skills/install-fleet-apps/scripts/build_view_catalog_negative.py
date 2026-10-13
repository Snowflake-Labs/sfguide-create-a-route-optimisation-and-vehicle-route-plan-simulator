#!/usr/bin/env python3
"""Negative tests for `build_view_catalog.py --check`, the drift gate between the
SA view sources and the committed view_catalog.sql.

Both directions are covered. SOURCE edited without regenerating: each of the
three inputs (app-views.json, pack-views.json - whose five showcase views were
once missing from the catalog entirely - and the app-config.json display tokens
the generator interpolates). GENERATED file edited by hand, or deleted. Plus the
generator's own refusals, which --check must surface rather than skip: a view id
claimed by both sources, a view with no headline, and prose that would break the
dollar-quoting.

--check is the only mode ever run here; the harness works on a temp copy and
nothing is regenerated."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

APP = ".cortex/skills/install-fleet-apps/fleet_sa_app/app"
VIEWS = f"{APP}/app-views.json"
CONFIG = f"{APP}/app-config.json"
CATALOG = f"{APP}/view_catalog.sql"
PACK = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/lib/packs/fleet/pack-views.json"
STALE = "view_catalog.sql is stale vs the view sources"


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


def new_view(v):
    v["negtest_view"] = {
        "label": "Negtest View",
        "category": "Core",
        "useCase": {"headline": "A new use case.", "businessQuestion": "Does it reach the catalog?"},
        "agentKnowledge": {"keyMetrics": ["one"]},
    }


h = Harness("build_view_catalog.py", args=["--check"])

# --- source edited, catalog not regenerated -------------------------------
json_case(h, VIEWS,
          lambda v: v["labor_overtime"]["useCase"].update(headline="Reworded headline."),
          expect=STALE, name="source: app-views.json useCase edited")
json_case(h, PACK,
          lambda v: v["backload_matching"]["useCase"].update(caveats="Reworded caveat."),
          expect=STALE, name="source: pack-views.json showcase view edited")
json_case(h, CONFIG,
          lambda c: c["display"]["labels"].update(operator_plural="Couriers"),
          expect=STALE, name="source: display token value changed in app-config.json")
json_case(h, VIEWS, new_view, expect=STALE, name="source: new view added")
json_case(h, PACK, lambda v: v.pop("ops_console"), expect=STALE,
          name="source: showcase view removed")
# --- generated file edited by hand, or missing -----------------------------
h.replace(CATALOG, "  TARGET_LAG = '1 hour'", "  TARGET_LAG = '5 minutes'",
          expect=STALE, name="generated: hand-edited catalog SQL")
h.delete(CATALOG, expect="view_catalog.sql does not exist - run build_view_catalog.py",
         name="generated: catalog SQL deleted")
# --- the generator refuses, and --check must say why -----------------------
json_case(h, VIEWS, lambda v: v.update(vrp_simulator={"label": "dup"}),
          expect="view id declared in BOTH app-views.json and pack-views.json: vrp_simulator",
          name="refuse: one view id in both sources")
json_case(h, PACK, lambda v: v["triangle_proposals"]["useCase"].pop("headline"),
          expect="views missing useCase.headline/businessQuestion (cannot build catalog): "
                 "triangle_proposals",
          name="refuse: view with no headline")
json_case(h, VIEWS,
          lambda v: v["catchment"]["useCase"].update(method="Costs $$ to run."),
          expect="text contains '$$' which breaks dollar-quoting",
          name="refuse: prose that breaks dollar-quoting")
sys.exit(h.finish())
