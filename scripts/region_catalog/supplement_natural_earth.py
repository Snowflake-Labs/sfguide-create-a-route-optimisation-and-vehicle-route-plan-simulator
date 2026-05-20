#!/usr/bin/env python3
"""
Supplement REGION_CATALOG with Natural Earth admin-1 polygons for
state/province subdivisions Geofabrik does not split (e.g. US states,
Brazilian states, Indian states, Mexican states, Japanese prefectures).

Reads the existing parquet, adds rows for every NE admin-1 feature whose
ISO_3166-2 code is not already present in the catalog (via ISO_SUBDIVISION
column). Polygons come straight from NE's GeoJSON, simplified the same way
as the geofabrik baker.

Usage:
    python3 scripts/region_catalog/supplement_natural_earth.py
"""
from __future__ import annotations

import json
import math
import re
import sys
import unicodedata
from datetime import date
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from shapely.geometry import shape, MultiPolygon, Polygon

REPO_ROOT = Path(__file__).resolve().parents[2]
PARQUET_PATH = REPO_ROOT / "datasets" / "region_catalog" / "data_0_0_0.snappy.parquet"
NE_GEOJSON = REPO_ROOT / "tmp" / "ne_admin1.geojson"

SIMPLIFY_TOLERANCE_DEG = 0.001


def canonicalize(name: str) -> str:
    if not name:
        return ""
    nfkd = unicodedata.normalize("NFKD", name)
    ascii_only = "".join(c for c in nfkd if not unicodedata.combining(c))
    parts = re.split(r"[^A-Za-z0-9]+", ascii_only)
    parts = [p for p in parts if p]
    if not parts:
        return ""
    return "".join(p[0].upper() + p[1:] for p in parts)


def _ring_area_steradians(coords) -> float:
    if len(coords) < 3:
        return 0.0
    total = 0.0
    n = len(coords)
    for i in range(n):
        lon1, lat1 = coords[i]
        lon2, lat2 = coords[(i + 1) % n]
        total += math.radians(lon2 - lon1) * (
            2 + math.sin(math.radians(lat1)) + math.sin(math.radians(lat2))
        )
    return abs(total) / 2.0


def geographic_area_km2(geom) -> float:
    R = 6371.0088
    if geom.is_empty:
        return 0.0
    polys = [geom] if geom.geom_type == "Polygon" else list(geom.geoms)
    total = 0.0
    for p in polys:
        total += _ring_area_steradians(list(p.exterior.coords)) * (R ** 2)
        for r in p.interiors:
            total -= _ring_area_steradians(list(r.coords)) * (R ** 2)
    return abs(total)


def vertex_count(geom) -> int:
    if geom.is_empty:
        return 0
    polys = [geom] if geom.geom_type == "Polygon" else list(geom.geoms)
    n = 0
    for p in polys:
        n += len(p.exterior.coords)
        for r in p.interiors:
            n += len(r.coords)
    return n


# Country name normalization: NE 'admin' -> our CONTINENT/COUNTRY values
COUNTRY_TO_CONTINENT = {
    "United States of America": "NorthAmerica",
    "Canada": "NorthAmerica",
    "Mexico": "NorthAmerica",
    "Brazil": "SouthAmerica",
    "Argentina": "SouthAmerica",
    "Chile": "SouthAmerica",
    "Colombia": "SouthAmerica",
    "Peru": "SouthAmerica",
    "Venezuela": "SouthAmerica",
    "Ecuador": "SouthAmerica",
    "Bolivia": "SouthAmerica",
    "Paraguay": "SouthAmerica",
    "Uruguay": "SouthAmerica",
    "Guyana": "SouthAmerica",
    "Suriname": "SouthAmerica",
    "India": "Asia",
    "China": "Asia",
    "Japan": "Asia",
    "Indonesia": "Asia",
    "Thailand": "Asia",
    "Vietnam": "Asia",
    "Philippines": "Asia",
    "Malaysia": "Asia",
    "South Korea": "Asia",
    "Taiwan": "Asia",
    "Pakistan": "Asia",
    "Bangladesh": "Asia",
    "Iran": "Asia",
    "Saudi Arabia": "Asia",
    "Turkey": "Europe",
    "Australia": "AustraliaAndOceania",
    "New Zealand": "AustraliaAndOceania",
    "Russia": "RussianFederation",
    "South Africa": "Africa",
    "Egypt": "Africa",
    "Nigeria": "Africa",
    "Kenya": "Africa",
    "Ethiopia": "Africa",
    "Morocco": "Africa",
    "Algeria": "Africa",
    "Tunisia": "Africa",
    "Ghana": "Africa",
}


def main() -> int:
    print(f"Reading {PARQUET_PATH}")
    df = pq.read_table(PARQUET_PATH).to_pandas()
    print(f"  {len(df)} rows")

    # Existing ISO_3166-2 codes already covered (geofabrik sub-regions)
    existing_iso = set(df["ISO_SUBDIVISION"].dropna().astype(str).str.upper())
    existing_keys = set(df["REGION_KEY"].astype(str).str.lower())
    print(f"  ISO subdivisions already covered: {len(existing_iso)}")

    # Country lookup: ISO a2 -> a3, m49 from existing rows
    iso_a2_to_a3 = {}
    iso_a2_to_m49 = {}
    iso_a2_to_country_name = {}
    iso_a2_to_continent = {}
    for _, r in df.iterrows():
        a2 = r.get("ISO_COUNTRY_A2")
        if a2 and not pd.isna(a2):
            iso_a2_to_a3.setdefault(a2, r.get("ISO_COUNTRY_A3"))
            iso_a2_to_m49.setdefault(a2, r.get("UN_M49"))
            iso_a2_to_country_name.setdefault(a2, r.get("COUNTRY"))
            iso_a2_to_continent.setdefault(a2, r.get("CONTINENT"))

    print(f"Loading {NE_GEOJSON}")
    ne = json.load(open(NE_GEOJSON))
    print(f"  {len(ne['features'])} admin-1 features")

    next_idx = 1 + max(
        (int(re.findall(r"\d+", c)[-1]) for c in df["CATALOG_ID"].astype(str) if re.findall(r"\d+", c)),
        default=0,
    )

    new_rows = []
    skipped_dup_iso = 0
    skipped_no_iso = 0
    skipped_dup_key = 0
    countries_added = set()

    for feat in ne["features"]:
        props = feat["properties"]
        iso_sub = props.get("iso_3166_2")
        if not iso_sub or iso_sub == "-99":
            skipped_no_iso += 1
            continue
        iso_sub = iso_sub.upper().strip()
        if iso_sub in existing_iso:
            skipped_dup_iso += 1
            continue

        name = props.get("name") or props.get("name_alt") or ""
        if not name:
            continue

        iso_a2 = (props.get("iso_a2") or "").upper()
        if not iso_a2 or iso_a2 == "-99":
            iso_a2 = iso_sub.split("-")[0]

        country_name = iso_a2_to_country_name.get(iso_a2) or props.get("admin")
        continent = iso_a2_to_continent.get(iso_a2) or COUNTRY_TO_CONTINENT.get(props.get("admin"), "")
        iso_a3 = iso_a2_to_a3.get(iso_a2)
        m49 = iso_a2_to_m49.get(iso_a2)

        # Region key: prefer postal abbreviation suffixed with country to avoid collisions,
        # else canonicalize name
        candidate_key = canonicalize(name)
        # Disambiguate against existing keys by appending country code
        if candidate_key.lower() in existing_keys:
            candidate_key = f"{candidate_key}{iso_a2}"
        if candidate_key.lower() in existing_keys:
            # extreme: append iso_sub
            candidate_key = canonicalize(iso_sub)
        if candidate_key.lower() in existing_keys:
            skipped_dup_key += 1
            continue

        # Build polygon
        try:
            geom = shape(feat["geometry"])
        except Exception as e:
            print(f"  [warn] {iso_sub} {name}: shape() failed: {e}")
            continue
        if geom.is_empty:
            continue
        if not geom.is_valid:
            geom = geom.buffer(0)
        simp = geom.simplify(SIMPLIFY_TOLERANCE_DEG, preserve_topology=True)
        if simp.is_empty or not simp.is_valid:
            simp = geom
        if simp.geom_type == "Polygon":
            simp = MultiPolygon([simp])
        elif simp.geom_type != "MultiPolygon":
            continue

        minx, miny, maxx, maxy = simp.bounds

        new_rows.append({
            "CATALOG_ID": f"naturalearth-{next_idx:04d}",
            "SOURCE": "natural-earth",
            "REGION_NAME": name,
            "REGION_KEY": candidate_key,
            "LOOKUP_NAME": canonicalize(name),
            "HIERARCHY": f"{iso_a2.lower()}/admin1",
            "CONTINENT": continent,
            "COUNTRY": country_name,
            "ISO_COUNTRY_A2": iso_a2,
            "ISO_COUNTRY_A3": iso_a3,
            "ISO_SUBDIVISION": iso_sub,
            "UN_M49": m49,
            "PBF_URL": None,
            "PBF_SIZE_MB": None,
            "LEVEL": "sub-region",
            "MIN_LAT": miny,
            "MAX_LAT": maxy,
            "MIN_LON": minx,
            "MAX_LON": maxx,
            "BOUNDARY_WKB": simp.wkb_hex,
            "BOUNDARY_SOURCE": "natural-earth",
            "BOUNDARY_VERTICES": vertex_count(simp),
            "BOUNDARY_AREA_KM2": geographic_area_km2(simp),
            "BOUNDARY_BAKED_AT": date.today(),
        })
        existing_keys.add(candidate_key.lower())
        existing_iso.add(iso_sub)
        countries_added.add(iso_a2)
        next_idx += 1

    print(f"\nSkipped duplicates (ISO match): {skipped_dup_iso}")
    print(f"Skipped (no ISO_3166-2 code): {skipped_no_iso}")
    print(f"Skipped (key collision): {skipped_dup_key}")
    print(f"New rows: {len(new_rows)} across {len(countries_added)} countries")
    if not new_rows:
        return 0

    df_new = pd.DataFrame(new_rows)
    df_out = pd.concat([df, df_new], ignore_index=True)

    df_out["UN_M49"] = pd.array(df_out["UN_M49"], dtype="Int32")
    df_out["BOUNDARY_VERTICES"] = pd.array(df_out["BOUNDARY_VERTICES"], dtype="Int32")
    df_out["BOUNDARY_BAKED_AT"] = pd.to_datetime(df_out["BOUNDARY_BAKED_AT"]).dt.date

    schema = pa.schema([
        ("CATALOG_ID", pa.string()),
        ("SOURCE", pa.string()),
        ("REGION_NAME", pa.string()),
        ("REGION_KEY", pa.string()),
        ("LOOKUP_NAME", pa.string()),
        ("HIERARCHY", pa.string()),
        ("CONTINENT", pa.string()),
        ("COUNTRY", pa.string()),
        ("ISO_COUNTRY_A2", pa.string()),
        ("ISO_COUNTRY_A3", pa.string()),
        ("ISO_SUBDIVISION", pa.string()),
        ("UN_M49", pa.int32()),
        ("PBF_URL", pa.string()),
        ("PBF_SIZE_MB", pa.float64()),
        ("LEVEL", pa.string()),
        ("MIN_LAT", pa.float64()),
        ("MAX_LAT", pa.float64()),
        ("MIN_LON", pa.float64()),
        ("MAX_LON", pa.float64()),
        ("BOUNDARY_WKB", pa.string()),
        ("BOUNDARY_SOURCE", pa.string()),
        ("BOUNDARY_VERTICES", pa.int32()),
        ("BOUNDARY_AREA_KM2", pa.float64()),
        ("BOUNDARY_BAKED_AT", pa.date32()),
    ])
    out_table = pa.Table.from_pandas(df_out, schema=schema, preserve_index=False)
    pq.write_table(out_table, PARQUET_PATH, compression="snappy")
    print(f"\nWrote {PARQUET_PATH}  ({PARQUET_PATH.stat().st_size/1024:.1f} KB)  rows={len(df_out)}")

    print("\nSpot checks:")
    for k in ["California", "Texas", "NewYork", "SaoPaulo", "Bavaria", "UttarPradesh"]:
        m = df_out[df_out.REGION_KEY.str.lower() == k.lower()]
        if len(m):
            r = m.iloc[0]
            print(f"  {r.REGION_KEY:25s} src={r.BOUNDARY_SOURCE:14s} iso={r.ISO_SUBDIVISION}  area={r.BOUNDARY_AREA_KM2:.0f} km2")
        else:
            print(f"  {k}: NOT FOUND")
    return 0


if __name__ == "__main__":
    sys.exit(main())
