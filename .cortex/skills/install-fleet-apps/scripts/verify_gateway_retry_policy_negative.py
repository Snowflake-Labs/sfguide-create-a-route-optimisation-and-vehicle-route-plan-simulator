#!/usr/bin/env python3
"""Negative tests for verify_gateway_retry_policy.py - each case reverts ONE of
the gateway's retry / breaker / 6099-fallback fixes in routing_service.py, and
the suite must fail on the specific check that guards it.

Ports all five mutations of mutate_gateway_retry_policy.py, the in-place driver
this replaces. That driver rewrote routing_service.py in the real checkout and
counted ANY non-zero exit as a conviction - so run under an interpreter without
flask, every "conviction" was the suite's own ImportError and it still printed
"all 5 mutations convicted". Here the suite runs from a temp copy, the
unmodified copy must pass first (an import failure makes the baseline red and
convicts nothing), and each case must fail with its own check's text.

Run with an interpreter that has flask + requests + polyline: the suite imports
routing_service, which imports all three at module load.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

GW = ".cortex/skills/install-fleet-apps/openrouteservice_app/services/gateway"
PY = f"{GW}/routing_service.py"

# PYTHONDONTWRITEBYTECODE: two mutations of the same size written within one
# second would pass the .pyc freshness check (mtime in whole seconds + size)
# and run the PREVIOUS case's bytecode. Never caching it rules that out.
h = Harness("verify_gateway_retry_policy.py", path=f"{GW}/verify_gateway_retry_policy.py",
            env={"PYTHONDONTWRITEBYTECODE": "1"})

BREAKER_SPLIT = (
    "            if 500 <= r.status_code < 600:\n"
    "                _breaker_on_failure(host, err_code if isinstance(err_code, str) else 'http_5xx')\n"
    "            else:\n"
    "                _breaker_on_success(host)")

# Retry amplification: 6099 re-sent at full size on every attempt again.
h.replace(PY, "and attempt < ORS_RETRY_MAX_ATTEMPTS and not non_retryable:",
          "and attempt < ORS_RETRY_MAX_ATTEMPTS:",
          expect="FAIL: ORS 6099 attempted once",
          name="M1 blanket 5xx retry (non-retryable exclusion reverted)")

# The original defect: the final 5xx clears the breaker it should have fed.
h.replace(PY, BREAKER_SPLIT, "            _breaker_on_success(host)",
          expect="FAIL: exhausted retries leave failures recorded -- failures=0",
          name="M2 final 5xx clears the breaker")

# The chunked remedy excludes the locations-only form the incident used.
h.replace(PY, "if isinstance(error_obj, dict) and error_obj.get('code') == 6099:",
          "if isinstance(error_obj, dict) and error_obj.get('code') == 6099 and has_dest:",
          expect="FAIL: locations-only 6099 is not returned to the caller",
          name="M3 6099 fallback re-gated on has_dest")

# Same amplification via the data instead of the condition. 6010 rather than
# 6099 so this case is not merely M1's first failing line again.
h.replace(PY, "ORS_NON_RETRYABLE_CODES = frozenset({6099, 6004, 6010, 2010, '6099', '6004', '6010', '2010'})",
          "ORS_NON_RETRYABLE_CODES = frozenset()",
          expect="FAIL: ORS 6010 attempted once",
          name="M4 non-retryable code set emptied")

# The blind spot for the very code that produced the incident.
h.replace(PY,
          "            if 500 <= r.status_code < 600:\n"
          "                _breaker_on_failure(host, err_code if isinstance(err_code, str) else 'http_5xx')",
          "            if 500 <= r.status_code < 600 and not non_retryable:\n"
          "                _breaker_on_failure(host, err_code if isinstance(err_code, str) else 'http_5xx')",
          expect="FAIL: 6099 records one failure -- failures=0",
          name="M5 6099 exempted from the breaker counter")

sys.exit(h.finish())
