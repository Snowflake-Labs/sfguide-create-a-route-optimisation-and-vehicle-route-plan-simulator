#!/usr/bin/env python3
"""Negative tests for check_sf_connect.py: each mutation brings back one way the
connector 5.x FutureWarnings returned to the install console.

M1 is the original defect: a helper calling snowflake.connector.connect() itself."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

S = ".cortex/skills/install-fleet-apps/scripts"
h = Harness("check_sf_connect.py")

h.replace(f"{S}/reconcile_existing.py",
          "        from sf_connect import connect\n        self.connection = connect(\n            connection,\n",
          "        import snowflake.connector\n        self.connection = snowflake.connector.connect(\n            connection_name=connection,\n",
          expect="reconcile_existing.py calls snowflake.connector.connect() directly",
          name="M1 the original bug: helper bypasses sf_connect")
h.replace(f"{S}/sf_connect.py", "        kwargs.setdefault(KEEP_ALIVE, False)\n", "        pass\n",
          expect="not passed", name="M2 keep-alive option never set")
h.replace(f"{S}/sf_connect.py", "    if _supports(KEEP_ALIVE):\n        kwargs.setdefault(KEEP_ALIVE, False)\n",
          "    kwargs.setdefault(KEEP_ALIVE, False)\n",
          expect="3.x-style connector", name="M3 option passed to connectors that reject it")
h.replace(f"{S}/sf_connect.py", "@atexit.register\n", "", expect="not closed at exit",
          name="M4 connections never closed")
# Cycle-3 defect: close-at-exit alone still warned, because the connector's
# per-connection hook runs first (LIFO) and fires before ours.
h.replace(f"{S}/sf_connect.py", "        kwargs.setdefault(AUTO_CLEANUP, False)\n", "        pass\n",
          expect="exit hook warned before sf_connect closed",
          name="M7 the shipped bug: connector auto_cleanup left on")
h.replace(f"{S}/download_map.py", '            kw["enable_server_session_keep_alive_auto_detection"] = False\n',
          "            pass\n", expect="download_map.py (standalone) lacks",
          name="M5 standalone staged helper loses its inline guard")
h.add(f"{S}/new_helper.py", "import snowflake.connector\nc = snowflake.connector.connect(connection_name='x')\n",
      expect="new_helper.py calls snowflake.connector.connect() directly",
      name="M6 a new helper added without sf_connect")

sys.exit(h.finish())
