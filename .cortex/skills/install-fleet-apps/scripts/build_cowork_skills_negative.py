#!/usr/bin/env python3
"""Negative tests for `build_cowork_skills.py --check`, the drift gate between the
SA view sources and the committed CoWork skill folders plus the `skills` array in
agent-spec.json.

Both directions are covered. SOURCE edited without regenerating: a declarative
view's useCase, a pack view's agentKnowledge, a view whose map area is removed
(which flips the generated "inherently visual" step), a new view, and the
generator's own TOOL_NOTES. That last one matters because those notes used to be
hand-appended to the GENERATED files, where the next regeneration deleted them
silently. GENERATED output edited by hand: a SKILL.md note appended, a SKILL.md
deleted, an orphan folder left for a view that no longer exists, and an entry
dropped from the spec's skills array.

--check is the only mode ever run here; the harness works on a temp copy."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SKILL = ".cortex/skills/install-fleet-apps"
APP = f"{SKILL}/fleet_sa_app/app"
VIEWS = f"{APP}/app-views.json"
SPEC = f"{APP}/agent-spec.json"
SKILLS = f"{APP}/cowork_skills"
PACK = f"{SKILL}/fleet_sa_app/ui/src/lib/packs/fleet/pack-views.json"
GENERATOR = f"{SKILL}/scripts/build_cowork_skills.py"


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


def drop_map(v):
    areas = v["labor_overtime"]["areas"]
    maps = [k for k, a in areas.items() if str(a.get("component", "")).lower() == "map"]
    assert maps, "labor_overtime has no Map area"
    for k in maps:
        areas[k]["component"] = "Chart"


def new_view(v):
    v["negtest_view"] = {
        "label": "Negtest View",
        "category": "Core",
        "useCase": {"headline": "A new use case.", "businessQuestion": "Does it get a skill?"},
        "agentKnowledge": {"keyMetrics": ["one"]},
    }


h = Harness("build_cowork_skills.py", args=["--check"])
# Count read from the (green) baseline copy, so adding a view does not rot the expects.
N = len(json.loads(h.path(SPEC).read_text())["skills"])

# --- source edited, skills not regenerated --------------------------------
json_case(h, VIEWS,
          lambda v: v["labor_overtime"]["useCase"].update(caveats="Reworded caveat."),
          expect="labor_overtime: SKILL.md stale vs its useCase block",
          name="source: app-views.json useCase edited")
json_case(h, PACK,
          lambda v: v["backload_matching"]["agentKnowledge"]["exampleQuestions"].append(
              "Which vehicle earns most?"),
          expect="backload_matching: SKILL.md stale vs its useCase block",
          name="source: pack-views.json agentKnowledge edited")
json_case(h, VIEWS, drop_map,
          expect="labor_overtime: SKILL.md stale vs its useCase block",
          name="source: view loses its map (visual step must flip)")
json_case(h, VIEWS, new_view, expect="negtest_view: SKILL.md missing",
          name="source: new view has no skill folder")
json_case(h, VIEWS, new_view,
          expect=f"agent-spec.json: skills array is stale ({N} entry/entries, expected {N + 1})",
          name="source: new view not in the spec skills array")
h.replace(GENERATOR, "pass `trailer_id` (e.g. ", "pass `trailer_id` (for example ",
          expect="backload_matching: SKILL.md stale vs its useCase block",
          name="source: generator TOOL_NOTES edited")
# --- generated output edited by hand --------------------------------------
h.replace(f"{SKILLS}/dwell_sla/SKILL.md", "## How to answer\n",
          "## How to answer\n\nHand-added note.\n",
          expect="dwell_sla: SKILL.md stale vs its useCase block",
          name="generated: note hand-appended to a SKILL.md")
h.delete(f"{SKILLS}/catchment/SKILL.md", expect="catchment: SKILL.md missing",
         name="generated: SKILL.md deleted")
h.add(f"{SKILLS}/negtest_orphan/SKILL.md", "---\nname: negtest-orphan\n---\n",
      expect="negtest_orphan: skill folder exists for no view (stale)",
      name="generated: orphan skill folder for no view")
json_case(h, SPEC, lambda s: s["skills"].pop(),
          expect=f"agent-spec.json: skills array is stale ({N - 1} entry/entries, expected {N})",
          name="generated: entry dropped from the spec skills array")
sys.exit(h.finish())
