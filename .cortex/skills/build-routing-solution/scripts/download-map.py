# Download OSM PBF to Snowflake Stage
# This notebook downloads the OSM PBF files from internet to the Snowflake Stage.
# Warning: Large files will take significant time to download.

# Example variable names:
# url = "https://download.geofabrik.de/europe/albania-latest.osm.pbf"
# map_name = "albania-latest.osm.pbf"
# region_name = "albania"

import requests
import os
import sys 
from snowflake.snowpark import Session

url = sys.argv[0]
map_name = sys.argv[1]
region_name = sys.argv[2]

local_file = f"/tmp/{map_name}"

print(f"Downloading {map_name} file...")
print(f"URL: {url}")
print("Downloading file...")

response = requests.get(url, stream=True)

with open(local_file, 'wb') as f:
    for chunk in response.iter_content(chunk_size=8192000):
        if chunk:
            f.write(chunk)

print(f"\nDownload complete! File saved to: {local_file}")
print(f"File size: {os.path.getsize(local_file):,} bytes")

session = Session.builder.getOrCreate()

session.query_tag = {"origin":"sf_sit-is", 
                     "name":"oss-install-openrouteservice-native-app", 
                     "version":{"major":1, "minor":0},
                     "attributes":{"is_quickstart":1, "source":"notebook"}}

print("Uploading to Snowflake stage...")
stage_location = f"@openrouteservice_native_app.core.ors_spcs_stage/{region_name}"

put_result = session.file.put(
    local_file_name=local_file,
    stage_location=stage_location,
    auto_compress=False,
    overwrite=True
)

print("\nUpload complete!")
print(put_result)
