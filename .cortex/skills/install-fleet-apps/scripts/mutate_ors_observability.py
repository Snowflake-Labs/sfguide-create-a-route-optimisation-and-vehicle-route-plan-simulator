#!/usr/bin/env python3
"""Mutation driver for check_ors_observability.py.

Each mutation reverts ONE fix, or renames a rule's subject away. A mutation that
still passes means the corresponding rule is decoration. Restores every file
unconditionally, including on a crash - a driver that leaves a mutation behind
is worse than no driver, and this one did exactly that twice before the finally
block was added.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
GATE = Path(__file__).resolve().parent / 'check_ors_observability.py'

GATEWAY = REPO / '.cortex/skills/install-fleet-apps/openrouteservice_app/services/gateway/routing_service.py'
REGION = REPO / '.cortex/skills/install-fleet-apps/openrouteservice_app/app/modules/03_region_management.sql'
STATIC = REPO / '.cortex/skills/install-fleet-apps/openrouteservice_app/staged_files/ors-config.yml'
VIEW = REPO / '.cortex/skills/install-fleet-apps/openrouteservice_app/app/modules/08_observability.sql'
EVENTS = REPO / '.cortex/skills/install-fleet-apps/fleet_admin_app/ui/src/app/api/observability/ors-events/route.ts'

MUTATIONS = [
    ('M1 rule A: put SYSDATE() back in the view window', VIEW,
     "e.REQUEST_TS >= DATEADD(hour, -1, CURRENT_TIMESTAMP())",
     "e.REQUEST_TS >= DATEADD(hour, -1, SYSDATE())"),
    ('M2 rule A: put SYSDATE() back in the event-list filter', EVENTS,
     "REQUEST_TS >= DATEADD(hour, -24, CURRENT_TIMESTAMP())",
     "REQUEST_TS >= DATEADD(hour, -24, SYSDATE())"),
    ('M3 rule B: empty the non-retryable code set', GATEWAY,
     "ORS_NON_RETRYABLE_CODES = frozenset({6099, 6004, 6010, 2010, '6099', '6004', '6010', '2010'})",
     'ORS_NON_RETRYABLE_CODES = frozenset()'),
    ('M4 rule B: define the set but stop consulting it', GATEWAY,
     'and attempt < ORS_RETRY_MAX_ATTEMPTS and not non_retryable:',
     'and attempt < ORS_RETRY_MAX_ATTEMPTS:'),
    ('M5 rule C: final 5xx clears the breaker again', GATEWAY,
     "            if 500 <= r.status_code < 600:\n"
     "                _breaker_on_failure(host, err_code if isinstance(err_code, str) else 'http_5xx')\n"
     "            else:\n"
     "                _breaker_on_success(host)",
     '            _breaker_on_success(host)'),
    ('M6 rule D: drop the matrix search radius from the generated config', REGION,
     "        '      maximum_search_radius: ' + str(limits['maximum_snapping_radius']),\n",
     ''),
    ('M7 rule D: bind the matrix radius to a DIFFERENT key', REGION,
     "'      maximum_search_radius: ' + str(limits['maximum_snapping_radius'])",
     "'      maximum_search_radius: ' + str(limits['match_maximum_search_radius'])"),
    ('M8 rule D: make the two static radii disagree', STATIC,
     '      maximum_search_radius: 1000',
     '      maximum_search_radius: 2000'),
    ('M9 rule D: remove the static snapping radius (the original state)', STATIC,
     '        maximum_snapping_radius: 1000\n',
     ''),
    ('M10 rule E: re-gate the 6099 fallback on has_dest', GATEWAY,
     "if isinstance(error_obj, dict) and error_obj.get('code') == 6099:",
     "if isinstance(error_obj, dict) and error_obj.get('code') == 6099 and has_dest:"),
    # Deleting the cutoff entirely, rather than renaming the table. A renamed
    # table fails LOUDLY at deploy (the view will not compile), so convicting it
    # would be tightening a rule onto a non-defect. Dropping the predicate is
    # the silent shape: the event list still returns rows, just unbounded.
    ('M11 rule A: drop the window predicate from the event list', EVENTS,
     "const filters: string[] = ['REQUEST_TS >= DATEADD(hour, -24, CURRENT_TIMESTAMP())'];",
     'const filters: string[] = [];'),
]

originals = {p: p.read_text() for p in {GATEWAY, REGION, STATIC, VIEW, EVENTS}}
survived: list[str] = []

try:
    for name, path, anchor, replacement in MUTATIONS:
        base = originals[path]
        if anchor not in base:
            print(f'{name}: ANCHOR NOT FOUND - mutation invalid, not a pass')
            survived.append(name)
            continue
        path.write_text(base.replace(anchor, replacement, 1))
        r = subprocess.run([sys.executable, str(GATE)], capture_output=True, text=True, timeout=90)
        path.write_text(base)
        first = next((l.strip() for l in r.stdout.splitlines()
                      if l.strip().startswith(('RULE', 'VACUOUS'))), '')
        verdict = 'CONVICTED' if r.returncode != 0 else 'SURVIVED (rule is decoration)'
        print(f'{name}: {verdict}')
        if first:
            print(f'    {first[:150]}')
        if r.returncode == 0:
            survived.append(name)
finally:
    for p, text in originals.items():
        p.write_text(text)
    clean = all(p.read_text() == t for p, t in originals.items())
    print('all files restored:', clean)

print()
if survived:
    print(f'{len(survived)} mutation(s) SURVIVED:')
    for s in survived:
        print(f'  - {s}')
    sys.exit(1)
print(f'all {len(MUTATIONS)} mutations convicted')
