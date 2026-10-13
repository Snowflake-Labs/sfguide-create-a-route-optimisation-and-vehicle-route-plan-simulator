#!/usr/bin/env python3
"""Guard: the admin Status & Health page must not report a waking routing
gateway as a graph-load failure.

What happened (wgb26798): ROUTING_GATEWAY_SERVICE auto-suspends after an idle
hour, and ORS_STATUS is a service function on it, so the page's own readiness
probe wakes it. The first call raced the cold start and failed with 100283
"Request failed for external function _ORS_STATUS_RAW. Error: Could not connect
to server"; the next call 29 s later took 313 ms. /api/ors-readiness turned the
failure into `error`, and the page showed a red "Graph Loading Failed ...
routing functions will return errors" while the ORS service had been RUNNING
the whole time.

Rules (TypeScript comments are stripped first, so a comment that MENTIONS a
symbol cannot satisfy a rule):
  A  the readiness route's catch classifies the error with isConnectFailure AND
     confirms with isGatewayWaking (the text alone is not proof), and the waking
     result carries `gateway_waking: true` with no `error` key
  B  CONNECT_FAILURE_SIGNATURES matches the measured 100283 text
  C  isGatewayWaking keys a RUNNING gateway on its resume age (WAKE_WINDOW_S),
     so a gateway up for an hour that refuses connections stays an error
  D  the page keeps waking regions out of the yellow "Graphs Building" banner
     (condition and list) and re-polls on a timer while one is waking

Usage:  python3 .cortex/skills/install-fleet-apps/scripts/check_admin_gateway_wake.py
Exit:   0 clean, 1 violation
"""
from __future__ import annotations

import os
import pathlib
import re
import sys

REPO = pathlib.Path(os.environ.get("GATE_REPO") or pathlib.Path(__file__).resolve().parents[4])
UI = REPO / ".cortex/skills/install-fleet-apps/fleet_admin_app/ui/src"
ROUTE = UI / "app/api/ors-readiness/route.ts"
LIB = UI / "server/lib/gateway-wake.ts"
PAGE = UI / "components/pages/service-manager.tsx"

MEASURED = ("SQL API error 422: { \"code\" : \"100283\", \"message\" : \"Request failed for "
            "external function _ORS_STATUS_RAW. Error: Could not connect to server\" }")

failures: list[str] = []


def code(p: pathlib.Path) -> str:
    """Source with /* */ and // comments removed (string contents kept)."""
    text = p.read_text()
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"(?<![:'\"\\])//[^\n]*", "", text)


def block_after(text: str, anchor: str) -> str:
    """The brace-balanced block that follows the first `anchor`."""
    i = text.find(anchor)
    if i < 0:
        return ""
    j = text.find("{", i)
    depth = 0
    for k in range(j, len(text)):
        depth += {"{": 1, "}": -1}.get(text[k], 0)
        if depth == 0:
            return text[j:k + 1]
    return ""


for p in (ROUTE, LIB, PAGE):
    if not p.is_file():
        print(f"check_admin_gateway_wake: FAILED - missing {p.relative_to(REPO)}")
        sys.exit(1)

route, lib, page = code(ROUTE), code(LIB), code(PAGE)

# A
catch = block_after(route, "catch (e)")
if "isConnectFailure(" not in catch:
    failures.append("A readiness catch no longer classifies the error with isConnectFailure - "
                    "a waking gateway will be reported as a graph-load failure")
if "isGatewayWaking(" not in catch:
    failures.append("A readiness catch does not confirm with isGatewayWaking - "
                    "the error text alone would excuse a real gateway outage")
waking_obj = re.search(r"gateway_waking\s*:\s*true[^}]*}", catch)
if not waking_obj:
    failures.append("A readiness catch never returns gateway_waking: true")
elif re.search(r"\berror\s*:", catch[catch.rfind("{", 0, waking_obj.start()):waking_obj.end()]):
    failures.append("A the waking result carries an `error` key, so the page renders it red")

# B
m = re.search(r"CONNECT_FAILURE_SIGNATURES\s*=\s*\[(.*?)\];", lib, re.S)
if not m:
    failures.append("B could not find CONNECT_FAILURE_SIGNATURES in gateway-wake.ts")
else:
    pats = re.findall(r"/((?:\\/|[^/\n])+)/([a-z]*)", m.group(1))
    compiled = [re.compile(src, re.I if "i" in flags else 0) for src, flags in pats]
    if not any(r.search(MEASURED) for r in compiled):
        failures.append("B no CONNECT_FAILURE_SIGNATURES entry matches the measured 100283 "
                        "'Could not connect to server' text")

# C
fn = block_after(lib, "export function isGatewayWaking")
if not fn:
    failures.append("C could not find isGatewayWaking in gateway-wake.ts")
elif not ("RUNNING" in fn and "resumedAgoS" in fn and "WAKE_WINDOW_S" in fn):
    failures.append("C isGatewayWaking no longer bounds a RUNNING gateway by its resume age "
                    "(WAKE_WINDOW_S) - a long-running gateway that refuses connections would "
                    "be excused as waking")

# D
building = [m.start() for m in re.finditer(r"!r\.service_ready && !r\.error", page)]
if len(building) < 2:
    failures.append("D could not find the 'Graphs Building' condition and its list filter")
for pos in building:
    clause = page[pos:pos + 120]
    if "!r.gateway_waking" not in clause.split("isRegionSuspended")[0]:
        failures.append("D a waking region is counted in the yellow 'Graphs Building' banner, "
                        "which claims graphs are being built from map data")
        break
if not re.search(r"setTimeout\(\s*\(\)\s*=>\s*\{?\s*fetchOrsReadiness\(\)", page):
    failures.append("D the page no longer re-polls readiness while the gateway is waking")

if failures:
    print("check_admin_gateway_wake: FAILED")
    for f in failures:
        print(f"  {f}")
    sys.exit(1)
print("check_admin_gateway_wake: OK - readiness classifies a waking gateway (text + state), "
      "the measured 100283 text matches, a long-running gateway stays an error, and the page "
      "keeps waking out of 'Building' and re-polls")
