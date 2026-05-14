#!/usr/bin/env python3
"""
Bake region boundary polygons + ISO codes into the REGION_CATALOG seed parquet.

For Geofabrik rows (~222), download the corresponding .poly file (Osmosis polygon
filter format) which is the EXACT clip mask used to cut each .osm.pbf extract.
For BBBike rows (~238), the .osm.pbf is clipped to a rectangle so the bbox is the
true boundary.

Output columns appended to datasets/region_catalog/data_0_0_0.snappy.parquet:
    LOOKUP_NAME         VARCHAR    canonical name consumers use post-load
    ISO_COUNTRY_A2      VARCHAR    ISO 3166-1 alpha-2
    ISO_COUNTRY_A3      VARCHAR    ISO 3166-1 alpha-3
    ISO_SUBDIVISION     VARCHAR    ISO 3166-2 (best-effort)
    UN_M49              INT        UN M49 numeric country code
    BOUNDARY_WKB        VARCHAR    WKB hex of simplified polygon
    BOUNDARY_SOURCE     VARCHAR    'geofabrik-poly' | 'bbbike-bbox' | 'manual-bbox'
    BOUNDARY_VERTICES   INT        vertex count post-simplify
    BOUNDARY_AREA_KM2   FLOAT      area in km^2
    BOUNDARY_BAKED_AT   DATE       bake date

When to re-run:
    * Geofabrik publishes a meaningful boundary change (rare, ~yearly for
      admin shifts).
    * A new region is added to the catalog (e.g. a city added via the dynamic
      catalog refresh path - see ors_control_app/server/index.ts which
      currently captures bbox only). Re-running this script picks up new
      Geofabrik regions automatically; BBBike additions need a manual
      refresh of the upstream seed.
    * manual_iso_overrides.json is updated with corrected codes.

Run:
    python3 datasets/region_catalog/build_boundaries.py

Idempotent. Caches downloaded .poly files in tmp/poly_cache/ so reruns are fast.
After running, commit the updated parquet:
    git add datasets/region_catalog/data_0_0_0.snappy.parquet
    git commit -m "data(region-catalog): refresh boundary snapshot"
"""
from __future__ import annotations

import json
import math
import re
import sys
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path
from typing import Optional

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pycountry
import requests
from shapely.geometry import Polygon, MultiPolygon, box
from shapely.ops import unary_union

REPO_ROOT = Path(__file__).resolve().parents[2]
PARQUET_PATH = REPO_ROOT / "datasets" / "region_catalog" / "data_0_0_0.snappy.parquet"
POLY_CACHE = REPO_ROOT / "tmp" / "poly_cache"
OVERRIDES_PATH = Path(__file__).parent / "manual_iso_overrides.json"

SIMPLIFY_TOLERANCE_DEG = 0.001  # ~100m at equator
HTTP_TIMEOUT = 30
MAX_WORKERS = 16


# ---------------------------------------------------------------------------
# Osmosis .poly format parser
# https://wiki.openstreetmap.org/wiki/Osmosis/Polygon_Filter_File_Format
# ---------------------------------------------------------------------------
def parse_osmosis_poly(text: str) -> Optional[MultiPolygon]:
    lines = [ln.rstrip("\n").strip() for ln in text.splitlines()]
    i = 0
    n = len(lines)
    if n < 3:
        return None
    # First line is the polygon name; ignore.
    i = 1
    rings: list[tuple[bool, list[tuple[float, float]]]] = []
    while i < n:
        section = lines[i]
        if not section or section.upper() == "END":
            break
        is_hole = section.startswith("!")
        i += 1
        coords: list[tuple[float, float]] = []
        while i < n and lines[i].upper() != "END":
            parts = lines[i].split()
            if len(parts) >= 2:
                try:
                    lon = float(parts[0])
                    lat = float(parts[1])
                    coords.append((lon, lat))
                except ValueError:
                    pass
            i += 1
        i += 1  # skip END of section
        if len(coords) >= 3:
            rings.append((is_hole, coords))

    if not rings:
        return None

    # Build polygons: outer rings + their holes.
    outers: list[Polygon] = []
    holes_for: list[list[list[tuple[float, float]]]] = []
    for is_hole, coords in rings:
        if not is_hole:
            outers.append(Polygon(coords))
            holes_for.append([])
        else:
            # Attach hole to whichever outer contains its first vertex.
            attached = False
            test_pt = Polygon([coords[0], coords[0], coords[0]])  # noqa: not needed
            from shapely.geometry import Point
            pt = Point(coords[0])
            for j, outer in enumerate(outers):
                if outer.contains(pt):
                    holes_for[j].append(coords)
                    attached = True
                    break
            if not attached and outers:
                # Fallback: attach to last outer.
                holes_for[-1].append(coords)

    polys: list[Polygon] = []
    for j, outer in enumerate(outers):
        try:
            polys.append(Polygon(outer.exterior.coords, holes_for[j]))
        except Exception:
            polys.append(outer)

    if not polys:
        return None
    if len(polys) == 1:
        return MultiPolygon(polys)
    return MultiPolygon(polys)


# ---------------------------------------------------------------------------
# Derive .poly URL from .osm.pbf URL
# Geofabrik convention: <base>-latest.osm.pbf  ->  <base>.poly
# ---------------------------------------------------------------------------
def poly_url_for_pbf(pbf_url: str) -> Optional[str]:
    if not pbf_url:
        return None
    if "geofabrik.de" not in pbf_url:
        return None
    if pbf_url.endswith("-latest.osm.pbf"):
        return pbf_url[: -len("-latest.osm.pbf")] + ".poly"
    return None


def fetch_poly(url: str, cache_dir: Path) -> Optional[str]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", url)
    cached = cache_dir / safe
    if cached.exists() and cached.stat().st_size > 0:
        return cached.read_text(encoding="utf-8", errors="replace")
    try:
        r = requests.get(url, timeout=HTTP_TIMEOUT)
        if r.status_code != 200 or not r.text:
            return None
        cached.write_text(r.text, encoding="utf-8")
        return r.text
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Area on a sphere (km^2)
# ---------------------------------------------------------------------------
def _ring_area_steradians(coords: list[tuple[float, float]]) -> float:
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
    EARTH_RADIUS_KM = 6371.0088
    if geom.is_empty:
        return 0.0
    if geom.geom_type == "Polygon":
        polys = [geom]
    elif geom.geom_type == "MultiPolygon":
        polys = list(geom.geoms)
    else:
        return 0.0
    total = 0.0
    for p in polys:
        ext = list(p.exterior.coords)
        total += _ring_area_steradians(ext) * (EARTH_RADIUS_KM ** 2)
        for ring in p.interiors:
            total -= _ring_area_steradians(list(ring.coords)) * (EARTH_RADIUS_KM ** 2)
    return abs(total)


def vertex_count(geom) -> int:
    if geom.is_empty:
        return 0
    if geom.geom_type == "Polygon":
        polys = [geom]
    elif geom.geom_type == "MultiPolygon":
        polys = list(geom.geoms)
    else:
        return 0
    n = 0
    for p in polys:
        n += len(p.exterior.coords)
        for r in p.interiors:
            n += len(r.coords)
    return n


# ---------------------------------------------------------------------------
# Canonical lookup name (matches REGION_REGISTRY.ORS_REGION_KEY style)
# ---------------------------------------------------------------------------
def canonicalize(name: str) -> str:
    if not name:
        return ""
    nfkd = unicodedata.normalize("NFKD", name)
    ascii_only = "".join(c for c in nfkd if not unicodedata.combining(c))
    # Title-case-ish, drop spaces / punctuation.
    parts = re.split(r"[^A-Za-z0-9]+", ascii_only)
    parts = [p for p in parts if p]
    if not parts:
        return ""
    return "".join(p[0].upper() + p[1:] for p in parts)


# ---------------------------------------------------------------------------
# ISO lookups via pycountry
# ---------------------------------------------------------------------------
def _load_overrides() -> dict:
    if OVERRIDES_PATH.exists():
        try:
            return json.loads(OVERRIDES_PATH.read_text())
        except Exception:
            return {}
    return {}


def lookup_country(country_name: Optional[str], overrides: dict) -> tuple[Optional[str], Optional[str], Optional[int]]:
    if not country_name:
        return None, None, None
    key = country_name.strip().lower()
    if key in overrides.get("countries", {}):
        ov = overrides["countries"][key]
        return ov.get("a2"), ov.get("a3"), ov.get("m49")
    candidates = [country_name]
    # Geofabrik uses a few non-pycountry names; map common ones.
    aliases = {
        "russia": "Russian Federation",
        "south-korea": "Korea, Republic of",
        "korea": "Korea, Republic of",
        "north-korea": "Korea, Democratic People's Republic of",
        "iran": "Iran, Islamic Republic of",
        "syria": "Syrian Arab Republic",
        "vietnam": "Viet Nam",
        "laos": "Lao People's Democratic Republic",
        "moldova": "Moldova, Republic of",
        "venezuela": "Venezuela, Bolivarian Republic of",
        "bolivia": "Bolivia, Plurinational State of",
        "tanzania": "Tanzania, United Republic of",
        "taiwan": "Taiwan, Province of China",
        "macao": "Macao",
        "macau": "Macao",
        "czech-republic": "Czechia",
        "czech republic": "Czechia",
        "ivory-coast": "Côte d'Ivoire",
        "ivory coast": "Côte d'Ivoire",
        "cape-verde": "Cabo Verde",
        "cape verde": "Cabo Verde",
        "uk": "United Kingdom",
        "great-britain": "United Kingdom",
        "great britain": "United Kingdom",
        "usa": "United States",
        "united-states": "United States",
        "us": "United States",
        "swaziland": "Eswatini",
        "comores": "Comoros",
        "east timor": "Timor-Leste",
        "azores": "Portugal",
        "canary islands": "Spain",
        "guernsey and jersey": "GG",  # use a2 directly
        "turkey": "Türkiye",
        "ukraine (with crimea)": "Ukraine",
        "south africa (includes lesotho)": "South Africa",
        "indonesia (with east timor)": "Indonesia",
        "myanmar (a.k.a. burma)": "Myanmar",
        "polynésie française (french polynesia)": "French Polynesia",
        "wallis et futuna": "Wallis and Futuna",
        "île de clipperton": "France",
        "bosnia-herzegovina": "Bosnia and Herzegovina",
        "congo (republic/brazzaville)": "Congo",
        "congo (democratic republic/kinshasa)": "Congo, The Democratic Republic of the",
    }
    if key in aliases:
        candidates.insert(0, aliases[key])
    for cand in candidates:
        try:
            c = pycountry.countries.lookup(cand)
            return c.alpha_2, c.alpha_3, int(c.numeric)
        except LookupError:
            continue
    # Fuzzy as last resort.
    try:
        matches = pycountry.countries.search_fuzzy(country_name)
        if matches:
            c = matches[0]
            return c.alpha_2, c.alpha_3, int(c.numeric)
    except (LookupError, AttributeError):
        pass
    return None, None, None


def lookup_subdivision(region_name: str, country_a2: Optional[str], overrides: dict) -> Optional[str]:
    if not region_name or not country_a2:
        return None
    key = f"{country_a2}:{region_name.strip().lower()}"
    if key in overrides.get("subdivisions", {}):
        return overrides["subdivisions"][key]
    # Try direct lookup.
    candidates = [region_name]
    # Strip common Geofabrik suffixes/prefixes.
    cleaned = re.sub(r"\s*\(.*?\)\s*$", "", region_name).strip()
    if cleaned and cleaned != region_name:
        candidates.append(cleaned)
    for cand in candidates:
        try:
            subs = list(pycountry.subdivisions.get(country_code=country_a2) or [])
            for s in subs:
                if s.name.lower() == cand.lower():
                    return s.code
            # Loose match.
            for s in subs:
                if cand.lower() in s.name.lower() or s.name.lower() in cand.lower():
                    return s.code
        except Exception:
            continue
    return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def process_geofabrik_row(row: dict) -> dict:
    pbf = row.get("PBF_URL", "")
    poly_url = poly_url_for_pbf(pbf)
    if not poly_url:
        return {"BOUNDARY_WKB": None, "BOUNDARY_SOURCE": "missing", "BOUNDARY_VERTICES": 0, "BOUNDARY_AREA_KM2": 0.0}
    text = fetch_poly(poly_url, POLY_CACHE)
    if not text:
        # Fall back to bbox.
        return _bbox_result(row, "manual-bbox")
    geom = parse_osmosis_poly(text)
    if geom is None or geom.is_empty:
        return _bbox_result(row, "manual-bbox")
    # Make valid + simplify.
    if not geom.is_valid:
        geom = geom.buffer(0)
    simp = geom.simplify(SIMPLIFY_TOLERANCE_DEG, preserve_topology=True)
    if simp.is_empty or not simp.is_valid:
        simp = geom
    if simp.geom_type == "Polygon":
        simp = MultiPolygon([simp])
    return {
        "BOUNDARY_WKB": simp.wkb_hex,
        "BOUNDARY_SOURCE": "geofabrik-poly",
        "BOUNDARY_VERTICES": vertex_count(simp),
        "BOUNDARY_AREA_KM2": geographic_area_km2(simp),
    }


def _bbox_result(row: dict, src: str) -> dict:
    try:
        b = box(row["MIN_LON"], row["MIN_LAT"], row["MAX_LON"], row["MAX_LAT"])
        mp = MultiPolygon([b])
        return {
            "BOUNDARY_WKB": mp.wkb_hex,
            "BOUNDARY_SOURCE": src,
            "BOUNDARY_VERTICES": vertex_count(mp),
            "BOUNDARY_AREA_KM2": geographic_area_km2(mp),
        }
    except Exception:
        return {"BOUNDARY_WKB": None, "BOUNDARY_SOURCE": "missing", "BOUNDARY_VERTICES": 0, "BOUNDARY_AREA_KM2": 0.0}


def main() -> int:
    print(f"Reading {PARQUET_PATH}")
    table = pq.read_table(PARQUET_PATH)
    df = table.to_pandas()
    print(f"  {len(df)} rows ({df['SOURCE'].value_counts().to_dict()})")

    overrides = _load_overrides()

    # Process each row.
    boundary_results: list[dict] = [None] * len(df)
    geofabrik_idx = [i for i, s in enumerate(df["SOURCE"]) if s == "geofabrik"]
    bbbike_idx = [i for i, s in enumerate(df["SOURCE"]) if s == "bbbike"]

    print(f"Fetching {len(geofabrik_idx)} Geofabrik .poly files in parallel...")
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futs = {
            ex.submit(process_geofabrik_row, df.iloc[i].to_dict()): i
            for i in geofabrik_idx
        }
        done = 0
        for fut in as_completed(futs):
            i = futs[fut]
            try:
                boundary_results[i] = fut.result()
            except Exception as e:
                print(f"  [warn] row {i} ({df.iloc[i]['REGION_NAME']}) failed: {e}")
                boundary_results[i] = _bbox_result(df.iloc[i].to_dict(), "manual-bbox")
            done += 1
            if done % 25 == 0:
                print(f"  ...{done}/{len(geofabrik_idx)}  ({time.time()-t0:.1f}s)")
    print(f"Geofabrik done in {time.time()-t0:.1f}s")

    # Retry pass for any geofabrik rows that fell back to manual-bbox
    # (transient HTTP errors during the parallel fetch).
    retry_idx = [i for i in geofabrik_idx if boundary_results[i] and boundary_results[i].get("BOUNDARY_SOURCE") == "manual-bbox"]
    if retry_idx:
        print(f"Retry pass for {len(retry_idx)} Geofabrik rows that fell back to bbox...")
        for i in retry_idx:
            time.sleep(0.2)  # be gentle on the server
            r = process_geofabrik_row(df.iloc[i].to_dict())
            if r["BOUNDARY_SOURCE"] == "geofabrik-poly":
                boundary_results[i] = r
                print(f"  recovered: {df.iloc[i]['REGION_NAME']}")
        recovered = sum(1 for i in retry_idx if boundary_results[i].get("BOUNDARY_SOURCE") == "geofabrik-poly")
        print(f"Recovered {recovered}/{len(retry_idx)} on retry")

    print(f"Building {len(bbbike_idx)} BBBike rectangles...")
    for i in bbbike_idx:
        boundary_results[i] = _bbox_result(df.iloc[i].to_dict(), "bbbike-bbox")

    # Build new columns.
    df["LOOKUP_NAME"] = df["REGION_NAME"].apply(canonicalize)
    iso_a2, iso_a3, m49 = [], [], []
    for _, row in df.iterrows():
        a2, a3, m = lookup_country(row.get("COUNTRY"), overrides)
        iso_a2.append(a2)
        iso_a3.append(a3)
        m49.append(m)
    df["ISO_COUNTRY_A2"] = iso_a2
    df["ISO_COUNTRY_A3"] = iso_a3
    df["UN_M49"] = m49

    iso_sub = []
    for _, row in df.iterrows():
        if row.get("LEVEL") in ("subregion", "sub-region", "state", "province"):
            iso_sub.append(lookup_subdivision(row.get("REGION_NAME"), row.get("ISO_COUNTRY_A2"), overrides))
        else:
            iso_sub.append(None)
    df["ISO_SUBDIVISION"] = iso_sub

    df["BOUNDARY_WKB"] = [r["BOUNDARY_WKB"] for r in boundary_results]
    df["BOUNDARY_SOURCE"] = [r["BOUNDARY_SOURCE"] for r in boundary_results]
    df["BOUNDARY_VERTICES"] = [r["BOUNDARY_VERTICES"] for r in boundary_results]
    df["BOUNDARY_AREA_KM2"] = [r["BOUNDARY_AREA_KM2"] for r in boundary_results]
    df["BOUNDARY_BAKED_AT"] = pd.to_datetime(date.today())

    # Reorder columns.
    new_cols = [
        "CATALOG_ID", "SOURCE",
        "REGION_NAME", "REGION_KEY", "LOOKUP_NAME",
        "HIERARCHY", "CONTINENT", "COUNTRY",
        "ISO_COUNTRY_A2", "ISO_COUNTRY_A3", "ISO_SUBDIVISION", "UN_M49",
        "PBF_URL", "PBF_SIZE_MB", "LEVEL",
        "MIN_LAT", "MAX_LAT", "MIN_LON", "MAX_LON",
        "BOUNDARY_WKB", "BOUNDARY_SOURCE", "BOUNDARY_VERTICES", "BOUNDARY_AREA_KM2", "BOUNDARY_BAKED_AT",
    ]
    df = df[new_cols]

    # Schema with explicit types.
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

    # Coerce types.
    df["UN_M49"] = pd.array(df["UN_M49"], dtype="Int32")
    df["BOUNDARY_VERTICES"] = pd.array(df["BOUNDARY_VERTICES"], dtype="Int32")
    df["BOUNDARY_BAKED_AT"] = df["BOUNDARY_BAKED_AT"].dt.date

    out_table = pa.Table.from_pandas(df, schema=schema, preserve_index=False)
    pq.write_table(out_table, PARQUET_PATH, compression="snappy")
    print(f"Wrote {PARQUET_PATH}  ({PARQUET_PATH.stat().st_size/1024:.1f} KB)")

    # Summary.
    print("\nBoundary source distribution:")
    print(df["BOUNDARY_SOURCE"].value_counts().to_string())
    print(f"\nISO country coverage: {df['ISO_COUNTRY_A2'].notna().sum()} / {len(df)}")
    print(f"ISO subdivision coverage: {df['ISO_SUBDIVISION'].notna().sum()} / {len(df)}")
    print(f"\nMean vertices: {df['BOUNDARY_VERTICES'].mean():.0f}")
    print(f"Total area covered: {df['BOUNDARY_AREA_KM2'].sum()/1e6:.2f} M km^2")

    # Show smallest + largest as sanity check.
    have = df[df["BOUNDARY_AREA_KM2"] > 0]
    print("\n5 smallest boundaries:")
    print(have.nsmallest(5, "BOUNDARY_AREA_KM2")[["REGION_NAME", "BOUNDARY_AREA_KM2", "BOUNDARY_VERTICES", "BOUNDARY_SOURCE"]].to_string(index=False))
    print("\n5 largest boundaries:")
    print(have.nlargest(5, "BOUNDARY_AREA_KM2")[["REGION_NAME", "BOUNDARY_AREA_KM2", "BOUNDARY_VERTICES", "BOUNDARY_SOURCE"]].to_string(index=False))

    return 0


if __name__ == "__main__":
    sys.exit(main())
