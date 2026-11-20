#!/usr/bin/env python3
"""Negative tests for check_trip_path_budget.py. M1 is the shipped defect."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

PACK = ".cortex/skills/install-fleet-apps/fleet_sa_app/app/packs/fleet/route_deviation"
MODEL = f"{PACK}/data-model.yaml"
SETUP = f"{PACK}/setup.sql"
GEOM = "d.ACTUAL_PATH                                            AS PATH_GEOM"
FIRST = ("WHEN LENGTH(ST_ASGEOJSON(p.PATH_GEOM)::VARCHAR) <= 28000 "
         "THEN ST_ASGEOJSON(p.PATH_GEOM)::VARCHAR")

h = Harness("check_trip_path_budget.py")
h.replace(MODEL, GEOM, "ST_ASGEOJSON(ST_SIMPLIFY(d.ACTUAL_PATH, 250))::VARCHAR AS PATH_GEOM",
          expect="ST_SIMPLIFY applied directly", name="M1 fixed 250 m restored")
h.replace(SETUP, GEOM, "ST_SIMPLIFY(d.ACTUAL_PATH, 250) AS PATH_GEOM",
          expect="ST_SIMPLIFY applied directly", name="M2 fixed tolerance in generated setup only")
h.replace(MODEL, FIRST + "\n", "",
          expect="must send the unsimplified path", name="M3 full-resolution branch dropped")
h.replace(MODEL, "PATH_GEOM, 25))::VARCHAR) <= 28000", "PATH_GEOM, 25))::VARCHAR) <= 90000",
          expect="different budgets", name="M4 one branch over budget")
h.replace(MODEL, "<= 28000", "<= 40000", count=7,
          expect="exceeds 31000", name="M5 whole budget above the blank-map size")
h.replace(MODEL, "ELSE ST_ASGEOJSON(ST_SIMPLIFY(p.PATH_GEOM, 250))::VARCHAR\n", "",
          expect="no ELSE", name="M6 ELSE removed")
h.replace(SETUP, "END                                                      AS PATH_GEOJSON",
          "END AS PATH_JSON", expect="no `CASE ... END AS PATH_GEOJSON`",
          name="M7 ladder renamed away")
sys.exit(h.finish())
