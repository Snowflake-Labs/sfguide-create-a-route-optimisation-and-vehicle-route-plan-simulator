#!/usr/bin/env python3
"""Negative tests for check_view_tokens.py: a {{group.key}} token must sit on a
path the renderer interpolates (default-deny, keyed on the PATH) and must name a
key the PAIRED display config defines.

The first case is the trap that sank the gate's own first draft: a token whose
LEAF is `label` - a name interpolated on metric cards and detail-panel actions -
on a container that is never interpolated. A name-keyed allowlist passes it; the
path-keyed one must not. Every authoring surface is covered (declarative, pack,
starter), and the name check is driven from both sides: a bad token in a view,
and a good token whose key was removed from the config."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

APP = ".cortex/skills/install-fleet-apps/fleet_sa_app/app"
VIEWS = f"{APP}/app-views.json"
CONFIG = f"{APP}/app-config.json"
STARTER = f"{APP}/starter/app-views.json"
STARTER_CONFIG = f"{APP}/starter/app-config.json"
PACK = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/lib/packs/fleet/pack-views.json"


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


def area_cfg(views, view_id, area):
    return views[view_id]["areas"][area]["config"]


def append_desc(view_id, suffix):
    def edit(v):
        v[view_id]["description"] = v[view_id]["description"] + suffix
    return edit


h = Harness("check_view_tokens.py")

json_case(h, VIEWS,
          lambda v: area_cfg(v, "labor_overtime", "trend")["xAxis"].update(
              label="Week ({{labels.operator_plural}})"),
          expect="'*.areas.*.config.xAxis.label' is not a known interpolated path",
          name="path: token on an un-interpolated `label` leaf (name-keyed trap)")
json_case(h, VIEWS,
          lambda v: area_cfg(v, "labor_overtime", "map")["layers"][0].update(
              label="{{labels.journey_plural}}"),
          expect="'*.areas.*.config.layers.[].label' is not a known interpolated path",
          name="path: token on a map layer label (only tooltip is interpolated)")
json_case(h, PACK,
          lambda v: v["vrp_simulator"].update(subtitle="Plan {{labels.journey_plural}}"),
          expect="pack-views.json: vrp_simulator.subtitle",
          name="path: pack surface token on an unknown top-level field")
json_case(h, STARTER,
          lambda v: v["locations"].update(helpText="All {{labels.site_plural}}"),
          expect="starter/app-views.json: locations.helpText",
          name="path: starter surface token on an unknown top-level field")
json_case(h, VIEWS, append_desc("labor_overtime", " Per {{labels.operatr}}."),
          expect="token {{labels.operatr}} is not in",
          name="name: typo in a token key on an interpolated path")
json_case(h, VIEWS, append_desc("dwell_sla", " Over {{thresholds.dwell_duration}}."),
          expect="config has no 'thresholds' string section",
          name="name: token targets a non-string display section")
json_case(h, CONFIG, lambda c: c["display"]["labels"].pop("operator_plural"),
          expect="token {{labels.operator_plural}} is not in",
          name="name: config drops a key the views still use")
json_case(h, STARTER, append_desc("locations", " Includes {{labels.dwell}}."),
          expect=f"token {{{{labels.dwell}}}} is not in {STARTER_CONFIG}",
          name="name: starter token resolved against the starter config, not the fleet one")
sys.exit(h.finish())
