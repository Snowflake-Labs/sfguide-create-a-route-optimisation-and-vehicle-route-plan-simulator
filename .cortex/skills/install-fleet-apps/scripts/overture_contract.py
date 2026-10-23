"""Versioned CARTO table contract, verified against live Marketplace shares.

Baseline: PR #160's explicit theme DDL (2026-08-26), corrected 2026-10-23 against
the imported shares in account wgb26798 (INFORMATION_SCHEMA.COLUMNS, all nine
tables). Two corrections: PLACE no longer carries CATEGORIES (the vendor dropped
it; TAXONOMY replaces it), and SEGMENT.SUBCLASS is VARCHAR, not VARIANT.
Keep column order and native GEOGRAPHY; metadata lives separately.
"""
from __future__ import annotations

CONTRACT_VERSION = "carto-2026-10-23"
# Semantic views a share ships next to its tables, recreated for S3 copies from
# the vendor's exported YAML (repaired where its expressions no longer resolve).
SEMANTIC_VIEWS = {"places": {"OVERTUREMAPS_PLACES_SEMANTIC_VIEW": "overture_places_semantic_view.yaml"}}
LISTINGS = {
    "places": "GZT0Z4CM1E9KR", "addresses": "GZT0Z4CM1E9NQ",
    "divisions": "GZT0Z4CM1E9M9", "transportation": "GZT0Z4CM1E9KJ",
    "buildings": "GZT0Z4CM1E9KN",
}
# Type codes are expanded once; identifiers and projections never come from input.
TYPES = {"s": "VARCHAR", "v": "VARIANT", "g": "GEOGRAPHY",
         "n": "NUMBER(38,0)", "f": "FLOAT", "b": "BOOLEAN"}
LAYOUTS = {
    "places": {
        "PLACE": "ID:s GEOMETRY:g CONFIDENCE:f WEBSITES:v EMAILS:v SOCIALS:v PHONES:v BRAND:v ADDRESSES:v NAMES:v SOURCES:v OPERATING_STATUS:s BASIC_CATEGORY:s TAXONOMY:v VERSION:n BBOX:v",
    },
    "addresses": {
        "ADDRESS": "ID:s STREET:s NUMBER:s UNIT:s POSTCODE:s POSTAL_CITY:s ADDRESS_LEVELS:v COUNTRY:s GEOMETRY:g SOURCES:v VERSION:n BBOX:v",
    },
    "divisions": {
        "DIVISION": "ID:s GEOMETRY:g COUNTRY:s SOURCES:v SUBTYPE:s ADMIN_LEVEL:n CLASS:s NAMES:v WIKIDATA:s PERSPECTIVES:v LOCAL_TYPE:v REGION:s HIERARCHIES:v PARENT_DIVISION_ID:s NORMS:v POPULATION:n CAPITAL_DIVISION_IDS:v CAPITAL_OF_DIVISIONS:v CARTOGRAPHY:v VERSION:n BBOX:v",
        "DIVISION_AREA": "ID:s GEOMETRY:g COUNTRY:s SOURCES:v SUBTYPE:s ADMIN_LEVEL:n CLASS:s NAMES:v IS_LAND:b IS_TERRITORIAL:b REGION:s DIVISION_ID:s VERSION:n BBOX:v",
        "DIVISION_BOUNDARY": "ID:s GEOMETRY:g DIVISION_IDS:v SUBTYPE:s ADMIN_LEVEL:n CLASS:s SOURCES:v PERSPECTIVES:v IS_DISPUTED:b IS_LAND:b IS_TERRITORIAL:b COUNTRY:s REGION:s VERSION:n BBOX:v",
    },
    "transportation": {
        "SEGMENT": "ID:s NAMES:v SUBTYPE:s CLASS:s SUBCLASS:s SUBCLASS_RULES:v CONNECTORS:v ROAD_SURFACE:v ROAD_FLAGS:v RAIL_FLAGS:v WIDTH_RULES:v LEVEL_RULES:v ACCESS_RESTRICTIONS:v SPEED_LIMITS:v PROHIBITED_TRANSITIONS:v ROUTES:v DESTINATIONS:v SOURCES:v GEOMETRY:g VERSION:n BBOX:v",
        "CONNECTOR": "ID:s SOURCES:v GEOMETRY:g VERSION:n BBOX:v",
    },
    "buildings": {
        "BUILDING": "ID:s NAMES:v SOURCES:v LEVEL:n HEIGHT:f MIN_HEIGHT:f IS_UNDERGROUND:b NUM_FLOORS:n NUM_FLOORS_UNDERGROUND:n MIN_FLOOR:n SUBTYPE:s CLASS:s FACADE_COLOR:s FACADE_MATERIAL:s ROOF_MATERIAL:s ROOF_SHAPE:s ROOF_DIRECTION:f ROOF_ORIENTATION:s ROOF_COLOR:s ROOF_HEIGHT:f GEOMETRY:g HAS_PARTS:b VERSION:n BBOX:v",
        "BUILDING_PART": "ID:s NAMES:v HEIGHT:f MIN_HEIGHT:f IS_UNDERGROUND:b NUM_FLOORS:n NUM_FLOORS_UNDERGROUND:n MIN_FLOOR:n FACADE_COLOR:s FACADE_MATERIAL:s ROOF_MATERIAL:s ROOF_SHAPE:s ROOF_DIRECTION:f ROOF_ORIENTATION:s ROOF_COLOR:s ROOF_HEIGHT:f LEVEL:n SOURCES:v GEOMETRY:g BUILDING_ID:s VERSION:n BBOX:v",
    },
}


def columns(theme, table):
    return [(item.split(":")[0], TYPES[item.split(":")[1]])
            for item in LAYOUTS[theme][table].split()]


def definitions(theme, table):
    return ", ".join(f'"{name}" {kind}' for name, kind in columns(theme, table))


def projection(theme, table):
    # TRY_TO_GEOGRAPHY(wkb, TRUE): allow_invalid KEEPS parseable-but-invalid
    # shapes (Overture ships a few self-intersecting division polygons, and the
    # Marketplace share keeps those rows), while corrupt WKB still yields NULL
    # and is rejected before publication. Measured: strict conversion dropped
    # 7 of 1,084,259 DIVISION_AREA geometries.
    return ", ".join(
        "TRY_TO_GEOGRAPHY($1:geometry::BINARY, TRUE)" if kind == "GEOGRAPHY"
        else f'$1:{name.lower()}::{kind}'
        for name, kind in columns(theme, table))


def database(theme):
    if theme not in LAYOUTS:
        raise ValueError(f"Unknown Overture theme: {theme}")
    return "OVERTURE_MAPS__" + theme.upper()


def schema_errors(theme, table, description, *, exact):
    """Validate DESCRIBE TABLE output; tolerate extra vendor columns on reuse.

    DESCRIBE preserves VARCHAR lengths and numeric precision unlike the old
    fingerprint's DATA_TYPE-only signature. The historical DDL uses Snowflake's
    default VARCHAR length. We check it exactly for our own published tables.
    """
    expected = columns(theme, table)
    actual = [(row["name"], row["type"].upper(), row.get("null?", "Y"))
              for row in description if row.get("kind", "COLUMN") == "COLUMN"]
    by_name = {name: kind for name, kind, _ in actual}
    errors = []
    for name, kind in expected:
        found = by_name.get(name, "MISSING")
        valid = (found.startswith("VARCHAR(") if kind == "VARCHAR"
                 else found in ("FLOAT", "FLOAT8", "DOUBLE") if kind == "FLOAT"
                 else found == kind)
        if not valid:
            errors.append(f"{table}.{name}: expected {kind}, got {found}")
    if exact:
        if [name for name, _, _ in actual] != [name for name, _ in expected]:
            errors.append(f"{table}: column order/count differs from {CONTRACT_VERSION}")
        for name, kind, nullable in actual:
            if kind.startswith("VARCHAR(") and kind != "VARCHAR(16777216)":
                errors.append(f"{table}.{name}: VARCHAR length differs from baseline")
            if nullable != "Y":
                errors.append(f"{table}.{name}: nullability differs from baseline")
    return errors
