#!/usr/bin/env python3
"""Negative tests for fleet_sa_app/ui/scripts/verify-app-views.mts - each case
hand-edits the AUTHORED views (the producer with no runtime guard) or the column
reference runtime the suite delegates to, the way the shipped defect looked: an
uppercase column that binds nothing, a Map layer with no encoding, a clickEmits
the handler cannot use, or a component nobody classified.

app-views.json is mutated structurally (parse, edit, re-serialize) inside the
harness COPY only, so the cases do not depend on string anchors in a file that
is edited often."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

UI = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui"
VIEWS = ".cortex/skills/install-fleet-apps/fleet_sa_app/app/app-views.json"
REFS = f"{UI}/src/lib/view-column-refs.ts"

h = Harness("verify-app-views.mts", path=f"{UI}/scripts/verify-app-views.mts", cwd=UI,
            cmd=["npx", "tsx"])

views_path = h.path(VIEWS)
views_original = views_path.read_text()


def areas():
    data = json.loads(views_original)
    for vname, view in data.items():
        for aname, area in (view.get("areas") or {}).items():
            yield data, vname, aname, area


def json_case(name, pick, mutate, expect_fn):
    """pick(area) selects the first area to edit; mutate(area) edits it in place
    and returns a detail used to build the expected message."""
    state = {}

    def apply():
        for data, vname, aname, area in areas():
            if pick(area):
                detail = mutate(area)
                state["expect"] = expect_fn(f"{vname}.{aname}", detail)
                views_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
                return
        raise AssertionError(f"{name}: no area matches the selector")

    # expect is only known after the selector runs, so resolve it eagerly on a dry pass.
    for _d, vname, aname, area in areas():
        if pick(area):
            state["expect"] = expect_fn(f"{vname}.{aname}", mutate(area))
            break
    h.custom(name, apply, lambda: views_path.write_text(views_original),
             expect=state.get("expect", "<selector matched nothing>"))


def first_metric(area):
    m = ((area.get("data") or {}).get("mapping") or {}).get("metrics")
    return area.get("component") == "MetricCards" and isinstance(m, list) and m \
        and isinstance(m[0].get("column"), str) and m[0]["column"] != m[0]["column"].upper()


def upper_metric(area):
    area["data"]["mapping"]["metrics"][0]["column"] = area["data"]["mapping"]["metrics"][0]["column"].upper()


json_case("MetricCards column authored in UPPERCASE", first_metric, upper_metric,
          lambda where, _d: f"{where} (MetricCards): column reference(s) are not lowercase")


def h3_layer_area(area):
    return area.get("component") == "Map" and any(
        l.get("type") == "h3" and l.get("id") for l in (area.get("config") or {}).get("layers", []))


def _h3(area):
    return next(l for l in area["config"]["layers"] if l.get("type") == "h3" and l.get("id"))


def upper_hex(area):
    _h3(area)["hexColumn"] = _h3(area)["hexColumn"].upper()
    return _h3(area)["id"]


json_case("Map h3 layer hexColumn authored in UPPERCASE", h3_layer_area, upper_hex,
          lambda where, lid: f"{where} layer '{lid}': column reference(s) are not lowercase")


def drop_hex(area):
    _h3(area).pop("hexColumn")
    return _h3(area)["id"]


json_case("Map h3 layer missing its hexColumn encoding", h3_layer_area, drop_hex,
          lambda where, lid: f"{where} layer '{lid}' (type 'h3') is missing hexColumn")


def full_click_emits(area):
    ce = (area.get("config") or {}).get("clickEmits") or {}
    return area.get("component") == "Map" and all(k in ce for k in ("object", "objectColumn", "lng", "lat"))


json_case("clickEmits sets objectColumn but no object", full_click_emits,
          lambda a: a["config"]["clickEmits"].pop("object"),
          lambda where, _d: f"{where}: clickEmits sets objectColumn but no 'object'")
json_case("clickEmits sets lng without lat", full_click_emits,
          lambda a: a["config"]["clickEmits"].pop("lat"),
          lambda where, _d: f"{where}: clickEmits sets only lng")

# Runtime side: normalizeAt must REPLACE containers, never mutate (the module
# says so: mutating would rewrite the cached app-views.json in memory). A
# mutating normalizer also blinds a gate that diffs the area against the
# normalizer's output without cloning first - the object is compared to itself.
refs_path = h.path(REFS)
refs_original = refs_path.read_text()
IMMUTABLE = "  return { ...node, [head]: normalizeAt(node[head], rest) };"
MUTATING = ("  (node as Record<string, unknown>)[head] = normalizeAt(node[head], rest);\n"
            "  return node;")


def mutating_normalizer_plus_uppercase():
    assert IMMUTABLE in refs_original, "normalizeAt anchor not found"
    refs_path.write_text(refs_original.replace(IMMUTABLE, MUTATING, 1))
    for data, _v, _a, area in areas():
        if first_metric(area):
            upper_metric(area)
            views_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
            return
    raise AssertionError("no MetricCards area to uppercase")


def restore_both():
    refs_path.write_text(refs_original)
    views_path.write_text(views_original)


h.custom("normalizer mutates in place (uppercase column hidden from the diff)",
         mutating_normalizer_plus_uppercase, restore_both,
         expect="(MetricCards): column reference(s) are not lowercase")

# Runtime side: a component dropped from the path table is a silent gap in BOTH
# producers, so the suite must refuse an unclassified component.
h.replace(REFS, "  ComboBox: ['data.mapping.value', 'data.mapping.label'],\n", "",
          expect="component 'ComboBox' is in neither COLUMN_REF_PATHS nor NO_COLUMN_REFS",
          name="ComboBox dropped from COLUMN_REF_PATHS")

sys.exit(h.finish())
