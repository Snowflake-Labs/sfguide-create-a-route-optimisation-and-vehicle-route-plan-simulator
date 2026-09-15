#!/usr/bin/env python3
"""Regression test for the gateway's non-JSON response handling.

Run with:  python3 verify_gateway_non_json.py
Needs flask + requests importable (routing_service imports both at module load).

WHAT THIS PROTECTS
==================

A DIRECTIONS call for a disconnected coordinate pair (Maui -> Boise, sampled by
the Function Tester for the UnitedStatesOfAmerica region) reached SQL callers as:

    Error: Unexpected token 'u', "upstream r"... is not valid JSON

Nothing about that is a JSON bug. ORS searched the whole US graph; SPCS ingress
cut the connection at ~90 s and substituted a plain-text 'upstream request
timeout' body. get_ors_response then called r.json() unguarded, and the
JSONDecodeError it raised is NOT caught by the ConnectionError / Timeout handlers
below it, so a readable timeout became a Flask 500 and an opaque SQL failure.

Two independent things are asserted here:

  1. A non-JSON body produces a structured, dict-shaped envelope. Dict shape is
     load-bearing: _annotate_engine_error subscripts the parsed response, so
     returning a string or None would fail a few lines later instead.
  2. ORS_TIMEOUT_DEFAULT is below the SPCS ingress timeout, so a slow directions
     call fails INSIDE the gateway with its own well-worded timeout envelope
     rather than letting ingress win with an unparseable body. Matrix was already
     tuned this way; directions was not, which is why only directions produced
     the unparseable error.
"""
import json
import os
import sys

# Import the module under test from its own directory.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import routing_service as rs  # noqa: E402

passed = 0
failed = 0


def check(name, cond, detail=None):
    global passed, failed
    if cond:
        passed += 1
    else:
        failed += 1
        print(f'FAIL: {name}' + (f' - {detail}' if detail else ''))


class FakeResponse:
    """Minimal requests.Response stand-in whose .json() behaves like the real
    one: raises ValueError (JSONDecodeError subclasses it) on a non-JSON body."""

    def __init__(self, status_code, text, content_type='text/plain'):
        self.status_code = status_code
        self.text = text
        self.content = text.encode()
        self.headers = {'Content-Type': content_type}

    def json(self):
        return json.loads(self.text)


# The real body SPCS ingress returns, and the observed error prefix.
INGRESS_TIMEOUT_BODY = 'upstream request timeout'

CASES = [
    ('ingress timeout', 504, INGRESS_TIMEOUT_BODY),
    ('empty body', 502, ''),
    ('html error page', 500, '<html><head><title>500 Internal Server Error</title></head></html>'),
    ('bad gateway text', 502, 'upstream connect error or disconnect/reset before headers'),
    # A 200 with a non-JSON body: r.raise_for_status() is never called, so status
    # code alone would not have caught this one.
    ('200 with non-json body', 200, 'OK'),
]


def run_case(label, status, body):
    calls = {'n': 0}

    def fake_post(*args, **kwargs):
        calls['n'] += 1
        return FakeResponse(status, body)

    orig_post = rs.requests.post
    rs.requests.post = fake_post
    try:
        resp = rs.get_ors_response(
            'directions', 'driving-hgv',
            {'coordinates': [[-156.47031, 20.88982], [-116.19779, 43.91467]]},
            'geojson',
            region_hint='UnitedStatesOfAmerica',
        )
    finally:
        rs.requests.post = orig_post
    return resp, calls['n']


print('Non-JSON body handling:')
for label, status, body in CASES:
    # Reset the circuit breaker between cases. Five consecutive failures trip it
    # (correctly), after which later cases would be short-circuited before the
    # code under test runs - the assertions would then be measuring the breaker,
    # not the parse guard.
    rs._BREAKER_STATE.clear()
    try:
        resp, n_calls = run_case(label, status, body)
    except Exception as e:  # noqa: BLE001
        # This is precisely the pre-fix behaviour: JSONDecodeError escaping
        # get_ors_response entirely.
        check(f'{label}: does not raise', False, f'{type(e).__name__}: {e}')
        continue

    check(f'{label}: returns a dict', isinstance(resp, dict), f'got {type(resp).__name__}')
    if not isinstance(resp, dict):
        continue
    check(f'{label}: flags an error', resp.get('error') == 'non_json_response',
          f"error was {resp.get('error')!r}")
    check(f'{label}: reports the HTTP status', resp.get('status') == status,
          f"status was {resp.get('status')!r}")
    check(f'{label}: carries the body prefix', resp.get('body_prefix') == body[:200],
          f"body_prefix was {resp.get('body_prefix')!r}")
    msg = resp.get('message') or ''
    check(f'{label}: message is human-readable', len(msg) > 40 and 'non-JSON' in msg,
          f'message was {msg!r}')
    # Not retried: the call already burned the full ingress budget, same policy
    # as the Timeout branch. Retrying would double a 90 s wait.
    check(f'{label}: does not retry', n_calls == 1, f'{n_calls} downstream calls')
    # The envelope must survive json.dumps - it crosses back into SQL as VARIANT.
    try:
        json.dumps(resp)
        check(f'{label}: envelope is serialisable', True)
    except (TypeError, ValueError) as e:
        check(f'{label}: envelope is serialisable', False, str(e))

# A well-formed JSON body must still pass straight through untouched.
def fake_post_ok(*args, **kwargs):
    return FakeResponse(200, json.dumps({'features': [{'properties': {'summary': {'distance': 1234.5}}}]}),
                        content_type='application/json')


orig = rs.requests.post
rs.requests.post = fake_post_ok
rs._BREAKER_STATE.clear()
try:
    ok_resp = rs.get_ors_response(
        'directions', 'driving-hgv',
        {'coordinates': [[-122.4, 37.8], [-122.3, 37.79]]}, 'geojson',
        region_hint='SanFrancisco')
finally:
    rs.requests.post = orig

print('\nHappy path is unaffected:')
check('valid JSON still parses', isinstance(ok_resp, dict) and 'features' in ok_resp,
      f'got {str(ok_resp)[:120]}')
check('valid JSON is not flagged as an error', (ok_resp or {}).get('error') is None,
      f"error was {(ok_resp or {}).get('error')!r}")

# ---------------------------------------------------------------------------
# VROOM. The solver path had the IDENTICAL unguarded r.json(), and it matters
# more here: timeout=300 is deliberate (a real backload solve measures 168.6s,
# and the Cortex Agent path completed at 270.1s uncut), so this call routinely
# runs past the ~60-90s ingress window and is the likeliest to be handed a
# plain-text body. Its callers also branch on `'routes' in vroom_r`, which
# raises on a str, so returning a dict is what keeps the failure reportable.
# ---------------------------------------------------------------------------
print('\nVROOM non-JSON body handling:')
VROOM_PAYLOAD = {
    'vehicles': [{'id': 1, 'start': [-122.4, 37.8], 'end': [-122.4, 37.8]}],
    'jobs': [{'id': 1, 'location': [-122.41, 37.79]}],
}

for label, status, body in CASES:
    def fake_post(*args, **kwargs):
        return FakeResponse(status, body)

    orig_post = rs.requests.post
    rs.requests.post = fake_post
    try:
        resp = rs.get_vroom_response(VROOM_PAYLOAD)
    except Exception as e:  # noqa: BLE001
        check(f'vroom {label}: does not raise', False, f'{type(e).__name__}: {e}')
        continue
    finally:
        rs.requests.post = orig_post

    check(f'vroom {label}: returns a dict', isinstance(resp, dict), f'got {type(resp).__name__}')
    if not isinstance(resp, dict):
        continue
    check(f'vroom {label}: flags an error', resp.get('error') == 'non_json_response',
          f"error was {resp.get('error')!r}")
    check(f'vroom {label}: reports the HTTP status', resp.get('status') == status,
          f"status was {resp.get('status')!r}")
    check(f'vroom {label}: carries the body prefix', resp.get('body_prefix') == body[:200],
          f"body_prefix was {resp.get('body_prefix')!r}")
    check(f'vroom {label}: message names VROOM', 'VROOM' in (resp.get('message') or ''),
          f"message was {(resp.get('message') or '')[:120]!r}")
    try:
        json.dumps(resp)
        check(f'vroom {label}: envelope is serialisable', True)
    except (TypeError, ValueError) as e:
        check(f'vroom {label}: envelope is serialisable', False, str(e))

# The per-region-unreachable fallback repeats the parse and must be guarded too.
# A guard on the first call only would look complete and still raise here.
print('\nVROOM fallback path:')
default_host = rs.resolve_vroom_host(None)
calls = {'n': 0}


def fake_post_fallback(*args, **kwargs):
    calls['n'] += 1
    if calls['n'] == 1:
        raise rs.requests.exceptions.ConnectionError('per-region VROOM down')
    return FakeResponse(504, INGRESS_TIMEOUT_BODY)


orig_post = rs.requests.post
rs.requests.post = fake_post_fallback
try:
    fb_resp = rs.get_vroom_response(VROOM_PAYLOAD, vroom_host='vroom-service-someotherregion')
except Exception as e:  # noqa: BLE001
    fb_resp = e
finally:
    rs.requests.post = orig_post

check('fallback: does not raise', isinstance(fb_resp, dict),
      f'{type(fb_resp).__name__}: {fb_resp}')
if isinstance(fb_resp, dict):
    check('fallback: flags an error', fb_resp.get('error') == 'non_json_response',
          f"error was {fb_resp.get('error')!r}")
    check('fallback: names the fallback host', fb_resp.get('ors_host') == default_host,
          f"host was {fb_resp.get('ors_host')!r}")
check('fallback: both calls were attempted', calls['n'] == 2, f"{calls['n']} calls")

# A valid VROOM body must still have its polyline geometry decoded. The happy
# path runs through polyline.decode, so a guard that swallowed a good response
# would break routing silently rather than loudly.
print('\nVROOM happy path is unaffected:')
import polyline  # noqa: E402

TRACK = [(37.8, -122.4), (37.79, -122.41), (37.78, -122.42)]


def fake_post_vroom_ok(*args, **kwargs):
    return FakeResponse(200, json.dumps({
        'code': 0,
        'routes': [{'geometry': polyline.encode(TRACK), 'cost': 123}],
    }), content_type='application/json')


orig_post = rs.requests.post
rs.requests.post = fake_post_vroom_ok
try:
    vok = rs.get_vroom_response(VROOM_PAYLOAD)
finally:
    rs.requests.post = orig_post

check('valid VROOM body parses', isinstance(vok, dict) and 'routes' in vok,
      f'got {str(vok)[:120]}')
check('valid VROOM body is not flagged as an error', (vok or {}).get('error') is None,
      f"error was {(vok or {}).get('error')!r}")
geom = ((vok or {}).get('routes') or [{}])[0].get('geometry')
check('polyline geometry is decoded to coordinate pairs',
      isinstance(geom, list) and len(geom) == len(TRACK)
      and all(isinstance(p, list) and len(p) == 2 for p in geom),
      f'geometry was {str(geom)[:120]}')
# Decoded as [lon, lat], not [lat, lon] - the reversal is part of the contract.
check('decoded geometry is [lon, lat] ordered',
      isinstance(geom, list) and geom and abs(geom[0][0] - TRACK[0][1]) < 1e-4
      and abs(geom[0][1] - TRACK[0][0]) < 1e-4,
      f'first point was {geom[0] if isinstance(geom, list) and geom else None}')

# ---------------------------------------------------------------------------
# Timeout ceiling. The parse guard makes the failure readable; this is what
# stops it happening at all, by failing inside the gateway first.
# ---------------------------------------------------------------------------
print('\nTimeout ceiling vs SPCS ingress:')
# SPCS ingress cuts at ~60-90 s and is not configurable from this repo. The
# gateway's own directions timeout must sit below the LOW end of that window.
INGRESS_FLOOR_S = 60
spec_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'routing-gateway-service.yaml')
with open(spec_path, 'r', encoding='utf-8') as fh:
    spec = fh.read()

check('spec pins ORS_TIMEOUT_DEFAULT', 'ORS_TIMEOUT_DEFAULT:' in spec,
      'directions would fall back to the 120s code default, which exceeds ingress')
check('spec pins ORS_TIMEOUT_MATRIX', 'ORS_TIMEOUT_MATRIX:' in spec)

for var in ('ORS_TIMEOUT_DEFAULT', 'ORS_TIMEOUT_MATRIX'):
    for line in spec.splitlines():
        if line.strip().startswith(f'{var}:'):
            value = int(line.split(':', 1)[1].strip().strip('"\''))
            check(f'{var} is below ingress floor', value < INGRESS_FLOOR_S,
                  f'{value}s is not under {INGRESS_FLOOR_S}s')
            break

# The image tag has to move or SPCS will not re-pull, and the fix ships in the
# image. A silently unchanged tag is a deploy that looks successful and runs old
# code.
env_path = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                        '..', '..', '..', 'image-versions.env'))
with open(env_path, 'r', encoding='utf-8') as fh:
    env = fh.read()
tag = next((l.split('=', 1)[1].strip() for l in env.splitlines()
            if l.startswith('ROUTING_REVERSE_PROXY_TAG=')), None)
check('gateway version matches image-versions.env', tag == rs.GATEWAY_VERSION,
      f'env tag {tag!r} vs GATEWAY_VERSION {rs.GATEWAY_VERSION!r}')
check('service spec references the same tag', f'routing_reverse_proxy:{tag}' in spec,
      f'spec does not reference routing_reverse_proxy:{tag}')

print(f'\n{passed} passed, {failed} failed')
sys.exit(1 if failed else 0)
