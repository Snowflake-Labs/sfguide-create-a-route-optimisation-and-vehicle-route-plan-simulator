#!/usr/bin/env python3
"""Download OSM PBF file and upload to Snowflake stage.

Usage:
    python download_map.py <url> <map_name> <region_name> [--connection <conn>]

Example:
    python download_map.py \
        "https://download.geofabrik.de/europe/albania-latest.osm.pbf" \
        "albania-latest.osm.pbf" \
        "albania" \
        --connection fleet_test_evals
"""

import argparse
import os
import sys

import requests
import snowflake.connector


def download_file(url: str, dest: str) -> None:
    print(f"Downloading from: {url}")
    response = requests.get(url, stream=True)
    response.raise_for_status()
    total = int(response.headers.get("content-length", 0))
    downloaded = 0
    with open(dest, "wb") as f:
        for chunk in response.iter_content(chunk_size=8_192_000):
            if chunk:
                f.write(chunk)
                downloaded += len(chunk)
                if total:
                    pct = downloaded * 100 // total
                    print(f"\r  {pct}% ({downloaded:,}/{total:,} bytes)", end="", flush=True)
    print(f"\nDownload complete: {dest} ({os.path.getsize(dest):,} bytes)")


def upload_to_stage(conn, local_file: str, region_name: str) -> None:
    stage_location = f"@openrouteservice_native_app.core.ors_spcs_stage/{region_name}"
    print(f"Uploading to {stage_location} ...")
    cur = conn.cursor()
    cur.execute(
        f"PUT 'file://{local_file}' '{stage_location}' AUTO_COMPRESS=FALSE OVERWRITE=TRUE"
    )
    for row in cur:
        print(f"  {row}")
    cur.close()
    print("Upload complete!")


def main():
    parser = argparse.ArgumentParser(description="Download OSM PBF and upload to Snowflake stage")
    parser.add_argument("url", help="URL of the OSM PBF file")
    parser.add_argument("map_name", help="Filename for the downloaded PBF (e.g. albania-latest.osm.pbf)")
    parser.add_argument("region_name", help="Region folder name on stage (e.g. albania)")
    parser.add_argument("--connection", default=os.getenv("SNOWFLAKE_CONNECTION_NAME", "default"),
                        help="Snowflake connection name (default: $SNOWFLAKE_CONNECTION_NAME or 'default')")
    args = parser.parse_args()

    local_file = f"/tmp/{args.map_name}"
    download_file(args.url, local_file)

    conn = snowflake.connector.connect(connection_name=args.connection)
    try:
        upload_to_stage(conn, local_file, args.region_name)
    finally:
        conn.close()
        if os.path.exists(local_file):
            os.remove(local_file)
            print(f"Cleaned up {local_file}")


if __name__ == "__main__":
    main()
