#!/usr/bin/env python3
"""Negative tests for verify_gateway_non_json.py - each case re-creates one of
the non-JSON response defects the suite guards, and the suite must fail on the
specific check for it.

The incident: a DIRECTIONS call for a disconnected coordinate pair ran past the
SPCS ingress cut-off, ingress answered with a plain-text 'upstream request
timeout', and an unguarded r.json() turned that into a Flask 500 and an opaque
SQL error. The suite protects four things, and each gets a case here:

  * the parse guard on each of the THREE r.json() call sites (ORS, VROOM, and
    the VROOM per-region fallback - guarding only the first looks complete and
    still raises on the second)
  * the non-JSON envelope is returned, not retried (the call already burned the
    full ingress budget, so a retry triples a 90 s wait)
  * ORS_TIMEOUT_DEFAULT in the service spec sits under the ingress floor, so
    the gateway fails first with its own readable envelope
  * the gateway tag moves in lockstep across image-versions.env, the code's
    GATEWAY_VERSION and the service spec image (an unmoved spec tag is a deploy
    that looks successful and keeps running the old image)

Each guard mutation narrows `except ValueError` to `except KeyError`, which
leaves the code compiling and the happy path untouched while letting
JSONDecodeError escape - the exact pre-fix behaviour.

Run with an interpreter that has flask + requests + polyline: the suite imports
routing_service, which imports all three at module load.
"""
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SK = ".cortex/skills/install-fleet-apps"
GW = f"{SK}/openrouteservice_app/services/gateway"
PY = f"{GW}/routing_service.py"
SPEC = f"{GW}/routing-gateway-service.yaml"
ENV = f"{SK}/image-versions.env"

# PYTHONDONTWRITEBYTECODE: N3 and N4 produce files of IDENTICAL size (both
# narrow ValueError to KeyError), and when both are written within the same
# second the .pyc freshness check (mtime in whole seconds + size) reuses the
# previous case's bytecode - N4 then "fails" with N3's defect, which is a
# cross-case mask. Never caching bytecode makes every run compile its source.
h = Harness("verify_gateway_non_json.py", path=f"{GW}/verify_gateway_non_json.py",
            env={"PYTHONDONTWRITEBYTECODE": "1"})

h.replace(PY, "            except ValueError:\n                # Returned rather than retried",
          "            except KeyError:\n                # Returned rather than retried",
          expect="FAIL: ingress timeout: does not raise - JSONDecodeError",
          name="N1 ORS r.json() unguarded")

h.replace(PY, "                _breaker_on_failure(host, 'non_json_response')\n"
              "                return _non_json_envelope(r, host, service='ORS', latency_ms=latency_ms)",
          "                _breaker_on_failure(host, 'non_json_response')\n"
              "                last_error_payload = _non_json_envelope(r, host, service='ORS', latency_ms=latency_ms)\n"
              "                continue",
          expect="FAIL: ingress timeout: does not retry - 3 downstream calls",
          name="N2 non-JSON body retried instead of returned")

h.replace(PY, "        except ValueError:\n            logger.error(f'Non-JSON response from VROOM at {host}",
          "        except KeyError:\n            logger.error(f'Non-JSON response from VROOM at {host}",
          expect="FAIL: vroom ingress timeout: does not raise - JSONDecodeError",
          name="N3 VROOM primary r.json() unguarded")

# Only the fallback loses its guard: the primary-path checks all stay green, so
# the suite must convict on the fallback section alone.
h.replace(PY, "                except ValueError:\n"
              "                    logger.error(f'Non-JSON response from fallback VROOM",
          "                except KeyError:\n"
              "                    logger.error(f'Non-JSON response from fallback VROOM",
          expect="FAIL: fallback: does not raise - JSONDecodeError",
          name="N4 VROOM fallback r.json() unguarded")

# Back to the 120 s code default: longer than ingress, so ingress wins again.
h.replace(SPEC, 'ORS_TIMEOUT_DEFAULT: "55"', 'ORS_TIMEOUT_DEFAULT: "120"',
          expect="FAIL: ORS_TIMEOUT_DEFAULT is below ingress floor - 120s",
          name="N5 directions timeout above the ingress floor")


# The tag is bumped in image-versions.env and GATEWAY_VERSION (so those two
# agree) but the service spec still names the old image. Read the live tag
# rather than hardcoding it - it moves on every gateway release.
env_p, py_p = h.path(ENV), h.path(PY)
env_orig, py_orig = env_p.read_text(), py_p.read_text()
cur = re.search(r"^ROUTING_REVERSE_PROXY_TAG=(\S+)$", env_orig, re.M)
assert cur, f"ROUTING_REVERSE_PROXY_TAG not found in {ENV}"
old_tag, new_tag = cur.group(1), cur.group(1) + "9"


def bump_without_spec():
    env_new = env_orig.replace(f"ROUTING_REVERSE_PROXY_TAG={old_tag}",
                               f"ROUTING_REVERSE_PROXY_TAG={new_tag}", 1)
    py_new = py_orig.replace(f"GATEWAY_VERSION = '{old_tag}'", f"GATEWAY_VERSION = '{new_tag}'", 1)
    assert env_new != env_orig and py_new != py_orig, "tag anchors not found"
    env_p.write_text(env_new)
    py_p.write_text(py_new)


def restore_tag():
    env_p.write_text(env_orig)
    py_p.write_text(py_orig)


h.custom("N6 tag bumped in env + code but not in the service spec",
         bump_without_spec, restore_tag,
         expect=f"FAIL: service spec references the same tag - spec does not reference "
                f"routing_reverse_proxy:{new_tag}")

sys.exit(h.finish())
