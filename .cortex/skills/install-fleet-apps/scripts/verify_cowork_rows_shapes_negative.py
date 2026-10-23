#!/usr/bin/env python3
"""Negative tests for fleet_tools/user/verify_cowork_rows_shapes.mts - each case
breaks one way the extractor turns a TOOL_* payload into CoWork-drawable rows."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

USER = ".cortex/skills/install-fleet-apps/fleet_tools/user"
MOD = f"{USER}/src/map_rows.ts"

h = Harness("verify_cowork_rows_shapes.mts", path=f"{USER}/verify_cowork_rows_shapes.mts", cwd=USER,
            cmd=["npx", "tsx"])

# A FeatureCollection must be exploded into one row per feature.
h.replace(MOD, "    case 'FeatureCollection':\n      return collectGeometries(o.features, out);\n",
          "    case 'FeatureCollection':\n      out.push(o);\n      return out;\n",
          expect="FAIL FeatureCollection exploded", name="FeatureCollection kept as one cell")
# Points must never share the GEOJSON array with lines and polygons.
h.replace(MOD, "const DRAWABLE = new Set(['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']);",
          "const DRAWABLE = new Set(['Point', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']);",
          expect="FAIL FeatureCollection exploded, points dropped", name="points admitted to the geojson rows")
# VROOM/ORS route geometry arrives as an encoded polyline string.
h.replace(MOD, "    deltas.push(acc & 1 ? ~(acc >> 1) : acc >> 1);",
          "    deltas.push(acc >> 1);",
          expect="FAIL encoded polyline", name="polyline sign bit ignored")
# An unsnapped point (null coordinates) must not become a row.
h.replace(MOD, "    if (lon === null || lat === null) continue;\n", "",
          expect="FAIL snap: unsnapped omitted", name="null coordinates kept")
# The point cap is what keeps a large Overture list under the inline payload limit.
h.replace(MOD, "    if (rows.length >= POINT_CAP) break;\n", "",
          expect="FAIL point cap holds row count", name="point row cap removed")
# (The byte cap in pointRows is a backstop only: 2,000 LON/LAT rows are ~100 KB,
# so the row cap always binds first and removing the byte cap is not a defect.)

sys.exit(h.finish())
