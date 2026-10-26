#!/usr/bin/env python3
"""Static gate for the Overture semantic layer (scripts/overture_semantic/*.sql).

The large themes (addresses, transportation, buildings) cost tens to hundreds of
GB per unbounded query: measured on BUILDING, a bbox filter scanned 15 GB in
1.8 s while the same box as ST_INTERSECTS scanned 644 GB in 14.5 min. So:

  R1  every Overture theme the solution loads has a template and a semantic view;
  R2  each template creates its declared view, every object lands in the layer
      schemas, carries the tracking $comment, and reads only its own theme;
  R3  bounded themes REQUIRE the bbox filters in ai_sql_generation, and every
      verified query of every theme filters all four bbox_* columns when its
      table carries them (an example is what the model copies);
  R4  verified queries read the normalized views ($ns), never raw $src tables;
  R5  every semantic view and the category search are wired into the agent and
      super-agent specs, and bounded tools tell the agent to ask for an area;
  R6  Places region is a bare code only in the US (measured: GB mixes ENG, WSM,
      Greater London and borough codes, a third empty), so the guidance says so
      and every verified query filtering region also filters country = 'US';
  R7  the Places fields users name by everyday words carry synonyms;
  R8  themes with point or area geometry separate travel-time reachability
      (compute_isochrone) from straight-line radius and boundary containment;
  R9  division map geojson is simplified by subtype (a flat 100 m made the
      land countries 53 MB) and no verified query measures or tests it.

Exit 0 when clean, 1 with one line per violation.
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

import overture_contract as contract

SCRIPTS = pathlib.Path(__file__).resolve().parent
APP = SCRIPTS.parent / "fleet_sa_app" / "app"
SPECS = ("agent-spec.json", "super-agent-spec.json")
BBOX = ("bbox_xmin", "bbox_xmax", "bbox_ymin", "bbox_ymax")
VERIFIED = re.compile(r"(\w+) as \(\s*question '((?:[^']|'')*)'\s*sql '((?:[^']|'')*)'\)")
CREATE = re.compile(r"(?im)^create\s+(?:or\s+replace\s+)?(schema|view|table|semantic\s+view|cortex\s+search\s+service)"
                    r"\s+(?:if\s+not\s+exists\s+)?([\w.$]+)")
STATEMENT = "\n-- statement\n"
# Themes whose verified queries must all carry the four bbox filters. Divisions
# is exempt: its examples select by region/subtype on a ~1M-row table, and a
# containment example needs a point test, not a box (it still adds one).
BOXED_EXAMPLES = contract.BOUNDED_THEMES + ("places",)
SYNONYM_FIELDS = ("NAME", "CATEGORY", "BRAND", "REGION", "LOCALITY", "POSTCODE", "STREET_ADDRESS")
REACHABILITY_THEMES = ("places", "addresses", "divisions")
GEOJSON_SIMPLIFY = re.compile(r"st_simplify\(geometry,\s*((?:(?!st_simplify).)*?)\)\)::varchar as geojson", re.S)


def strip_comments(text):
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("--"))


def load_templates():
    return {theme: (SCRIPTS / spec).read_text() if (SCRIPTS / spec).exists() else None
            for theme, (_, spec) in contract.FLEET_SEMANTIC_VIEWS.items()}


def load_specs():
    return {name: json.loads((APP / name).read_text()) for name in SPECS}


def bbox_tables(statements):
    """Normalized views (by name) whose projection exposes all four bbox columns."""
    tables = set()
    for statement in statements:
        match = CREATE.search(statement)
        if match and match.group(1).lower() == "view" and all(c in statement for c in BBOX):
            tables.add(match.group(2).split(".")[-1].upper())
    return tables


def check(templates, specs, views=None, bounded=None):
    views = contract.FLEET_SEMANTIC_VIEWS if views is None else views
    bounded = contract.BOUNDED_THEMES if bounded is None else bounded
    errors = []
    # R1
    for theme in contract.LISTINGS:
        if theme not in views:
            errors.append(f"R1 {theme}: Overture theme has no fleet semantic view")
        elif not templates.get(theme):
            errors.append(f"R1 {theme}: template {views[theme][1]} missing or empty")
    for theme, text in templates.items():
        if not text:
            continue
        view = views[theme][0]
        statements = [s for s in (strip_comments(part) for part in text.split(STATEMENT)) if s.strip()]
        body = "\n".join(statements)
        # R2
        created = [CREATE.search(s) for s in statements]
        if any(m is None for m in created):
            errors.append(f"R2 {theme}: a statement creates no recognized object")
        names = [m.group(2) for m in created if m]
        if f"$sv.{view}" not in names:
            errors.append(f"R2 {theme}: does not create $sv.{view}")
        for name in names:
            if not name.startswith(("$ns.", "$sv.")):
                errors.append(f"R2 {theme}: {name} is outside the layer schemas")
        for statement, match in zip(statements, created):
            if match and not re.search(r"(?im)^\s*comment\s*=\s*\$comment\b|\bcomment\s*=\s*\$comment\b", statement):
                errors.append(f"R2 {theme}: {match.group(2)} has no tracking comment")
        for source in re.findall(r"\$src\.(\w+)", body):
            if source not in contract.LAYOUTS[theme]:
                errors.append(f"R2 {theme}: reads $src.{source}, not a {theme} contract table")
        # R3 / R4
        semantic = next((s for s, m in zip(statements, created) if m and "semantic" in m.group(1).lower()), "")
        if theme in bounded and not re.search(r"MUST filter bbox_xmin", semantic):
            errors.append(f"R3 {theme}: ai_sql_generation does not require the bbox filters")
        queries = VERIFIED.findall(semantic)
        if not queries:
            errors.append(f"R3 {theme}: no verified queries")
        boxed = bbox_tables(statements)
        for name, _, sql in queries:
            if "$src" in sql:
                errors.append(f"R4 {theme}.{name}: verified query reads a raw $src table")
            read = {t.upper() for t in re.findall(r"\$ns\.(\w+)", sql)}
            if theme in BOXED_EXAMPLES and read & boxed and not all(column in sql for column in BBOX):
                errors.append(f"R3 {theme}.{name}: verified query is not bounded by all four bbox_* filters")
            if theme in bounded and not read & boxed:
                errors.append(f"R3 {theme}.{name}: verified query on a bounded theme reads no bbox view")
            if theme == "places" and re.search(r"\bregion\s*=", sql) and "country = ''US''" not in sql:
                errors.append(f"R6 places.{name}: filters region without country = 'US'")
            if theme == "divisions" and re.search(r"\b(?:st_\w+|(?:try_)?to_geography)\(\s*geojson|st_\w+\([^)]*,\s*geojson", sql, re.I):
                errors.append(f"R9 divisions.{name}: measures or tests the display geojson")
        if theme == "places":
            if "never region" not in semantic:
                errors.append("R6 places: guidance does not say region is unreliable outside the US")
            for field in SYNONYM_FIELDS:
                if not re.search(rf"places\.\w+ as {field} with synonyms", semantic):
                    errors.append(f"R7 places: dimension {field} has no synonyms")
        if theme in REACHABILITY_THEMES and not ("compute_isochrone" in semantic and "ST_DWITHIN" in semantic
                                                 and "containment" in semantic):
            errors.append(f"R8 {theme}: guidance does not separate travel time, radius and containment")
        if theme == "divisions":
            tolerances = GEOJSON_SIMPLIFY.findall(body)
            if not tolerances or any("subtype" not in t for t in tolerances):
                errors.append("R9 divisions: display geojson is not simplified by subtype")
    # R5
    for spec_name, spec in specs.items():
        resources = spec.get("tool_resources", {})
        tools = {t["tool_spec"]["name"]: t["tool_spec"] for t in spec.get("tools", [])}
        if len(tools) != len(spec.get("tools", [])):
            errors.append(f"R5 {spec_name}: duplicate tool names")
        for theme, (view, _) in views.items():
            fqn = f"{contract.FLEET_SV_SCHEMA}.{view}"
            owners = [name for name, r in resources.items() if r.get("semantic_view") == fqn]
            if not owners:
                errors.append(f"R5 {spec_name}: no tool queries {fqn}")
            for name in owners:
                if name not in tools:
                    errors.append(f"R5 {spec_name}: resource {name} has no tool entry")
                elif theme in bounded and "MUST name an area" not in tools[name].get("description", ""):
                    errors.append(f"R5 {spec_name}: {name} does not tell the agent to require an area")
        search = [n for n, r in resources.items() if r.get("name") == contract.CATEGORY_SEARCH]
        if not search or search[0] not in tools:
            errors.append(f"R5 {spec_name}: category search {contract.CATEGORY_SEARCH} not wired")
    return errors


def main():
    errors = check(load_templates(), load_specs())
    for error in errors:
        print("FAIL: " + error)
    if not errors:
        print(f"PASS: {len(contract.FLEET_SEMANTIC_VIEWS)} Overture semantic views bounded, tagged and wired")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
