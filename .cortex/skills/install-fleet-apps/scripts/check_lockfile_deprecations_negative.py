#!/usr/bin/env python3
"""Negative tests for check_lockfile_deprecations.py - each case puts a
deprecated package back into a committed lockfile (the form npm records it in),
and the gate must name the lockfile and the package.

M1 and M2 are the two original defects: recharts 2.x in the SA app and the
snowflake-sdk 1.x transitive deprecations in the vendored synapse framework."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SKILL = ".cortex/skills/install-fleet-apps"
SA_LOCK = f"{SKILL}/fleet_sa_app/ui/package-lock.json"
SYN_LOCK = f"{SKILL}/fleet_tools/vendor/synapse/package-lock.json"
ADMIN_LOCK = f"{SKILL}/fleet_admin_app/ui/package-lock.json"

h = Harness("check_lockfile_deprecations.py")

h.replace(SA_LOCK, '"node_modules/recharts": {\n      "version": "3.10.1",\n',
          '"node_modules/recharts": {\n      "version": "2.15.4",\n'
          '      "deprecated": "1.x and 2.x branches are no longer active.",\n',
          expect="fleet_sa_app/ui/package-lock.json: recharts@2.15.4 is deprecated",
          name="M1 the original SA bug: recharts 2.x")

h.replace(SYN_LOCK, '"node_modules/snowflake-sdk": {\n      "version": "3.4.0",\n',
          '"node_modules/snowflake-sdk": {\n      "version": "3.4.0",\n'
          '      "deprecated": "uuid@10 and below is no longer supported.",\n',
          expect="fleet_tools/vendor/synapse/package-lock.json: snowflake-sdk@3.4.0 is deprecated",
          name="M2 a deprecated entry in the vendored synapse lockfile")

h.add(f"{SKILL}/fleet_tools/newbundle/package-lock.json",
      '{"name": "x", "lockfileVersion": 3, "packages": {"": {"name": "x"}, '
      '"node_modules/a/node_modules/glob": {"version": "10.5.0", "deprecated": "Old versions of glob"}}}\n',
      expect="newbundle/package-lock.json: glob@10.5.0 is deprecated",
      name="M3 a new lockfile with a nested deprecated package")

h.replace(ADMIN_LOCK, '"lockfileVersion"', '"lockfileVersion"x',
          expect="fleet_admin_app/ui/package-lock.json: not valid JSON",
          name="M4 an unparseable lockfile is a failure, not a silent skip")

sys.exit(h.finish())
