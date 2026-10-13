#!/usr/bin/env python3
"""Negative tests for check_suspend_signatures.py - each case makes a gateway
error code invisible to the app's suspended-engine detector (or breaks one of
the gate's own guards), and the gate must name the cause.

The historical defect: SUSPEND_SIGNATURES matched only `service_unreachable`, so
`circuit_open` / `timeout` / `service_warming_up` responses could not be
classified - no typed 503, no auto-resume, a blank panel."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SK = ".cortex/skills/install-fleet-apps"
TS = f"{SK}/fleet_sa_app/ui/src/lib/routing-suspend.ts"
PY = f"{SK}/openrouteservice_app/services/gateway/routing_service.py"

h = Harness("check_suspend_signatures.py")

# The breaker's fallback code, which reaches the body via 'error': breaker_reason.
h.replace(TS, "  /circuit_open/i,\n];", "];",
          expect="gateway error code 'circuit_open",
          name="detector loses circuit_open (breaker fallback code)")

h.replace(TS, "  /service_warming_up/i,\n", "",
          expect="gateway error code 'service_warming_up",
          name="detector loses service_warming_up")

# Only ONE envelope stops matching: the JSON body the tool path sees.
h.replace(TS, "  /[\"']error[\"']\\s*:\\s*[\"']timeout[\"']/i,\n", "",
          expect="gateway error code 'timeout (unmatched in: {\"error\":\"timeout\"",
          name="timeout matched in the SQL envelope but not the JSON one")

# A new gateway code added without deciding which bucket it belongs to.
h.replace(PY, "{'error': 'all_chunks_failed', 'message': 'All matrix chunks failed'}",
          "{'error': 'engine_overloaded', 'message': 'All matrix chunks failed'}",
          expect="gateway error code 'engine_overloaded",
          name="new unclassified gateway code")

# Same mutation, other half of the rule: the allowlist entry it replaced is stale.
h.replace(PY, "{'error': 'all_chunks_failed', 'message': 'All matrix chunks failed'}",
          "{'error': 'matrix_precompute_failed', 'message': 'All matrix chunks failed'}",
          expect="IGNORED_CODES lists 'all_chunks_failed'",
          name="allowlisted code no longer emitted (stale allowlist)")

# The fail-fast response collapses back to an opaque code instead of the cause.
h.replace(PY, "            'error': breaker_reason,\n", "            'error': 'breaker',\n",
          expect="no longer returns the breaker cause as 'error'",
          name="breaker stops naming the underlying cause")

h.replace(TS, "const NOT_READY_SIGNATURES = [", "const WARMING_SIGNATURES = [",
          expect="could not find NOT_READY_SIGNATURES",
          name="signature array renamed out from under the gate")

h.replace(TS, "  /circuit_open/i,\n];", "  /circuit_open/i,\n  /(?<c>open)\\k<c>/i,\n];",
          expect="does not compile in Python",
          name="JS-only regex syntax in a signature")

# A waking gateway (Snowflake 100283 "Could not connect to server") goes back to
# being a raw error in the panel - the defect the measured list exists for.
h.replace(TS, "  /could not connect to server/i,\n];", "];",
          expect="measured platform error is unmatched by any signature (want not_ready)",
          name="waking-gateway text dropped from NOT_READY_SIGNATURES")

# Same text, wrong bucket: the panel would claim a resume was triggered for a
# gateway that is resuming itself.
h.replace(TS, "  /connection_failed/i,\n", "  /connection_failed/i,\n  /could not connect to server/i,\n",
          expect="lands in the wrong bucket (suspended, want not_ready)",
          name="waking-gateway text added to SUSPEND_SIGNATURES")

# The attribution constant drifts from the literal the detector array uses.
h.replace(TS, "const GATEWAY_CONNECT_FAILURE = /could not connect to server/i;",
          "const GATEWAY_CONNECT_FAILURE = /could not reach server/i;",
          expect="is not also a literal in NOT_READY_SIGNATURES",
          name="gateway attribution constant drifts from the detector literal")

sys.exit(h.finish())
