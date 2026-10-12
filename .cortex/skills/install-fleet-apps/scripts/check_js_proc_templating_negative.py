#!/usr/bin/env python3
"""Negative tests for check_js_proc_templating.py - each case deploys `&&`-bearing
SQL with LEGACY templating left on, and the gate must name the file it deploys.

The historical defect: install_fleet_apps.sh deployed deploy-agent.sql (75 `&&`)
via "$ROUTING_TOOLS_SQL" without `--enable-templating NONE`, so every logical
AND in the JavaScript TOOL_* procs became a bitwise `&` and null guards turned
into null-dereferences."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SK = ".cortex/skills/install-fleet-apps"
INSTALLER = f"{SK}/scripts/install_fleet_apps.sh"
TOOLS_DEPLOY = 'snow sql -c "$CONNECTION" --enable-templating NONE -f "$ROUTING_TOOLS_SQL"'
ANALYTIC_DEPLOY = 'snow sql -c "$CONNECTION" -f "$ANALYTIC_SQL" --enable-templating NONE'
JS_GUARD = ("\n-- js guard\nCREATE OR REPLACE PROCEDURE NEGTEST_P() RETURNS STRING LANGUAGE JAVASCRIPT AS\n"
            "$$ var r = null; return (r && r.routes) ? 'y' : 'n'; $$;\n")

h = Harness("check_js_proc_templating.py")


def append_case(name: str, rel: str, expect: str) -> None:
    """Append JS_GUARD to a tracked file (asserting it had no `&&` before)."""
    p = h.path(rel)
    original = p.read_text()

    def apply():
        assert "&&" not in original, f"{rel} already contains && - pick a safe file"
        p.write_text(original + JS_GUARD)

    h.custom(name, apply, lambda: p.write_text(original), expect=expect)

# The exact historical defect: deployed through a shell variable, flag missing.
h.replace(INSTALLER, TOOLS_DEPLOY, 'snow sql -c "$CONNECTION" -f "$ROUTING_TOOLS_SQL"',
          expect="deploys deploy-agent.sql (contains `&&`) without `--enable-templating NONE`",
          name="deploy-agent.sql via $ROUTING_TOOLS_SQL without the flag")

h.replace(INSTALLER, ANALYTIC_DEPLOY, 'snow sql -c "$CONNECTION" -f "$ANALYTIC_SQL"',
          expect="deploys analytic_layer.sql (contains `&&`) without",
          name="analytic_layer.sql without the flag")

# The flag present but with a mode that still performs `&&` substitution.
h.replace(INSTALLER, TOOLS_DEPLOY,
          'snow sql -c "$CONNECTION" --enable-templating LEGACY -f "$ROUTING_TOOLS_SQL"',
          expect="deploys deploy-agent.sql (contains `&&`) without",
          name="flag present but set to LEGACY")

# Brace form of the variable reference.
h.replace(INSTALLER, TOOLS_DEPLOY, 'snow sql -c "$CONNECTION" -f "${ROUTING_TOOLS_SQL}"',
          expect="deploys deploy-agent.sql (contains `&&`) without",
          name="${VAR} brace form without the flag")

# A literal-path deploy in a new script.
h.add(".cortex/skills/routing-agent/scripts/negtest_redeploy.sh",
      '#!/bin/bash\nsnow sql -c "$CONN" -f references/deploy-agent.sql\n',
      expect="deploys deploy-agent.sql (contains `&&`) without",
      name="literal path in a new script without the flag")

# A file that was SAFE becomes at-risk when a JS proc with `&&` lands in it:
# vehicle_profile_catalog.sql is deployed by literal path without the flag.
append_case("JS proc added to a file deployed by literal path",
            f"{SK}/scripts/vehicle_profile_catalog.sql",
            expect="deploys vehicle_profile_catalog.sql (contains `&&`) without")

# Same, deployed through an indented variable assignment ("$SAP_MOCK_SQL").
append_case("JS proc added to a file deployed via an indented variable",
            ".cortex/skills/sap-fleet-connector/scripts/mock_sap_seed.sql",
            expect="deploys mock_sap_seed.sql (contains `&&`) without")

sys.exit(h.finish())
