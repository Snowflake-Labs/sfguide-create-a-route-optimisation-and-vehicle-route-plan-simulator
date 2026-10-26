#!/usr/bin/env python3
"""Negative tests for check_install_console_noise.py."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

S = ".cortex/skills/install-fleet-apps/scripts"
PE, INST, RSM = f"{S}/provision_engine.sh", f"{S}/install_fleet_apps.sh", f"{S}/run_sql_module.sh"
h = Harness("check_install_console_noise.py")

# The shipped defect: modules loaded with the statement echo on.
h.replace(PE, '    QUIET=1 bash "$SCRIPTS/run_sql_module.sh"', '    bash "$SCRIPTS/run_sql_module.sh"',
          expect="RULE A provision_engine.sh runs a module without QUIET=1",
          name="A: engine modules loaded with full statement echo")
h.replace(RSM, "| grep -E '^[0-9]{6} \\([0-9A-Z]{5}\\)' | head -5", "| head -0",
          expect="RULE B run_sql_module.sh does not print the SQL errors on a QUIET failure",
          name="B: QUIET failure prints only a log path")
h.replace(PE, 'snow sql -c "$CONN" --format CSV -q "$TAG_SQL SHOW SERVICES',
          'snow sql -c "$CONN" -q "$TAG_SQL SHOW SERVICES',
          expect="RULE C SHOW SERVICES printed as a default table",
          name="C: SHOW SERVICES in the default table format")
h.replace(PE, 'if [ "${FLEET_INSTALLER:-0}" = "1" ]; then\n  echo "   The installer continues and waits for the graph before it finishes."\nelse\n',
          "",
          expect="RULE D 'Re-run install_fleet_apps.sh' is printed unconditionally",
          name="D: re-run advice printed inside the installer run")
h.replace(INST, '      FLEET_INSTALLER=1 bash "$SCRIPTS/provision_engine.sh"', '      bash "$SCRIPTS/provision_engine.sh"',
          expect="RULE D install_fleet_apps.sh calls provision_engine.sh without FLEET_INSTALLER=1",
          name="D: installer does not identify itself to provision_engine.sh")
PW = f"{S}/prewarm_engine.sh"
# The shipped defect: 0 printed as "idle-suspend -s".
h.replace(PW, 'print(n, r.get("status", "?"), "-" if s in (None, "") else s)',
          'print(n, r.get("status", "?"), r.get("auto_suspend_secs") or "-")',
          expect="RULE E prewarm_engine.sh collapses AUTO_SUSPEND_SECS=0 into a missing value",
          name="E: 0 collapsed into '-'")
h.replace(PW, "      0)  printf", "      9)  printf",
          expect="RULE E prewarm_engine.sh does not print AUTO_SUSPEND_SECS=0 as no-suspend",
          name="E: no-suspend branch removed")
h.replace(INST, 'if [ -z "${SA_URL:-}" ] || [ -z "${ADMIN_URL:-}" ]; then\n  echo "   4.',
          'if true; then\n  echo "   4.',
          expect="RULE F endpoint-provisioning advice is printed even when both URLs resolved",
          name="F: provisioning advice printed unconditionally")
# The shipped regression: an empty alternative BSD grep rejects.
h.replace(PE, "grep -Ev '^$|^status$|^name,status$|^Statement executed'",
          "grep -Ev '^(status|Statement executed.*|name,status|)$'",
          expect="RULE G service-status filter misbehaves under grep",
          name="G: filter with an empty alternative")
h.replace(PE, "grep -Ev '^$|^status$|^name,status$|^Statement executed'",
          "grep -Ev '^$|^status$'",
          expect="RULE G service-status filter misbehaves under grep",
          name="G: filter that leaks the header lines")
CA = f"{S}/create_agents.sh"
# The shipped defect: agent DDL files run straight to the console.
h.replace(CA, '  if snow sql -c "$CONNECTION" -f "$1" >"$log" 2>&1; then return 0; fi',
          '  if snow sql -c "$CONNECTION" -f "$1"; then return 0; fi',
          expect="RULE H create_agents.sh streams a snow sql -f file run to the console",
          name="H: agent specs echoed to the console")
h.replace(CA, 'run_file "$GRANT_FILE" grants || { note "ERROR: agent grants failed"; exit 1; }',
          'snow sql -c "$CONNECTION" -f "$GRANT_FILE"',
          expect="RULE H create_agents.sh streams a snow sql -f file run to the console",
          name="H: grant file echoed to the console")

sys.exit(h.finish())
