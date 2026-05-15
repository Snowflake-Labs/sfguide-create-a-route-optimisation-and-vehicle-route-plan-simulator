#!/usr/bin/env python3
"""
Expand REGION_CATALOG seed parquet with every Geofabrik sub-region
(US states, German Bundesl\u00e4nder, French regions, Brazilian states, etc.).

Reads the live Geofabrik tree from index-v1.json, walks every node, and
appends rows for any (SOURCE='geofabrik', REGION_KEY) not already present
in datasets/region_catalog/data_0_0_0.snappy.parquet.

This script ONLY expands the row set (with placeholder boundary fields).
After running, re-run scripts/region_catalog/build_boundaries.py to fetch
the .poly files and bake BOUNDARY_WKB/AREA/VERTICES for the new rows.

Usage:
    python3 scripts/region_catalog/expand_geofabrik_subregions.py
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from datetime import date
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import requests

REPO_ROOT = Path(__file__).resolve().parents[2]
PARQUET_PATH = REPO_ROOT / "datasets" / "region_catalog" / "data_0_0_0.snappy.parquet"
INDEX_URL = "https://download.geofabrik.de/index-v1.json"
INDEX_CACHE = REPO_ROOT / "tmp" / "geofabrik-index-v1.json"


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


def fetch_index() -> dict:
    INDEX_CACHE.parent.mkdir(parents=True, exist_ok=True)
    if INDEX_CACHE.exists() and INDEX_CACHE.stat().st_size > 0:
        return json.loads(INDEX_CACHE.read_text())
    print(f"Fetching {INDEX_URL}")
    r = requests.get(INDEX_URL, timeout=60)
    r.raise_for_status()
    INDEX_CACHE.write_text(r.text)
    return r.json()


def build_path(feats: dict, fid: str) -> list[str]:
    p = feats.get(fid)
    if not p:
        return []
    if not p.get("parent"):
        return [fid]
    return build_path(feats, p["parent"]) + [fid]


def main() -> int:
    print(f"Reading existing seed: {PARQUET_PATH}")
    df_existing = pq.read_table(PARQUET_PATH).to_pandas()
    print(f"  {len(df_existing)} rows")
    existing_keys = set(
        df_existing[df_existing["SOURCE"] == "geofabrik"]["REGION_KEY"].astype(str).str.lower()
    )
    existing_pbf = set(
        df_existing[df_existing["SOURCE"] == "geofabrik"]["PBF_URL"].dropna().astype(str)
    )
    existing_catalog_ids = set(df_existing["CATALOG_ID"].astype(str))

    data = fetch_index()
    feats = {f["properties"]["id"]: f["properties"] for f in data["features"]}
    print(f"Geofabrik tree: {len(feats)} features")

    # Geofabrik continent -> our parquet continent name (Title Case)
    cont_label = {
        "africa": "Africa",
        "antarctica": "Antarctica",
        "asia": "Asia",
        "australia-oceania": "AustraliaAndOceania",
        "central-america": "CentralAmerica",
        "europe": "Europe",
        "north-america": "NorthAmerica",
        "russia": "RussianFederation",
        "south-america": "SouthAmerica",
    }

    new_rows = []
    next_idx = max(
        (int(re.findall(r"\d+", c)[-1]) for c in existing_catalog_ids if re.findall(r"\d+", c)),
        default=0,
    ) + 1

    for fid, p in feats.items():
        path_ids = build_path(feats, fid)
        depth = len(path_ids) - 1  # 0=continent, 1=country, 2=sub, 3=sub-sub
        # Skip continents that already exist in seed and aren't gef "russia"
        # since both are roots in geofabrik tree.
        # Determine LEVEL
        if depth == 0:
            level = "continent"
        elif depth == 1:
            # russia tree's root is itself; treat country-level
            level = "country"
        elif depth == 2:
            level = "sub-region"
        elif depth == 3:
            level = "sub-sub-region"
        else:
            level = f"depth-{depth}"

        # Continent label
        root = path_ids[0]
        continent_name = cont_label.get(root, canonicalize(root))

        # Country label: if depth>=1, country = path_ids[1]
        if depth == 0:
            country_name = None
        elif depth == 1:
            country_name = p["name"]
        else:
            country_name = feats.get(path_ids[1], {}).get("name")

        region_name = p["name"]
        region_key = canonicalize(fid)
        # Avoid collisions: country-level fids that match existing keys keep
        # the existing key. For sub-regions, suffix with country code if the
        # canonical key would collide with an existing entry of a different
        # source/level.
        candidate_key = region_key
        # Check for collision with existing geofabrik keys
        if candidate_key.lower() in existing_keys:
            # existing entry already; will be skipped below
            pass
        else:
            # If the new candidate key collides with a different SOURCE
            # (BBBike city), suffix with parent id to disambiguate.
            other_source_keys = set(
                df_existing[df_existing["SOURCE"] != "geofabrik"]["REGION_KEY"].astype(str).str.lower()
            )
            if candidate_key.lower() in other_source_keys:
                # Suffix with country abbreviation if available, else parent id
                parent_id = path_ids[-2] if len(path_ids) >= 2 else ""
                candidate_key = f"{region_key}{canonicalize(parent_id)}"

        pbf_url = p.get("urls", {}).get("pbf")
        if not pbf_url or pbf_url in existing_pbf:
            continue
        if candidate_key.lower() in existing_keys:
            continue

        # HIERARCHY: lowercase id path joined with /
        hierarchy = "/".join(path_ids[:-1]) if len(path_ids) > 1 else (path_ids[0] if path_ids else "")
        if depth == 0:
            hierarchy = ""

        new_rows.append({
            "CATALOG_ID": f"geofabrik-{next_idx:04d}",
            "SOURCE": "geofabrik",
            "REGION_NAME": region_name,
            "REGION_KEY": candidate_key,
            "LOOKUP_NAME": canonicalize(region_name),
            "HIERARCHY": hierarchy,
            "CONTINENT": continent_name,
            "COUNTRY": country_name,
            "ISO_COUNTRY_A2": None,
            "ISO_COUNTRY_A3": None,
            "ISO_SUBDIVISION": None,
            "UN_M49": pd.NA,
            "PBF_URL": pbf_url,
            "PBF_SIZE_MB": None,
            "LEVEL": level,
            "MIN_LAT": None,
            "MAX_LAT": None,
            "MIN_LON": None,
            "MAX_LON": None,
            "BOUNDARY_WKB": None,
            "BOUNDARY_SOURCE": "pending",
            "BOUNDARY_VERTICES": 0,
            "BOUNDARY_AREA_KM2": 0.0,
            "BOUNDARY_BAKED_AT": date.today(),
        })
        existing_keys.add(candidate_key.lower())
        next_idx += 1

    print(f"New rows to append: {len(new_rows)}")
    if not new_rows:
        print("Nothing to do.")
        return 0

    df_new = pd.DataFrame(new_rows)
    print("New rows by LEVEL:")
    print(df_new["LEVEL"].value_counts().to_string())

    # Concat
    df_out = pd.concat([df_existing, df_new], ignore_index=True)

    # Coerce types per existing schema
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
    print(f"Wrote {PARQUET_PATH}  ({PARQUET_PATH.stat().st_size/1024:.1f} KB)  rows={len(df_out)}")
    print("\nNext: run scripts/region_catalog/build_boundaries.py to bake .poly polygons.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
