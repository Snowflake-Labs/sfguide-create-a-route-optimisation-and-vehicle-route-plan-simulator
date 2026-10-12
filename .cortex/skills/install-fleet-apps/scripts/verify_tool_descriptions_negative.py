#!/usr/bin/env python3
"""Negative tests for fleet_tools/user/verify_tool_descriptions.mts - each case
grows one MCP tool description past the per-tool budget the way it really
happens (an added sentence, an interpolated constant gaining an entry), across
all three bundles, and the suite must name the bundle/verb and the right limit."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

TOOLS = ".cortex/skills/install-fleet-apps/fleet_tools"
USER = f"{TOOLS}/user"
CODES = f"{USER}/src/codes.ts"
MATRIX_BUILD = f"{TOOLS}/ops/src/procs/matrix_build.ts"
CHECK_SUBSTRATE = f"{TOOLS}/admin/src/procs/check_substrate.ts"
RENDER_MAP = f"{USER}/src/procs/render_map.ts"

SENTENCE = ("Remember that the result is authoritative for the selected region only and "
            "must be relayed to the user verbatim, including any caveats it carries. ")

h = Harness("verify_tool_descriptions.mts", path=f"{USER}/verify_tool_descriptions.mts",
            cwd=USER, cmd=["npx", "tsx"])

# The reason the suite imports instead of regex-parsing: an INTERPOLATED constant
# grows the description with no edit to the description text at all.
h.replace(CODES, "export const ALLOWED_DYNAMIC_DBS = ['FLEET_APP', 'SNOWFLAKE', 'ROUTING_PLATFORM']",
          "export const ALLOWED_DYNAMIC_DBS = ['FLEET_APP', 'SNOWFLAKE', 'ROUTING_PLATFORM', "
          "'FLEET_INTELLIGENCE']",
          expect="user/render_map (render_map)",
          name="interpolated ALLOWED_DYNAMIC_DBS gains an entry (render_map over budget)")

# The historical incident: ~440 characters added to render_map broke the bundle.
h.replace(RENDER_MAP, "    'Draw a map inline in the answer from a declarative spec. ",
          "    '" + SENTENCE * 3 + "Draw a map inline in the answer from a declarative spec. ",
          expect="EXCEEDS the hard limit of 2500 - CREATE MCP SERVER will reject the whole bundle",
          name="~440 chars added to render_map (hard limit)")

# The cap is per tool, in EVERY bundle - an ops verb can break its own server.
h.replace(MATRIX_BUILD,
          "    'Start building a travel-time MATRIX for an already-provisioned routing region (tessellates ' +",
          "    '" + SENTENCE * 22 + "' +\n"
          "    'Start building a travel-time MATRIX for an already-provisioned routing region (tessellates ' +",
          expect="ops/matrix_build (matrix_build)",
          name="ops verb description over the hard limit")
h.replace(CHECK_SUBSTRATE,
          "    'Verify the routing substrate is present: counts the ORS engine CORE routing ' +",
          "    '" + SENTENCE * 22 + "' +\n"
          "    'Verify the routing substrate is present: counts the ORS engine CORE routing ' +",
          expect="admin/check_substrate (check_substrate)",
          name="admin verb description over the hard limit")

sys.exit(h.finish())
