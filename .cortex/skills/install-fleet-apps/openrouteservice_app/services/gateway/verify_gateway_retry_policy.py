#!/usr/bin/env python3
"""Regression test for the gateway's retry policy, circuit breaker, and the
6099 chunked-matrix fallback.

Run with:  python3 verify_gateway_retry_policy.py
Needs flask + requests + polyline importable (routing_service imports them at
module load). No network and no ORS: every downstream call is monkeypatched.

WHAT THIS PROTECTS
==================

Three defects found by reading OBSERVABILITY.ORS_REQUEST_LOG after an
Observability page full of errors. All three are silent: every one of them
produces a plausible-looking response and a populated log.

1. RETRY AMPLIFICATION. get_ors_response retried on HTTP status alone, so an
   ORS code that describes the REQUEST was re-sent at full size two more times.
   Measured over 4.5 minutes: 44 logical cycling-electric matrix calls on the
   SanFrancisco host produced 119 error events (36 first attempts, 42 .retry1,
   41 .retry2) for code 6099, whose actual remedy is the chunked fallback in
   post_matrix_tabular - a fallback only reachable AFTER get_ors_response
   returns. Every 6099 therefore paid for three full-size attempts before the
   one thing that helps was tried.

2. THE BREAKER COULD NEVER OPEN. The 5xx retry branch is guarded by
   `attempt < ORS_RETRY_MAX_ATTEMPTS`, so on the LAST attempt control fell
   through to _breaker_on_success - the attempt that proved the host unwell
   cleared the counter the previous two had built. Corroborated by the data:
   119 recorded 5xx events and ZERO status-503 circuit_open events in the whole
   table. The breaker had never opened in production.

3. THE 6099 REMEDY NEVER FIRED FOR THE FORM THAT NEEDED IT. Chunking was gated
   on `has_dest`, excluding the 2-arg locations-only MATRIX_TABULAR form. At
   ~2,510 request bytes (~100 coordinates) the incident calls had no room for a
   destinations index list, so they were the excluded form.

WHY EACH ASSERTION IS SHAPED THE WAY IT IS
==========================================

Asserting "the code mentions 6099" would pass on the comment that documents the
trap, and asserting "a breaker call exists" would pass on the buggy version too
- it called _breaker_on_success. So every assertion here drives the real
function with a fake transport and counts what actually happened: how many HTTP
attempts were made, and which breaker counter moved.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import routing_service as rs  # noqa: E402

passed = 0
failed = 0

# Keep the retry backoff negligible for the whole file. Set at the top rather
# than mid-file: under a mutation that makes everything retry, the default
# 500 ms exponential base turns this harness into a multi-second job and the
# mutation runner gets killed before it can report.
rs.ORS_RETRY_BACKOFF_BASE_MS = 1


def check(label, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
    else:
        failed += 1
        print(f'  FAIL: {label}{(" -- " + detail) if detail else ""}')


class FakeResponse:
    def __init__(self, status_code, payload, text=''):
        self.status_code = status_code
        self._payload = payload
        self.text = text
        self.content = b'x' * 10

    def json(self):
        return self._payload


def drive(status, payload, host='ors-service-test', function='matrix'):
    """Call get_ors_response with a stubbed transport. Returns (attempts, resp)."""
    attempts = {'n': 0}

    def fake_post(url=None, headers=None, json=None, timeout=None):
        attempts['n'] += 1
        return FakeResponse(status, payload)

    orig_post = rs.requests.post
    orig_emit = rs._emit_metric
    rs.requests.post = fake_post
    rs._emit_metric = lambda *a, **k: None
    try:
        resp = rs.get_ors_response(function, 'driving-car', {'locations': [[0, 0], [1, 1]]},
                                   'json', host)
    finally:
        rs.requests.post = orig_post
        rs._emit_metric = orig_emit
    return attempts['n'], resp


def reset_breaker(host):
    rs._BREAKER_STATE.pop(host, None)


def breaker_failures(host):
    return len(rs._BREAKER_STATE.get(host, {}).get('failures', []))


ERR_6099 = {'error': {'code': 6099, 'message': 'Unable to compute the matrix.'}}
ERR_GENERIC_5XX = {'error': {'code': 9999, 'message': 'transient'}}

print('1. A non-retryable ORS code is attempted exactly ONCE')
# This is the whole point of the fix: three attempts here is the measured
# 2.7x amplification, and it also delayed the chunked fallback by three
# full-size matrix computations.
for code in (6099, 6004, 6010, 2010):
    host = f'h-nonretry-{code}'
    reset_breaker(host)
    n, _ = drive(500, {'error': {'code': code, 'message': 'x'}}, host=host)
    check(f'ORS {code} attempted once', n == 1, f'attempts={n}')

print('2. A generic 5xx with no recognised code still retries')
# The exclusion list must be a list, not a blanket "stop retrying 5xx". A
# genuinely transient failure is exactly what the retry loop is for.
host = 'h-generic'
reset_breaker(host)
n, _ = drive(500, ERR_GENERIC_5XX, host=host)
check('generic 5xx uses all attempts', n == rs.ORS_RETRY_MAX_ATTEMPTS, f'attempts={n}')

print('3. A 5xx that ENDS the loop counts as a breaker FAILURE, not a success')
# The defect: the final attempt called _breaker_on_success and cleared the
# counter, so a host failing every call could never trip the breaker. One
# exhausted call must leave ORS_RETRY_MAX_ATTEMPTS failures recorded.
host = 'h-exhaust'
reset_breaker(host)
drive(500, ERR_GENERIC_5XX, host=host)
check('exhausted retries leave failures recorded',
      breaker_failures(host) == rs.ORS_RETRY_MAX_ATTEMPTS,
      f'failures={breaker_failures(host)} expected={rs.ORS_RETRY_MAX_ATTEMPTS}')

print('4. A non-retryable 5xx also counts as a failure')
# It is still evidence about the host, and exempting it would re-create the
# blind spot for the exact code that produced the incident.
host = 'h-nonretry-count'
reset_breaker(host)
drive(500, ERR_6099, host=host)
check('6099 records one failure', breaker_failures(host) == 1,
      f'failures={breaker_failures(host)}')

print('5. Repeated failures actually OPEN the breaker')
# The observable consequence of rule 3. Before the fix this state was
# unreachable: zero 503 circuit_open events had ever been logged.
#
# The loop is BOUNDED. Written as `while breaker_failures(host) < threshold` it
# never terminates under the very mutation it is meant to catch (a breaker that
# clears on the final 5xx never accumulates), so the mutation run hung and was
# killed instead of reporting a failure - an assertion that cannot fail loudly
# is no better than one that cannot fail at all.
host = 'h-open'
reset_breaker(host)
for _ in range(rs.ORS_BREAKER_FAILURE_THRESHOLD + 2):
    if breaker_failures(host) >= rs.ORS_BREAKER_FAILURE_THRESHOLD:
        break
    drive(500, ERR_6099, host=host)
check('failures accumulate to the threshold',
      breaker_failures(host) >= rs.ORS_BREAKER_FAILURE_THRESHOLD,
      f'failures={breaker_failures(host)} threshold={rs.ORS_BREAKER_FAILURE_THRESHOLD}')
allow, reason = rs._breaker_check(host)
check('breaker opens after threshold failures', allow is False, f'allow={allow}')
check('breaker names a cause', bool(reason), f'reason={reason}')

print('6. A success clears the counter')
host = 'h-clear'
reset_breaker(host)
drive(500, ERR_6099, host=host)
drive(200, {'durations': [[0, 1], [1, 0]]}, host=host)
check('a 2xx clears recorded failures', breaker_failures(host) == 0,
      f'failures={breaker_failures(host)}')

print('7. The 6099 chunked fallback covers the locations-only form')
# Chunking was gated on has_dest, which excluded the 2-arg form the incident
# used. Drive post_matrix_tabular directly: the first full-size call answers
# 6099, and the fallback must then produce a stitched matrix rather than
# handing the 6099 back to the caller.
calls = {'bodies': []}


def fake_get_ors(function, profile, body, fmt, host, **kw):
    calls['bodies'].append(body)
    if 'destinations' not in body:
        return dict(ERR_6099)
    dests = body['destinations']
    srcs = body['sources']
    return {
        'durations': [[1.0] * len(dests) for _ in srcs],
        'distances': [[2.0] * len(dests) for _ in srcs],
    }


orig_get = rs.get_ors_response
rs.get_ors_response = fake_get_ors
try:
    locations = [[float(i), float(i)] for i in range(4)]
    with rs.app.test_request_context(json={'data': [[0, 'driving-car', locations, 'SanFrancisco']]}):
        out = rs.post_matrix_tabular()
finally:
    rs.get_ors_response = orig_get

# _make_response returns a Flask Response, not a dict. Unwrap it - reading it as
# a dict yields no rows, and then every assertion below passes VACUOUSLY on an
# empty payload. That happened on the first run of this file.
body = out.get_json() if hasattr(out, 'get_json') else out
rows = body.get('data') if isinstance(body, dict) else None
check('the request produced a row at all (guards against vacuous passes)',
      bool(rows) and len(rows[0]) == 2, f'rows={rows!r}'[:160])
payload = rows[0][1] if rows else {}
check('the payload is non-empty (guards against vacuous passes)', bool(payload),
      f'payload={payload!r}'[:160])
check('locations-only 6099 is not returned to the caller', 'error' not in payload,
      f'payload_keys={sorted(payload)}')
check('locations-only 6099 produces a stitched matrix', 'durations' in payload,
      f'payload_keys={sorted(payload)}')
check('the stitched matrix is square over all locations',
      len(payload.get('durations', [])) == len(locations)
      and all(len(r) == len(locations) for r in payload.get('durations', [])),
      f'shape={[len(r) for r in payload.get("durations", [])]}')
check('the retry actually split by destination column',
      any('destinations' in b for b in calls['bodies']),
      f'bodies={len(calls["bodies"])}')

print(f'\n{passed} passed, {failed} failed')
sys.exit(1 if failed else 0)
