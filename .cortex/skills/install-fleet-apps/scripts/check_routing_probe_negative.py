#!/usr/bin/env python3
"""Negative tests for check_routing_probe.py - each case re-introduces one of
the routing-path defects decomposed from the hung SF-to-LA agent turn (or the
snap/match typing defect) and the gate must convict it with that rule's id."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

TOOLS = ".cortex/skills/routing-agent/references/deploy-agent.sql"
MODULE = ".cortex/skills/install-fleet-apps/openrouteservice_app/app/modules/02_routing_functions.sql"
DROP_2ARG = "DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_DIRECTIONS(VARCHAR, VARCHAR);\n"

h = Harness("check_routing_probe.py")

# RULE A - the unboundable ORS_STATUS probe back on the routing path (the first
# PROFILES_FOR_REGION read in the file is TOOL_DIRECTIONS').
h.replace(TOOLS, "SELECT OPENROUTESERVICE_APP.CORE.PROFILES_FOR_REGION(:v_region) INTO :v_available;",
          "SELECT OBJECT_KEYS(OPENROUTESERVICE_APP.CORE.ORS_STATUS(NULL):profiles) INTO :v_available;",
          expect="RULE A: TOOL_DIRECTIONS", name="A: ORS_STATUS probe restored in TOOL_DIRECTIONS")

# RULE B - CORE.DIRECTIONS called without a region (default-region graph)
h.replace(TOOLS,
          "            OBJECT_CONSTRUCT(''coordinates'', PARSE_JSON(?))::VARIANT,\n"
          "            ''' || v_region || ''')) d';",
          "            OBJECT_CONSTRUCT(''coordinates'', PARSE_JSON(?))::VARIANT)) d';",
          expect="with 2 argument(s) and no region", name="B: DIRECTIONS called with no region")

# RULE C - JSON-null duration cell read without ::FLOAT, and the pre-flight removed
h.replace(TOOLS, "m.R:durations[s.INDEX][s.INDEX + 1]::FLOAT AS SECS",
          "m.R:durations[s.INDEX][s.INDEX + 1] AS SECS",
          expect="without ::FLOAT (found no cast)", name="C: duration cell read uncast")
h.replace(TOOLS, "m.R:durations[s.INDEX][s.INDEX + 1]::FLOAT AS SECS", "NULL::FLOAT AS SECS",
          expect="indexes no matrix durations cell", name="C: unroutable-leg pre-flight removed")

# RULE D - stale 2-arg signature never dropped, or dropped AFTER the CREATE
h.replace(TOOLS, DROP_2ARG, "", expect="stale (VARCHAR, VARCHAR) signature is never dropped",
          name="D: stale 2-arg TOOL_DIRECTIONS not dropped")
tools = h.path(TOOLS)
tools_original = tools.read_text()
ALTER = "ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_DIRECTIONS(VARCHAR, VARCHAR, VARCHAR) SET COMMENT"


def drop_after_create():
    assert DROP_2ARG in tools_original and ALTER in tools_original, "D anchors drifted"
    text = tools_original.replace(DROP_2ARG, "", 1)
    at = text.index("\n", text.index(ALTER)) + 1
    tools.write_text(text[:at] + DROP_2ARG + text[at:])


h.custom("D: DROP moved after the CREATE", drop_after_create,
         lambda: tools.write_text(tools_original), expect="sits AFTER the CREATE")

# RULE E - the table-only profile lookup probes the engine itself, or is gone
h.replace(MODULE,
          "     SELECT ARRAY_AGG(DISTINCT LOWER(p.PROFILE)) AS PROFILES\n"
          "     FROM OPENROUTESERVICE_APP.CORE.REGION_PROFILES p, target t\n",
          "     SELECT OBJECT_KEYS(OPENROUTESERVICE_APP.CORE.ORS_STATUS(t.R):profiles) AS PROFILES\n"
          "     FROM target t\n",
          expect="RULE E: CORE.PROFILES_FOR_REGION calls ORS_STATUS",
          name="E: PROFILES_FOR_REGION probes ORS_STATUS (hang one level down)")
h.replace(MODULE, "FUNCTION OPENROUTESERVICE_APP.CORE.PROFILES_FOR_REGION(",
          "FUNCTION OPENROUTESERVICE_APP.CORE.PROFILES_FOR_REGION_CACHED(",
          expect="RULE E: CORE.PROFILES_FOR_REGION not found", name="E: profile lookup renamed away")

# RULE F - region resolved per point, profiles validated against the default
h.replace(TOOLS,
          "    v_region_lit := IFF(:v_region IS NULL, 'NULL::VARCHAR', '''' || :v_region || '''');\n\n"
          "    BEGIN\n"
          "        SELECT OPENROUTESERVICE_APP.CORE.PROFILES_FOR_REGION(:v_region) INTO :v_available;",
          "    v_region_lit := IFF(:v_region IS NULL, 'NULL::VARCHAR', '''' || :v_region || '''');\n\n"
          "    BEGIN\n"
          "        SELECT OPENROUTESERVICE_APP.CORE.PROFILES_FOR_REGION(NULL) INTO :v_available;",
          expect="but calls PROFILES_FOR_REGION(NULL)", name="F: per-point region, default-region profiles")

# RULE G - the shipped snap_to_road defect, one half at a time
h.replace(TOOLS, "PARSE_JSON(?)::ARRAY, ' || v_radius || ', ' || v_region_lit || ')) s'",
          "PARSE_JSON(?)::ARRAY, ' || v_radius || ', NULL)) s'",
          expect="passes a bare NULL as argument 4 of CORE.SNAP_POINTS", name="G: bare NULL region to SNAP_POINTS")
h.replace(TOOLS, "MATCH_PATH(''' || v_used || ''', PARSE_JSON(?)::ARRAY,",
          "MATCH_PATH(''' || v_used || ''', PARSE_JSON(?),",
          expect="as argument 2 of CORE.MATCH_PATH, declared ARRAY", name="G: VARIANT passed for an ARRAY parameter")

sys.exit(h.finish())
