#!/usr/bin/env python3
"""Negative tests for check_ors_observability.py - each case reverts ONE of the
five gateway / metrics-window fixes (or removes a rule's subject) and the gate
must convict it with that rule's own message.

Ported from mutate_ors_observability.py, which mutates the checkout in place;
this version runs every mutation against the Harness copy instead."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SKILL = ".cortex/skills/install-fleet-apps"
GATEWAY = f"{SKILL}/openrouteservice_app/services/gateway/routing_service.py"
REGION = f"{SKILL}/openrouteservice_app/app/modules/03_region_management.sql"
STATIC = f"{SKILL}/openrouteservice_app/staged_files/ors-config.yml"
VIEW = f"{SKILL}/openrouteservice_app/app/modules/08_observability.sql"
INIT = f"{SKILL}/fleet_admin_app/ui/src/server/lib/init.ts"
EVENTS = f"{SKILL}/fleet_admin_app/ui/src/app/api/observability/ors-events/route.ts"

h = Harness("check_ors_observability.py")

# RULE A - SYSDATE() against the TIMESTAMP_LTZ REQUEST_TS column
h.replace(VIEW, "e.REQUEST_TS >= DATEADD(hour, -1, CURRENT_TIMESTAMP())",
          "e.REQUEST_TS >= DATEADD(hour, -1, SYSDATE())",
          expect="RULE A: 08_observability.sql", name="A: SYSDATE() back in the installer view window")
h.replace(INIT, "e.REQUEST_TS >= DATEADD(hour, -24, CURRENT_TIMESTAMP())",
          "e.REQUEST_TS >= DATEADD(hour, -24, SYSDATE())",
          expect="against SYSDATE() (UTC as NTZ)", name="A: SYSDATE() back in the boot-time view copy")
h.replace(EVENTS, "const filters: string[] = ['REQUEST_TS >= DATEADD(hour, -24, CURRENT_TIMESTAMP())'];",
          "const filters: string[] = [];",
          expect="RULE A: route.ts contains no", name="A: event-list window predicate dropped")

# RULE B - deterministic ORS codes re-sent at full size
h.replace(GATEWAY,
          "ORS_NON_RETRYABLE_CODES = frozenset({6099, 6004, 6010, 2010, '6099', '6004', '6010', '2010'})",
          "ORS_NON_RETRYABLE_CODES = frozenset({6004, 6010, 2010, '6004', '6010', '2010'})",
          expect="ORS_NON_RETRYABLE_CODES is missing ['6099']", name="B: 6099 dropped from the non-retryable set")
h.replace(GATEWAY, "and attempt < ORS_RETRY_MAX_ATTEMPTS and not non_retryable:",
          "and attempt < ORS_RETRY_MAX_ATTEMPTS:",
          expect="does not consult the non-retryable", name="B: set defined but no longer gates the retry")

# RULE C - the final 5xx clears the breaker
h.replace(GATEWAY,
          "            if 500 <= r.status_code < 600:\n"
          "                _breaker_on_failure(host, err_code if isinstance(err_code, str) else 'http_5xx')\n"
          "            else:\n"
          "                _breaker_on_success(host)\n"
          "            return annotated",
          "            _breaker_on_success(host)\n"
          "            return annotated",
          expect="never calls _breaker_on_failure", name="C: loop-ending 5xx counted as a success")

# RULE D - matrix snapping more permissive than routing snapping
h.replace(REGION, "        '      maximum_search_radius: ' + str(limits['maximum_snapping_radius']),\n", "",
          expect="the emitted matrix block sets no maximum_search_radius",
          name="D: generated matrix block loses its search radius")
h.replace(REGION, "'      maximum_search_radius: ' + str(limits['maximum_snapping_radius'])",
          "'      maximum_search_radius: ' + str(limits['match_maximum_search_radius'])",
          expect="the matrix search radius reads limits['match_maximum_search_radius']",
          name="D: matrix radius bound to a different key")
h.replace(STATIC, "      maximum_search_radius: 1000", "      maximum_search_radius: 2000",
          expect="static ors-config.yml has snapping=1000 but matrix search=2000",
          name="D: static radii disagree")
h.replace(STATIC, "        maximum_snapping_radius: 1000\n", "",
          expect="must set BOTH maximum_snapping_radius", name="D: static snapping radius removed (original state)")

# RULE E - chunked 6099 fallback excludes the locations-only form
h.replace(GATEWAY, "if isinstance(error_obj, dict) and error_obj.get('code') == 6099:",
          "if isinstance(error_obj, dict) and error_obj.get('code') == 6099 and has_dest:",
          expect="gated on has_dest", name="E: 6099 fallback re-gated on has_dest")

sys.exit(h.finish())
