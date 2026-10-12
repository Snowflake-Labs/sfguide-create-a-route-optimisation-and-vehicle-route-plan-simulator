#!/usr/bin/env python3
"""Negative tests for check_admin_gateway_wake.py - each case re-creates a way
the admin Status & Health page could again call a waking routing gateway a
graph-load failure (or excuse a real outage as waking), and the gate must name
the rule it breaks.

M1 is the original defect: the readiness catch turned every error, including
the gateway's cold-start "Could not connect to server", into `error`."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

UI = ".cortex/skills/install-fleet-apps/fleet_admin_app/ui/src"
ROUTE = f"{UI}/app/api/ors-readiness/route.ts"
LIB = f"{UI}/server/lib/gateway-wake.ts"
PAGE = f"{UI}/components/pages/service-manager.tsx"

ORIGINAL_CATCH = """      } catch (e) {
        readiness[r.region] = { service_ready: false, health_ready: false, error: (e as Error).message };
      }"""

h = Harness("check_admin_gateway_wake.py")
_saved: dict[str, str] = {}


def revert_catch() -> None:
    p = h.path(ROUTE)
    text = _saved.setdefault(ROUTE, p.read_text())
    start = text.index("      } catch (e) {\n        const message")
    end = text.index("error: message };\n      }", start) + len("error: message };\n      }")
    p.write_text(text[:start] + ORIGINAL_CATCH + text[end:])


def restore_route() -> None:
    h.path(ROUTE).write_text(_saved[ROUTE])


h.custom("M1 the original bug: catch reports every error as `error`", revert_catch,
         restore_route, expect="A readiness catch no longer classifies")

h.replace(LIB, "  /could not connect to server/i,\n", "",
          expect="B no CONNECT_FAILURE_SIGNATURES entry matches",
          name="M2 measured cold-start text dropped from the signatures")

h.replace(ROUTE, "if (isGatewayWaking(gateway)) {", "if (true) {",
          expect="A readiness catch does not confirm with isGatewayWaking",
          name="M3 error text alone treated as waking (no gateway state check)")

h.replace(ROUTE, "gateway_waking: true,", "gateway_waking: true, error: message,",
          expect="A the waking result carries an `error` key",
          name="M4 waking result still carries `error`, so it renders red")

h.replace(LIB, "return status === 'RUNNING' && state.resumedAgoS !== null && state.resumedAgoS <= WAKE_WINDOW_S;",
          "return status === 'RUNNING';",
          expect="C isGatewayWaking no longer bounds a RUNNING gateway",
          name="M5 any RUNNING gateway excused as waking, however long it has been up")

h.replace(PAGE, "!r.service_ready && !r.error && !r.gateway_waking && !isRegionSuspended(region)) && (",
          "!r.service_ready && !r.error && !isRegionSuspended(region)) && (",
          expect="D a waking region is counted in the yellow 'Graphs Building' banner",
          name="M6 waking region shown as graphs building from map data")

h.replace(PAGE, "setTimeout(() => { fetchOrsReadiness(); }, GATEWAY_WAKE_REPOLL_MS)",
          "setTimeout(() => {}, GATEWAY_WAKE_REPOLL_MS)",
          expect="D the page no longer re-polls readiness",
          name="M7 no quick re-poll while the gateway wakes")

sys.exit(h.finish())
