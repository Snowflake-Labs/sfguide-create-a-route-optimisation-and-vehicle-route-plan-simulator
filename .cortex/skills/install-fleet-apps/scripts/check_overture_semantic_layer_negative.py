#!/usr/bin/env python3
"""Prove check_overture_semantic_layer convicts each defect it exists for.

Mutations are applied to in-memory copies of the templates and specs; no file
is written, so an interrupted run cannot leave the tree modified.
"""
import copy
import sys

import check_overture_semantic_layer as gate
import overture_contract as contract


def mutate_template(theme, old, new, count=1):
    def apply(templates, specs):
        if old not in templates[theme]:
            raise AssertionError(f"anchor not found in {theme}: {old!r}")
        templates[theme] = templates[theme].replace(old, new, count)
    return apply


def drop_template(theme):
    def apply(templates, specs):
        templates[theme] = None
    return apply


def mutate_spec(fn):
    def apply(templates, specs):
        for spec in specs.values():
            fn(spec)
    return apply


def drop_resource(name):
    return mutate_spec(lambda spec: spec["tool_resources"].pop(name))


def strip_area_rule(name):
    def fn(spec):
        for tool in spec["tools"]:
            if tool["tool_spec"]["name"] == name:
                tool["tool_spec"]["description"] = tool["tool_spec"]["description"].replace("MUST name an area", "may name an area")
    return mutate_spec(fn)


MUTATIONS = [
    ("buildings template missing", drop_template("buildings")),
    ("bbox rule removed from buildings ai_sql_generation",
     mutate_template("buildings", "MUST filter bbox_xmin", "should filter bbox_xmin")),
    ("unbounded verified query on buildings",
     mutate_template("buildings", "where bbox_xmin >= 13.36 and bbox_xmax <= 13.44 and bbox_ymin >= 52.49 and bbox_ymax <= 52.54\n",
                     "where 1 = 1\n")),
    ("verified query drops one bbox edge on addresses",
     mutate_template("addresses", "and bbox_ymax <= 52.56", "")),
    ("bounded places verified query loses its box",
     mutate_template("places", "where bbox_xmin >= -0.51 and bbox_xmax <= 0.33 and bbox_ymin >= 51.28 and bbox_ymax <= 51.69\n  and ",
                     "where ")),
    ("verified query reads raw source table",
     mutate_template("transportation", "from $ns.SEGMENT\nwhere bbox_xmin >= -97.95", "from $src.SEGMENT\nwhere bbox_xmin >= -97.95")),
    ("view loses tracking comment",
     mutate_template("divisions", "create or replace view $ns.DIVISION comment = $comment as",
                     "create or replace view $ns.DIVISION as")),
    ("object created outside the layer schemas",
     mutate_template("addresses", "create or replace view $ns.ADDRESS", "create or replace view PUBLIC.ADDRESS")),
    ("template reads another theme's table",
     mutate_template("buildings", "from $src.BUILDING", "from $src.PLACE")),
    ("semantic view renamed away from the contract",
     mutate_template("transportation", "$sv.SV_OVERTURE_TRANSPORTATION", "$sv.SV_ROADS")),
    ("agent loses the buildings tool", drop_resource("query_overture_buildings")),
    ("agent loses the category search", drop_resource("overture_category_search")),
    ("bounded tool no longer asks for an area", strip_area_rule("query_overture_roads")),
    ("places guidance re-asserts region as a bare code",
     mutate_template("places", "outside the US filter by bbox and country, never region.", "filter by region code."), "R6"),
    ("places verified query filters region without country",
     mutate_template("places", "and region = ''CA'' and country = ''US''", "and region = ''CA''"), "R6"),
    ("postcode loses its zip-code synonyms",
     mutate_template("places", "places.postcode as POSTCODE with synonyms = ('zip code', 'zip', 'postal code'),",
                     "places.postcode as POSTCODE,"), "R7"),
    ("places guidance drops the travel-time routing rule",
     mutate_template("places", "get the compute_isochrone polygon", "use a larger radius"), "R8"),
    ("divisions guidance drops the travel-time routing rule",
     mutate_template("divisions", "needs the compute_isochrone routing tool", "is a larger radius"), "R8"),
    ("division areas back to a flat 100 m display tolerance",
     mutate_template("divisions", "st_simplify(geometry, case when subtype in ('country', 'dependency') then 5000\n"
                     "           when subtype in ('macroregion', 'region') then 1000 else 100 end))::varchar as geojson,",
                     "st_simplify(geometry, 100))::varchar as geojson,"), "R9"),
    ("verified query tests containment on display geojson",
     mutate_template("divisions", "st_contains(geom, st_makepoint(-122.4194, 37.7749))",
                     "st_contains(to_geography(geojson), st_makepoint(-122.4194, 37.7749))"), "R9"),
]


def main():
    templates, specs = gate.load_templates(), gate.load_specs()
    if gate.check(templates, specs):
        print("FAIL: gate is red on the unmodified tree; fix that first")
        return 1
    failed = 0
    for label, apply, *rule in MUTATIONS:
        t, s = dict(templates), copy.deepcopy(specs)
        try:
            apply(t, s)
        except AssertionError as error:
            print(f"FAIL: {label}: {error}"); failed += 1; continue
        errors = gate.check(t, s)
        if rule and not any(e.startswith(rule[0] + " ") for e in errors):
            print(f"FAIL: {label}: not convicted by {rule[0]} ({errors[:1]})"); failed += 1
        elif errors:
            print(f"PASS: mutation rejected: {label}")
        else:
            print(f"FAIL: mutation survived: {label}"); failed += 1
    # Registry-level: a theme removed from the contract must be convicted too.
    views = {k: v for k, v in contract.FLEET_SEMANTIC_VIEWS.items() if k != "divisions"}
    if gate.check({k: templates[k] for k in views}, specs, views=views):
        print("PASS: mutation rejected: theme dropped from FLEET_SEMANTIC_VIEWS")
    else:
        print("FAIL: mutation survived: theme dropped from FLEET_SEMANTIC_VIEWS"); failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
