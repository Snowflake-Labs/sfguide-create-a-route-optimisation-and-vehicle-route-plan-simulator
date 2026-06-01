#!/usr/bin/env python3
"""Build the SF-clipped IPAWS seed parquet for the emergency-response skill.

One-time developer task. Pages OpenFEMA's IpawsArchivedAlerts JSONL endpoint
since 2023-01-01 (status='Actual'), intersects each row's `searchGeometry`
with the SanFrancisco region polygon stored at
`.cortex/skills/emergency-response/assets/sf_boundary.geojson`, flattens the
`info[]` array to one row per (alert, info) pair, and writes
`.cortex/skills/emergency-response/assets/ipaws_sf.parquet`.

Run from repo root:
    python3 .cortex/skills/emergency-response/scripts/build_ipaws_sf_seed.py

Dependencies: requests, shapely, pyarrow.

Why this is a developer-machine script (not a Snowflake proc):
- OpenFEMA has no spatial filter or nested-event filter, so we must pull a
  time-bounded CONUS slice and intersect locally.
- The output parquet is committed and shipped as a static skill asset so the
  install pipeline has zero runtime API dependencies.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from urllib.parse import quote

import pyarrow as pa
import pyarrow.parquet as pq
import requests
from shapely.geometry import shape

REPO_ROOT = Path(__file__).resolve().parents[4]
ASSETS_DIR = REPO_ROOT / ".cortex" / "skills" / "emergency-response" / "assets"
BOUNDARY_PATH = ASSETS_DIR / "sf_boundary.geojson"
OUTPUT_PATH = ASSETS_DIR / "ipaws_sf.parquet"

API_BASE = "https://www.fema.gov/api/open/v1/IpawsArchivedAlerts.jsonl"
START_DATE = "2023-01-01T00:00:00.000Z"
PAGE_SIZE = 1000
MAX_RETRIES = 5
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "sf-emergency-response-seed-builder/1.0"})


def load_sf_polygon():
    geo = json.loads(BOUNDARY_PATH.read_text())
    poly = shape(geo)
    print(f"Loaded SF boundary: {poly.geom_type}, bounds={poly.bounds}")
    return poly


def fetch_page(skip: int) -> list[dict]:
    q = (
        f"$top={PAGE_SIZE}&$skip={skip}"
        f"&$filter=sent gt '{START_DATE}' and status eq 'Actual'"
        f"&$orderby=sent asc"
    )
    safe_chars = "=&$,'"
    url = f"{API_BASE}?{quote(q, safe=safe_chars)}"
    last_err: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            r = SESSION.get(url, timeout=120)
            r.raise_for_status()
            text = r.text.strip()
            if not text:
                return []
            return [json.loads(line) for line in text.splitlines() if line]
        except Exception as e:  # noqa: BLE001
            last_err = e
            wait = 2**attempt
            print(f"  page skip={skip} attempt {attempt + 1} failed: {e}; retry in {wait}s")
            time.sleep(wait)
    raise RuntimeError(f"Page skip={skip} failed after {MAX_RETRIES} retries") from last_err


def to_ts(value):
    if not value:
        return None
    return value


def flatten(rows: list[dict], sf_poly):
    out: list[dict] = []
    for r in rows:
        sg = r.get("searchGeometry")
        if not sg:
            continue
        try:
            geom = shape(sg)
        except Exception:  # noqa: BLE001
            continue
        if not geom.is_valid:
            geom = geom.buffer(0)
        if not geom.intersects(sf_poly):
            continue
        info_list = r.get("info") or [{}]
        sg_str = json.dumps(sg, separators=(",", ":"))
        for info in info_list:
            out.append(
                {
                    "alert_id": r.get("id"),
                    "sent_at": to_ts(r.get("sent")),
                    "status": r.get("status"),
                    "msg_type": r.get("msgType"),
                    "scope": r.get("scope"),
                    "sender": r.get("sender"),
                    "event": info.get("event") if isinstance(info, dict) else None,
                    "severity": info.get("severity") if isinstance(info, dict) else None,
                    "urgency": info.get("urgency") if isinstance(info, dict) else None,
                    "certainty": info.get("certainty") if isinstance(info, dict) else None,
                    "headline": info.get("headline") if isinstance(info, dict) else None,
                    "effective_at": to_ts(info.get("effective")) if isinstance(info, dict) else None,
                    "expires_at": to_ts(info.get("expires")) if isinstance(info, dict) else None,
                    "search_geometry_geojson": sg_str,
                }
            )
    return out


def main() -> int:
    sf_poly = load_sf_polygon()
    sf_poly_buffered = sf_poly.buffer(0)  # validate

    all_rows: list[dict] = []
    skip = 0
    pages = 0
    t0 = time.time()
    while True:
        page = fetch_page(skip)
        if not page:
            break
        kept = flatten(page, sf_poly_buffered)
        all_rows.extend(kept)
        pages += 1
        if pages % 10 == 0 or len(page) < PAGE_SIZE:
            elapsed = time.time() - t0
            print(
                f"  page {pages}: skip={skip} fetched={len(page)} sf_kept={len(kept)} "
                f"total_kept={len(all_rows)} elapsed={elapsed:.0f}s"
            )
        if len(page) < PAGE_SIZE:
            break
        skip += PAGE_SIZE

    if not all_rows:
        print("ERROR: no SF-intersecting rows found. Aborting.", file=sys.stderr)
        return 1

    print(f"Writing {len(all_rows):,} rows -> {OUTPUT_PATH}")
    table = pa.Table.from_pylist(all_rows)
    pq.write_table(table, OUTPUT_PATH, compression="snappy")
    sz = OUTPUT_PATH.stat().st_size
    print(f"Done. Parquet size: {sz / 1024:.1f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
