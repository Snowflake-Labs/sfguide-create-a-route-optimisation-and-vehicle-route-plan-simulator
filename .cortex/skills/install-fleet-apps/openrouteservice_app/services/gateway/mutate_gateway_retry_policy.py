#!/usr/bin/env python3
"""Mutation driver for verify_gateway_retry_policy.py.

Each mutation reverts ONE of the three fixes. A mutation that still passes means
the corresponding assertion is decoration. Restores the file unconditionally.
"""
import subprocess
import sys

P = 'routing_service.py'
ORIG = open(P).read()

MUTATIONS = [
    ('M1 blanket 5xx retry (revert the exclusion)',
     'and attempt < ORS_RETRY_MAX_ATTEMPTS and not non_retryable:',
     'and attempt < ORS_RETRY_MAX_ATTEMPTS:'),
    ('M2 final 5xx clears the breaker (the original defect)',
     "            if 500 <= r.status_code < 600:\n"
     "                _breaker_on_failure(host, err_code if isinstance(err_code, str) else 'http_5xx')\n"
     "            else:\n"
     "                _breaker_on_success(host)",
     '            _breaker_on_success(host)'),
    ('M3 re-gate the 6099 fallback on has_dest',
     "if isinstance(error_obj, dict) and error_obj.get('code') == 6099:",
     "if isinstance(error_obj, dict) and error_obj.get('code') == 6099 and has_dest:"),
    ('M4 empty the non-retryable code set',
     "ORS_NON_RETRYABLE_CODES = frozenset({6099, 6004, 6010, 2010, '6099', '6004', '6010', '2010'})",
     'ORS_NON_RETRYABLE_CODES = frozenset()'),
    ('M5 exempt 6099 from the breaker counter',
     "            if 500 <= r.status_code < 600:\n"
     "                _breaker_on_failure(host, err_code if isinstance(err_code, str) else 'http_5xx')",
     "            if 500 <= r.status_code < 600 and not non_retryable:\n"
     "                _breaker_on_failure(host, err_code if isinstance(err_code, str) else 'http_5xx')"),
]

survived = []
try:
    for name, anchor, replacement in MUTATIONS:
        if anchor not in ORIG:
            print(f'{name}: ANCHOR NOT FOUND - mutation is invalid, not a pass')
            survived.append(name)
            continue
        open(P, 'w').write(ORIG.replace(anchor, replacement, 1))
        # A timeout is mandatory, not defensive: a mutation can make the harness
        # loop forever, and a runner that hangs gets killed with the source file
        # still mutated. Treat a timeout as "convicted but badly" and say so.
        try:
            r = subprocess.run([sys.executable, 'verify_gateway_retry_policy.py'],
                               capture_output=True, text=True, timeout=90)
            rc, out = r.returncode, r.stdout
        except subprocess.TimeoutExpired:
            rc, out = 124, ''
            print(f'{name}: TIMED OUT - the harness hangs under this mutation, fix the harness')
        tally = [l for l in out.splitlines() if 'passed,' in l]
        fails = [l.strip() for l in out.splitlines() if l.startswith('  FAIL')]
        verdict = 'CONVICTED' if rc != 0 else 'SURVIVED (assertion is decoration)'
        print(f'{name}: {verdict} | {tally[-1] if tally else "no tally"}')
        for f in fails[:2]:
            print(f'    {f}')
        if rc == 0:
            survived.append(name)
finally:
    open(P, 'w').write(ORIG)
    print('file restored:', open(P).read() == ORIG)

print()
if survived:
    print(f'{len(survived)} mutation(s) SURVIVED:')
    for s in survived:
        print(f'  - {s}')
    sys.exit(1)
print(f'all {len(MUTATIONS)} mutations convicted')
