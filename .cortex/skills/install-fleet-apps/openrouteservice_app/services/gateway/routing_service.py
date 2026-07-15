from flask import Flask
from flask import request
from flask import make_response
from polyline import decode
import requests
import logging
import json
import os
import sys
import time
import uuid
import random
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor

SERVICE_HOST = os.getenv('SERVER_HOST', '0.0.0.0')
SERVICE_PORT = os.getenv('SERVER_PORT', 8080)
VROOM_PORT = os.getenv('VROOM_PORT', 3000)
ORS_PORT = os.getenv('ORS_PORT', 8082)
ORS_API_PATH = os.getenv('ORS_API_PATH', '/ors/v2')
MATRIX_CONCURRENCY = int(os.getenv('MATRIX_CONCURRENCY', '6'))
# v1.1.0 - Unified region model. There is NO global ORS_SERVICE or VROOM_SERVICE
# anymore; every region (including the default) is served by a per-region pair
# named ORS_SERVICE_<REGION> / VROOM_SERVICE_<REGION>. When a caller does not
# supply a region, we resolve it to DEFAULT_REGION_NAME so we still produce a
# valid per-region hostname. ORS_HOST / VROOM_HOST env vars are no longer read.
DEFAULT_REGION_NAME = os.getenv('DEFAULT_REGION_NAME', 'SanFrancisco')
# Per-endpoint downstream timeouts (seconds). Isochrones on continental graphs
# (e.g. USA driving-hgv) routinely take longer than the legacy 120 s default
# because fastisochrones is not enabled - see GitHub issue tracking that.
ORS_TIMEOUT_DEFAULT = int(os.getenv('ORS_TIMEOUT_DEFAULT', '120'))
ORS_TIMEOUT_MATRIX = int(os.getenv('ORS_TIMEOUT_MATRIX', '55'))
ORS_TIMEOUT_ISOCHRONES = int(os.getenv('ORS_TIMEOUT_ISOCHRONES', '300'))
GATEWAY_VERSION = 'v1.1.6'

def get_logger(logger_name):
    logger = logging.getLogger(logger_name)
    logger.setLevel(logging.DEBUG)
    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(logging.DEBUG)
    handler.setFormatter(
        logging.Formatter(
            '%(name)s [%(asctime)s] [%(levelname)s] %(message)s'))
    logger.addHandler(handler)
    return logger

logger = get_logger('routing-service')

app = Flask(__name__)


def _normalize_region(region):
    """Lowercase and strip spaces. Falls back to DEFAULT_REGION_NAME when empty."""
    if not region:
        region = DEFAULT_REGION_NAME
    return str(region).strip().lower().replace(' ', '')


def resolve_ors_host(region=None):
    """Per-region ORS service. After the v1.1.0 unification there is no global
    ORS_SERVICE - even the default region resolves to ors-service-<default>."""
    return f'ors-service-{_normalize_region(region)}'


def resolve_vroom_host(region=None):
    """Per-region VROOM service co-located with the region's ORS. After v1.1.0
    there is no global VROOM_SERVICE - the default region maps to
    vroom-service-<default>."""
    return f'vroom-service-{_normalize_region(region)}'


# Backward-compat aliases were retired in v1.1.5. Pre-v1.1.0 code referenced
# ORS_HOST / VROOM_HOST as the "global" service hostname; that model is gone.
# Every call site now resolves the host explicitly via resolve_ors_host(region)
# / resolve_vroom_host(region). Empty / None region falls back to
# DEFAULT_REGION_NAME via _normalize_region.


def _make_response(output_rows):
    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    return response


def _parse_rows(message):
    if message is None or not message.get('data'):
        return None
    return message['data']


def _extract_region(row, region_index):
    if region_index < len(row):
        val = row[region_index]
        if val is not None and str(val).strip() != '':
            return str(val).strip()
    return None


@app.get("/health")
def readiness_probe():
    return {'status': 'OK', 'version': GATEWAY_VERSION, 'ors_host': resolve_ors_host(None), 'vroom_host': resolve_vroom_host(None)}


def _get_ors_health(ors_host=None):
    host = ors_host or resolve_ors_host(None)
    try:
        health_url = f'http://{host}:{ORS_PORT}{ORS_API_PATH}/health'
        r = requests.get(url=health_url, timeout=5)
        return r.status_code == 200
    except Exception:
        return False


def _probe_ors_state(ors_host=None):
    """Distinguish 'warming_up' (process up, /health returns non-200, e.g. 503)
    from 'unreachable' (TCP refused / DNS fails, i.e. service suspended or not provisioned).
    Returns one of: 'ready' | 'warming_up' | 'unreachable' | 'unknown'."""
    host = ors_host or resolve_ors_host(None)
    try:
        health_url = f'http://{host}:{ORS_PORT}{ORS_API_PATH}/health'
        r = requests.get(url=health_url, timeout=5)
        if r.status_code == 200:
            return 'ready'
        # Process is accepting connections but /health says not-ready: graph still loading.
        return 'warming_up'
    except (requests.exceptions.ConnectionError, requests.exceptions.Timeout):
        return 'unreachable'
    except Exception:
        return 'unknown'


def _get_ors_status(ors_host=None):
    host = ors_host or resolve_ors_host(None)
    try:
        status_url = f'http://{host}:{ORS_PORT}{ORS_API_PATH}/status'
        logger.info(f'Querying ORS status: {status_url}')
        r = requests.get(url=status_url, timeout=10)
        status_data = r.json()

        bounds_info = {}
        if 'profiles' in status_data:
            for profile_name, profile_data in status_data['profiles'].items():
                bounds_info[profile_name] = {
                    'ready': True,
                    'encoder_name': profile_data.get('encoder_name', profile_name),
                    'graph_build_date': profile_data.get('graph_build_date'),
                    'osm_date': profile_data.get('osm_date')
                }

        health_ready = _get_ors_health(host)
        status_data['bounds_info'] = bounds_info
        status_data['service_ready'] = len(bounds_info) > 0
        status_data['health_ready'] = health_ready
        status_data['ors_host'] = host
        return status_data
    except requests.exceptions.ConnectionError:
        # Differentiate warming-up vs suspended/unknown by probing /health separately.
        state = _probe_ors_state(host)
        if state == 'warming_up':
            logger.info(f'ORS at {host} is warming up - /health returned non-200 while loading graph')
            return {
                'error': 'service_warming_up',
                'graph_loading': True,
                'message': f'ORS at {host} is warming up: graph is loading from stage. '
                           f'Typical wait: 1-10 min depending on region size. '
                           f'Re-poll ORS_STATUS(region) until service_ready=true.',
                'service_ready': False,
                'health_ready': False,
                'ors_host': host
            }
        logger.error(f'Cannot connect to ORS at {host} - service is suspended or region not provisioned')
        return {
            'error': 'service_unreachable',
            'graph_loading': False,
            'message': f'Cannot connect to ORS at {host}. Service appears suspended or region not provisioned. '
                       f'Try: 1) CALL CORE.RESUME_ALL_SERVICES() to resume, '
                       f'2) CALL CORE.SETUP_CITY_ORS(region) to provision a new region.',
            'service_ready': False,
            'health_ready': False,
            'ors_host': host
        }
    except requests.exceptions.Timeout:
        logger.error(f'ORS status request timed out on {host} - graphs may still be building')
        return {'error': 'timeout', 'message': 'ORS service not ready - graphs may still be building', 'service_ready': False, 'health_ready': False, 'ors_host': host}
    except Exception as e:
        logger.error(f'Error getting ORS status from {host}: {str(e)}')
        return {'error': str(e), 'service_ready': False, 'health_ready': False, 'ors_host': host}


@app.get("/ors_status")
def get_ors_status():
    return _get_ors_status()


@app.post("/ors_status")
def post_ors_status():
    """
    row = [id, region]  -- region can be NULL
    """
    message = request.json
    logger.debug(f'Received status request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {"data": [[0, _get_ors_status()]]}
    output_rows = []
    for row in input_rows:
        region = _extract_region(row, 1)
        ors_host = resolve_ors_host(region)
        output_rows.append([row[0], _get_ors_status(ors_host)])
    return _make_response(output_rows)


@app.get("/r/health/<region>")
def region_health(region):
    host = resolve_ors_host(region)
    status = _get_ors_status(host)
    return {
        'region': region,
        'host': host,
        'ready': status.get('service_ready', False),
        'profiles': list(status.get('profiles', {}).keys()) if 'profiles' in status else []
    }


def _compute_matrices_from_ors(locations, profile, ors_host):
    body = {
        'locations': locations,
        'metrics': ['distance', 'duration'],
    }
    endpoint = f'{ORS_API_PATH}/matrix/{profile}'
    if not endpoint.startswith('/'):
        endpoint = '/' + endpoint
    url = f'http://{ors_host}:{ORS_PORT}{endpoint}'
    # Tighter timeout (was 120s). Continental graphs can routinely exceed 120s
    # for a 200x200 matrix, and the silent fallback to per-leg VROOM routing
    # turns into a multi-minute apparent hang at the OPTIMIZATION TVF caller.
    # 45s is enough for any well-sized request (the UI now caps at ~50
    # locations) and lets us surface a clear error fast.
    timeout_s = int(os.getenv('ORS_TIMEOUT_MATRIX_PRECOMPUTE', '45'))
    logger.info(f'Pre-computing matrix from regional ORS: {url} with {len(locations)} locations (timeout={timeout_s}s)')
    try:
        r = requests.post(url=url, headers={'Content-Type': 'application/json'}, json=body, timeout=timeout_s)
        data = r.json()
        if 'durations' in data and 'distances' in data:
            durations = [[round(v) if v is not None else 0 for v in row] for row in data['durations']]
            costs = [[round(v) if v is not None else 0 for v in row] for row in data['distances']]
            return {'durations': durations, 'costs': costs}
        if 'error' in data:
            logger.error(f'ORS matrix error: {data}')
            return {'__error__': data.get('error') or data}
        return None
    except requests.exceptions.Timeout:
        logger.error(f'ORS matrix pre-compute timed out on {ors_host} after {timeout_s}s')
        return {'__error__': f'matrix pre-compute timed out after {timeout_s}s on {ors_host}'}
    except Exception as e:
        logger.error(f'Failed to pre-compute matrix from {ors_host}: {e}')
        return {'__error__': f'matrix pre-compute failed on {ors_host}: {e}'}


def _collect_locations(jobs, vehicles, shipments=None):
    locs = []
    indices = {}
    for item in (jobs or []) + (vehicles or []):
        if not isinstance(item, dict):
            continue
        for key in ['location', 'start', 'end']:
            loc = item.get(key)
            if loc and isinstance(loc, list) and len(loc) == 2:
                t = tuple(loc)
                if t not in indices:
                    indices[t] = len(locs)
                    locs.append(list(t))
    for sh in (shipments or []):
        if not isinstance(sh, dict):
            continue
        for side in ('pickup', 'delivery'):
            sub = sh.get(side)
            if isinstance(sub, dict):
                loc = sub.get('location')
                if loc and isinstance(loc, list) and len(loc) == 2:
                    t = tuple(loc)
                    if t not in indices:
                        indices[t] = len(locs)
                        locs.append(list(t))
    return locs, indices


def _remap_indices(jobs, vehicles, indices, shipments=None):
    # Keep both 'location'/'start'/'end' AND the new *_index keys.
    # Indices let VROOM use the pre-computed matrix (no ORS call for routing math).
    # Coords let vroom-express enrich the response with geometry by calling its
    # configured ORS host (which is the per-region service, so it has the coords).
    for item in (jobs or []):
        if isinstance(item, dict) and 'location' in item:
            t = tuple(item['location'])
            if t in indices:
                item['location_index'] = indices[t]
    for item in (vehicles or []):
        if not isinstance(item, dict):
            continue
        for key, idx_key in [('start', 'start_index'), ('end', 'end_index')]:
            if key in item:
                t = tuple(item[key])
                if t in indices:
                    item[idx_key] = indices[t]
    for sh in (shipments or []):
        if not isinstance(sh, dict):
            continue
        for side in ('pickup', 'delivery'):
            sub = sh.get(side)
            if isinstance(sub, dict) and 'location' in sub:
                t = tuple(sub['location'])
                if t in indices:
                    sub['location_index'] = indices[t]


def _handle_optimization_tabular(input_rows, ors_host_override=None, vroom_host_override=None):
    _collected_locs = []

    def build_vroom_payload(row):
        _collected_locs.clear()
        vehicles = row[2]
        for v in vehicles:
            if isinstance(v, dict) and 'profile' not in v:
                v['profile'] = 'driving-car'
        payload = {'jobs': row[1], 'vehicles': vehicles}
        shipments = row[4] if len(row) > 4 and row[4] else None
        if shipments:
            payload['shipments'] = shipments
        if len(row) > 3 and row[3]:
            matrices = row[3]
            if isinstance(matrices, dict) and len(matrices) > 0:
                payload['matrices'] = matrices
                payload['options'] = {'g': False}
            elif isinstance(matrices, list) and len(matrices) > 0:
                payload['matrices'] = matrices[0] if len(matrices) == 1 and isinstance(matrices[0], dict) else matrices
                payload['options'] = {'g': False}
        if ors_host_override and ors_host_override != resolve_ors_host(None) and 'matrices' not in payload:
            jobs = payload.get('jobs', [])
            vehs = payload.get('vehicles', [])
            shps = payload.get('shipments', [])
            profile = 'driving-car'
            for v in vehs:
                if isinstance(v, dict) and 'profile' in v:
                    profile = v['profile']
                    break
            locs, loc_indices = _collect_locations(jobs, vehs, shps)
            if len(locs) >= 2:
                computed = _compute_matrices_from_ors(locs, profile, ors_host_override)
                if isinstance(computed, dict) and computed.get('__error__'):
                    # Surface a structured error to the OPTIMIZATION caller
                    # instead of silently dropping the matrices and letting
                    # VROOM fall back to per-leg ORS routing (= multi-minute
                    # hang). The wrapper UI can render this directly.
                    payload['__matrix_error__'] = computed['__error__']
                elif computed:
                    _remap_indices(jobs, vehs, loc_indices, shps)
                    payload['matrices'] = {profile: computed}
                    payload['options'] = {'g': False}
                    _collected_locs.extend(locs)
                    logger.info(f'Injected pre-computed {len(locs)}x{len(locs)} matrix for {ors_host_override}')
                else:
                    logger.warning(f'Matrix pre-computation returned empty for {ors_host_override}, VROOM will use default ORS')
        return payload

    results = []
    for row in input_rows:
        payload = build_vroom_payload(row)
        if payload.get('__matrix_error__'):
            results.append([row[0], {
                'code': 99,
                'error': 'matrix_precompute_failed',
                'message': payload['__matrix_error__'],
                'hint': 'Try again after the ORS graph is fully loaded, or reduce the number of unique locations (lower vehicle/shipment caps).',
            }])
            continue
        resp = get_vroom_response(payload, vroom_host=vroom_host_override)
        if ors_host_override and 'routes' in resp:
            needs_geo = any('geometry' not in r for r in resp['routes'])
            if needs_geo:
                profile = 'driving-car'
                for v in (row[2] if len(row) > 2 else []):
                    if isinstance(v, dict) and 'profile' in v:
                        profile = v['profile']
                        break
                _reconstruct_geometry(resp['routes'], profile, ors_host_override, list(_collected_locs))
        results.append([row[0], resp])
    return results


def _reconstruct_geometry(routes, profile, ors_host, locations=None):
    for route in routes:
        if 'geometry' in route:
            continue
        coords = []
        for step in route.get('steps', []):
            loc = step.get('location')
            if not loc and 'location_index' in step and locations:
                idx = step['location_index']
                if 0 <= idx < len(locations):
                    loc = locations[idx]
            if loc and isinstance(loc, list) and len(loc) == 2:
                coords.append(loc)
        if len(coords) >= 2:
            try:
                body = {'coordinates': coords}
                endpoint = f'{ORS_API_PATH}/directions/{profile}/geojson'
                if not endpoint.startswith('/'):
                    endpoint = '/' + endpoint
                url = f'http://{ors_host}:{ORS_PORT}{endpoint}'
                r = requests.post(url=url, headers={'Content-Type': 'application/json'}, json=body, timeout=30)
                data = r.json()
                if 'features' in data and len(data['features']) > 0:
                    geom = data['features'][0].get('geometry', {})
                    route['geometry'] = geom.get('coordinates', coords)
                else:
                    route['geometry'] = coords
            except Exception as e:
                logger.warning(f'Geometry reconstruction failed for route {route.get("vehicle")}: {e}')
                route['geometry'] = coords
        elif len(coords) == 1:
            route['geometry'] = [coords[0], coords[0]]
        else:
            route['geometry'] = []


@app.post("/optimization_tabular")
def post_optimization_tabular():
    """
    row = [id, jobs, vehicles, matrices, region]
    region is the LAST column and can be NULL.
    """
    message = request.json
    logger.debug(f'Received request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}
    region = _extract_region(input_rows[0], -1)
    ors_host = resolve_ors_host(region) if region else None
    vroom_host = resolve_vroom_host(region) if region else None
    stripped_rows = []
    for row in input_rows:
        stripped_rows.append(row[:-1])
    output_rows = _handle_optimization_tabular(stripped_rows, ors_host_override=ors_host, vroom_host_override=vroom_host)
    logger.info(f'Produced {len(output_rows)} rows')
    return _make_response(output_rows)


@app.post("/optimization")
def post_optimization():
    """
    row = [id, challenge, region]
    region is the LAST column and can be NULL.
    """
    message = request.json
    logger.debug(f'Received request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}
    output_rows = []
    for row in input_rows:
        region = _extract_region(row, -1)
        ors_host = resolve_ors_host(region) if region else None
        vroom_host = resolve_vroom_host(region) if region else None
        if ors_host:
            shifted = [row[0], row[1]]
            tabular_rows = _handle_optimization_tabular(
                [[row[0], row[1].get('jobs', []), row[1].get('vehicles', []), row[1].get('matrices', []), row[1].get('shipments', [])]],
                ors_host_override=ors_host,
                vroom_host_override=vroom_host
            )
            output_rows.append(tabular_rows[0])
        else:
            output_rows.append([row[0], get_vroom_response(row[1])])
    logger.info(f'Produced {len(output_rows)} rows')
    return _make_response(output_rows)


def _handle_directions_tabular(input_rows, format, ors_host=None):
    host = ors_host or resolve_ors_host(None)
    output_rows = []
    for row in input_rows:
        output_rows.append([row[0], get_ors_response('directions', row[1], {'coordinates': [row[2], row[3]]}, format, host)])
    return output_rows


@app.post("/directions_tabular")
@app.post("/directions_tabular/<format>")
def post_directions_tabular_with_format(format="geojson"):
    """
    row = [id, method, start, end, region]
    region is the LAST column and can be NULL.
    """
    message = request.json
    logger.debug(f'Received request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}
    output_rows = []
    for row in input_rows:
        region = _extract_region(row, 4)
        ors_host = resolve_ors_host(region)
        output_rows.append([row[0], get_ors_response('directions', row[1], {'coordinates': [row[2], row[3]]}, format, ors_host)])
    return _make_response(output_rows)


def _handle_directions(input_rows, format, ors_host=None):
    host = ors_host or resolve_ors_host(None)
    return [[row[0], get_ors_response('directions', row[1], row[2], format, host)] for row in input_rows]


@app.post("/directions")
@app.post("/directions/<format>")
def post_directions_with_format(format="geojson"):
    """
    row = [id, method, locations, region]
    region is the LAST column and can be NULL.
    """
    message = request.json
    logger.debug(f'Received request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}
    output_rows = []
    for row in input_rows:
        region = _extract_region(row, 3)
        ors_host = resolve_ors_host(region)
        output_rows.append([row[0], get_ors_response('directions', row[1], row[2], format, ors_host)])
    return _make_response(output_rows)


def _isochrone_body(method_row, smoothing=None):
    """Build the ORS isochrones request body. (#113)

    `smoothing` is omitted from the payload when None / 0 so ORS skips the
    post-Dijkstra densification pass entirely (the engine default is to
    skip when the key is absent). Continental HGV isochrones at range=120
    spent a measurable slice of the 300s timeout budget on smoothing=10;
    callers that want polished polygons opt in explicitly.
    """
    body = {
        'locations': [[method_row[2], method_row[3]]],
        'range': [method_row[4] * 60],
        'location_type': 'start',
        'range_type': 'time',
    }
    if smoothing is not None and int(smoothing) > 0:
        body['smoothing'] = int(smoothing)
    return body


def _handle_isochrones_tabular(input_rows, format, ors_host=None):
    host = ors_host or resolve_ors_host(None)
    output_rows = []
    for row in input_rows:
        # Optional caller-supplied smoothing at position 5 (TABULAR caller).
        smoothing = row[5] if len(row) > 5 else None
        body = _isochrone_body(row, smoothing)
        output_rows.append([row[0], get_ors_response('isochrones', row[1], body, format, host)])
    return output_rows


@app.post("/isochrones_tabular")
@app.post("/isochrones_tabular/<format>")
def post_isochrones_tabular(format="geojson"):
    """
    row = [id, method, lon, lat, range, region]                (5-arg, legacy)
    row = [id, method, lon, lat, range, smoothing, region]     (6-arg, with smoothing)
    region is the LAST column and can be NULL. smoothing is optional and
    defaults to omitted (ORS engine default, equivalent to 0).
    """
    message = request.json
    logger.debug(f'Received request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}
    output_rows = []
    for row in input_rows:
        # 6-arg form has region at index 6, smoothing at index 5;
        # legacy 5-arg form has region at index 5, no smoothing.
        if len(row) >= 7:
            smoothing = row[5]
            region = _extract_region(row, 6)
        else:
            smoothing = None
            region = _extract_region(row, 5)
        ors_host = resolve_ors_host(region)
        body = _isochrone_body(row, smoothing)
        output_rows.append([row[0], get_ors_response('isochrones', row[1], body, format, ors_host)])
    logger.info(f'Produced {len(output_rows)} rows')
    return _make_response(output_rows)


@app.post("/isochrones")
@app.post("/isochrones/<format>")
def post_isochrones(format="geojson"):
    """
    Snowflake service-function row = [id, method, options, region].
    options VARIANT: { locations: [[lon, lat], ...], range: [seconds...],
                       range_type: 'time'|'distance', smoothing?: int }.
    Forwards locations/range/range_type to ORS isochrones (range in seconds
    when range_type is time). Unlike /isochrones_tabular, does not multiply
    range by 60.
    """
    message = request.json
    logger.debug(f'Received isochrones request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}
    output_rows = []
    for row in input_rows:
        region = _extract_region(row, 3)
        ors_host = resolve_ors_host(region)
        opts = row[2]
        if isinstance(opts, str):
            opts = json.loads(opts)
        if not isinstance(opts, dict):
            opts = {}
        body = {
            'locations': opts.get('locations', []),
            'range': opts.get('range', []),
            'range_type': opts.get('range_type', 'time'),
            'location_type': 'start',
        }
        smoothing = opts.get('smoothing')
        if smoothing is not None and int(smoothing) > 0:
            body['smoothing'] = int(smoothing)
        output_rows.append([row[0], get_ors_response(
            'isochrones', row[1], body, format, ors_host, region_hint=region)])
    logger.info(f'Produced {len(output_rows)} isochrone rows')
    return _make_response(output_rows)


def _build_matrix_body(method, row_data, has_destinations):
    if has_destinations:
        origin = row_data[0]
        destinations = row_data[1]
        if origin and not isinstance(origin[0], list):
            origin = [origin]
        locations = origin + destinations
        return {
            'locations': locations,
            'sources': list(range(len(origin))),
            'destinations': list(range(len(origin), len(locations))),
            'metrics': ['distance', 'duration'],
            'resolve_locations': True
        }
    else:
        return {
            'locations': row_data[0],
            'metrics': ['distance', 'duration'],
            'resolve_locations': True
        }


def _retry_matrix_chunked(profile, locations, sources_idx, destinations_idx, format, ors_host, chunk_size=50, _depth=0):
    # Depth guard (#audit-pr-120): the original implementation would silently
    # `continue` past failed chunks at the smallest chunk_size, returning a
    # stitched matrix with missing destination columns and no signal to the
    # caller that the result was incomplete. We now (a) cap recursion at
    # depth 2 (50 -> 10 -> stop) and (b) record per-chunk failures so the
    # response carries a `_partial` marker plus a `failed_destinations` list.
    MAX_DEPTH = 2
    all_durations = None
    all_distances = None
    failed_destinations = []

    for i in range(0, len(destinations_idx), chunk_size):
        chunk_dests = destinations_idx[i:i + chunk_size]
        body = {
            'locations': locations,
            'sources': sources_idx,
            'destinations': chunk_dests,
            'metrics': ['distance', 'duration'],
            'resolve_locations': True
        }
        resp = get_ors_response('matrix', profile, body, format, ors_host)
        if 'error' in resp:
            if chunk_size > 10 and _depth < MAX_DEPTH:
                partial = _retry_matrix_chunked(
                    profile, locations, sources_idx, chunk_dests, format, ors_host, 10,
                    _depth=_depth + 1,
                )
                if partial and 'error' not in partial:
                    if all_durations is None:
                        all_durations = [[] for _ in partial.get('durations', [])]
                        all_distances = [[] for _ in partial.get('distances', [])]
                    for r_idx, dur_row in enumerate(partial.get('durations', [])):
                        all_durations[r_idx].extend(dur_row)
                    for r_idx, dist_row in enumerate(partial.get('distances', [])):
                        all_distances[r_idx].extend(dist_row)
                    # Propagate any partial markers from the inner call.
                    if partial.get('_partial'):
                        failed_destinations.extend(partial.get('failed_destinations', []))
                    continue
            # Either we are at the smallest chunk_size or recursion is
            # exhausted: record the failed destination indices instead of
            # silently dropping them.
            failed_destinations.extend(chunk_dests)
            continue

        if all_durations is None:
            all_durations = [[] for _ in resp.get('durations', [])]
            all_distances = [[] for _ in resp.get('distances', [])]
        for r_idx, dur_row in enumerate(resp.get('durations', [])):
            all_durations[r_idx].extend(dur_row)
        for r_idx, dist_row in enumerate(resp.get('distances', [])):
            all_distances[r_idx].extend(dist_row)

    if all_durations is None:
        return {'error': 'all_chunks_failed', 'message': 'All matrix chunks failed'}

    result = {
        'durations': all_durations,
        'distances': all_distances,
        'sources': sources_idx,
        'destinations': destinations_idx
    }
    if failed_destinations:
        result['_partial'] = True
        result['failed_destinations'] = failed_destinations
    return result


@app.post("/matrix_tabular")
@app.post("/matrix_tabular/<format>")
def post_matrix_tabular(format="json"):
    """
    row = [id, method, origin, destinations, region]  (MATRIX_TABULAR 3-arg)
    row = [id, method, locations, region]              (MATRIX 2-arg)
    region is the LAST column and can be NULL.
    """
    message = request.json
    logger.debug(f'Received request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}

    def _process_row(row):
        region = _extract_region(row, -1)
        ors_host = resolve_ors_host(region)
        data_cols = row[1:-1]
        method = data_cols[0]
        has_dest = len(data_cols) == 3
        body = _build_matrix_body(method, data_cols[1:], has_dest)
        resp = get_ors_response('matrix', method, body, format, ors_host)
        error_obj = resp.get('error') if isinstance(resp, dict) else None
        if isinstance(error_obj, dict) and error_obj.get('code') == 6099 and has_dest:
            origin = data_cols[1]
            destinations = data_cols[2]
            if origin and not isinstance(origin[0], list):
                origin = [origin]
            locations = origin + destinations
            sources_idx = list(range(len(origin)))
            destinations_idx = list(range(len(origin), len(locations)))
            resp = _retry_matrix_chunked(method, locations, sources_idx, destinations_idx, format, ors_host)
        return [row[0], resp]

    with ThreadPoolExecutor(max_workers=MATRIX_CONCURRENCY) as executor:
        output_rows = list(executor.map(_process_row, input_rows))

    logger.info(f'Produced {len(output_rows)} rows')
    return _make_response(output_rows)


@app.post("/matrix")
@app.post("/matrix/<format>")
def post_matrix(format="json"):
    """
    row = [id, method, options, region]
    region is the LAST column and can be NULL.
    """
    message = request.json
    logger.debug(f'Received request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}

    output_rows = []
    for row in input_rows:
        region = _extract_region(row, 3)
        ors_host = resolve_ors_host(region)
        body = row[2]
        if isinstance(body, list):
            body = {
                'locations': body,
                'metrics': ['distance', 'duration'],
                'resolve_locations': True
            }
        output_rows.append([row[0], get_ors_response('matrix', row[1], body, format, ors_host)])

    logger.info(f'Produced {len(output_rows)} rows')
    return _make_response(output_rows)


def get_vroom_response(payload, vroom_host=None):
    logger.info(payload)
    default_vroom_host = resolve_vroom_host(None)
    host = vroom_host or default_vroom_host
    downstream_url = f'http://{host}:{VROOM_PORT}'
    downstream_headers = {"Content-Type": "application/json"}
    try:
        r = requests.post(url=downstream_url, headers=downstream_headers, json=payload, timeout=300)
        vroom_r = r.json()
    except requests.exceptions.ConnectionError:
        # Per-region VROOM unreachable. Fall back to the default-region VROOM service.
        if host != default_vroom_host:
            logger.warning(f'Per-region VROOM at {host} unreachable; falling back to default {default_vroom_host}')
            try:
                r = requests.post(url=f'http://{default_vroom_host}:{VROOM_PORT}',
                                  headers=downstream_headers, json=payload, timeout=300)
                vroom_r = r.json()
            except requests.exceptions.ConnectionError:
                logger.error(f'Cannot connect to VROOM at {default_vroom_host}:{VROOM_PORT} (fallback)')
                return {'error': 'connection_failed', 'message': f'Cannot connect to VROOM service at {host} or fallback {default_vroom_host}:{VROOM_PORT}'}
        else:
            logger.error(f'Cannot connect to VROOM at {host}:{VROOM_PORT}')
            return {'error': 'connection_failed', 'message': f'Cannot connect to VROOM service at {host}:{VROOM_PORT}'}
    except requests.exceptions.Timeout:
        logger.error(f'VROOM request timed out at {host}')
        return {'error': 'timeout', 'message': 'VROOM optimization request timed out'}
    logger.debug(f'VROOM response from {host}: {vroom_r}')
    if 'routes' in vroom_r:
        for route in vroom_r['routes']:
            if 'geometry' in route:
                decoded_geometry = decode(route['geometry'])
                route['geometry'] = [[lon, lat] for lat, lon in decoded_geometry]
    return vroom_r


def _extract_payload_locations(payload):
    """Best-effort extraction of [lon, lat] pairs from an ORS request payload.
    Different endpoints use different keys (coordinates / locations).
    Returns a list of [lon, lat] pairs, or [] if none can be found."""
    if not isinstance(payload, dict):
        return []
    for key in ('locations', 'coordinates'):
        val = payload.get(key)
        if isinstance(val, list) and val and isinstance(val[0], list):
            return val
    return []


def _is_plausible_us_lonlat(lon, lat):
    """CONUS bbox sanity check. Used only to hint at swapped lon/lat."""
    try:
        return -125.0 <= float(lon) <= -66.0 and 24.0 <= float(lat) <= 49.0
    except (TypeError, ValueError):
        return False


def _annotate_engine_error(resp, host, payload):
    """If ORS returned an engine-level error (e.g. code 3099 'Unable to build an
    isochrone map'), enrich the response with gateway diagnostics: host, the
    coordinates that were sent, and a swapped-lon/lat hint when applicable.
    Adds a non-destructive `gateway_diagnostics` block; existing fields are
    untouched so downstream UDF error mapping continues to work."""
    if not isinstance(resp, dict):
        return resp
    err = resp.get('error')
    if not isinstance(err, dict):
        return resp
    code = err.get('code')
    locations = _extract_payload_locations(payload)
    diagnostics = {
        'ors_host': host,
        'requested_locations_lon_lat': locations,
        'hint': None,
    }
    # Swapped lon/lat hint: ORS expects [lon, lat]. If the caller passed
    # [lat, lon] and only the swapped form is plausible CONUS, point that out.
    if locations:
        first = locations[0]
        if isinstance(first, list) and len(first) >= 2:
            lon, lat = first[0], first[1]
            if not _is_plausible_us_lonlat(lon, lat) and _is_plausible_us_lonlat(lat, lon):
                diagnostics['hint'] = (
                    'Coordinates may be swapped. ORS expects [longitude, latitude] '
                    '(longitude first). For US points longitude is negative, '
                    'roughly -125..-66, and latitude is +24..+49.'
                )
    if code == 3099:
        diagnostics['hint'] = diagnostics['hint'] or (
            'ORS could not snap the start point to a routable edge. The point '
            'is likely outside the loaded region graph, in water, or far from '
            'any road. Verify the coordinate is on land within the region '
            'bounding box and that longitude is passed before latitude.'
        )
    if diagnostics['hint'] or code is not None:
        resp['gateway_diagnostics'] = diagnostics
    return resp


# ---------------------------------------------------------------------------
# Circuit breaker around per-host ORS calls (#50).
#
# State machine:
#   CLOSED    -- normal, all calls pass through.
#   OPEN      -- recent error rate exceeded threshold; calls fail fast for
#                `cooldown_s` seconds without hitting ORS.
#   HALF_OPEN -- cooldown elapsed; allow the next call as a probe. On success
#                the breaker closes; on failure it re-opens with a fresh
#                cooldown timer.
#
# Tunables (env-overridable so the operator can match the values to the
# rolling-window error-rate they see in the #56 observability dashboard):
#   ORS_BREAKER_FAILURE_THRESHOLD   default 5  consecutive transient failures
#   ORS_BREAKER_ROLLING_WINDOW_S    default 30 seconds the failure counter
#                                              accumulates over
#   ORS_BREAKER_COOLDOWN_S          default 30 seconds OPEN -> HALF_OPEN
#
# Per-host -- a single bad region cannot drag down the gateway for healthy
# regions. Counters held in-process; on container restart we start clean
# (acceptable; the gateway is stateless by design).
# ---------------------------------------------------------------------------
ORS_BREAKER_FAILURE_THRESHOLD = int(os.getenv('ORS_BREAKER_FAILURE_THRESHOLD', '5'))
ORS_BREAKER_ROLLING_WINDOW_S = int(os.getenv('ORS_BREAKER_ROLLING_WINDOW_S', '30'))
ORS_BREAKER_COOLDOWN_S = int(os.getenv('ORS_BREAKER_COOLDOWN_S', '30'))
ORS_RETRY_MAX_ATTEMPTS = int(os.getenv('ORS_RETRY_MAX_ATTEMPTS', '3'))
ORS_RETRY_BACKOFF_BASE_MS = int(os.getenv('ORS_RETRY_BACKOFF_BASE_MS', '500'))

# ---------------------------------------------------------------------------
# Request-size guardrails (#51).
#
# Reject payloads that would exceed the active ORS preset's caps BEFORE
# burning the gateway-side timeout budget. Defaults mirror the values in
# routing-customization/references/ors-config-presets/standard.yml; the
# continental preset (and any future preset) widens these via env vars,
# keeping the active ors-config.yml as the single source of truth.
#
# Each cap has a matching env-override so the operator can match the cap
# to the actual preset deployed:
#   ORS_GUARDRAIL_MATRIX_MAX_LOCATIONS    default 200  (sqrt(2 000 000))
#   ORS_GUARDRAIL_ISOCHRONES_MAX_LOCATIONS default 50
#   ORS_GUARDRAIL_ISOCHRONES_MAX_INTERVALS default 10
#   ORS_GUARDRAIL_ISOCHRONES_MAX_RANGE_S  default 18000 (5h, matches engine)
#   ORS_GUARDRAIL_DIRECTIONS_MAX_WAYPOINTS default 1000
# ---------------------------------------------------------------------------
GUARDRAIL_MATRIX_MAX_LOCATIONS = int(os.getenv('ORS_GUARDRAIL_MATRIX_MAX_LOCATIONS', '200'))
GUARDRAIL_ISOCHRONES_MAX_LOCATIONS = int(os.getenv('ORS_GUARDRAIL_ISOCHRONES_MAX_LOCATIONS', '50'))
GUARDRAIL_ISOCHRONES_MAX_INTERVALS = int(os.getenv('ORS_GUARDRAIL_ISOCHRONES_MAX_INTERVALS', '10'))
GUARDRAIL_ISOCHRONES_MAX_RANGE_S = int(os.getenv('ORS_GUARDRAIL_ISOCHRONES_MAX_RANGE_S', '18000'))
GUARDRAIL_DIRECTIONS_MAX_WAYPOINTS = int(os.getenv('ORS_GUARDRAIL_DIRECTIONS_MAX_WAYPOINTS', '1000'))


def _guardrail_response(endpoint, host, message, limits):
    """Structured 4xx-shaped failure surfaced to the caller. Identical envelope
    shape to ORS engine errors so SQL callers (which already special-case
    'error') do not need to learn a new schema."""
    return {
        'error': 'request_too_large',
        'endpoint': endpoint,
        'message': message,
        'limits': limits,
        'ors_host': host,
        'status': 413,
    }


def _validate_request(endpoint, payload, host=None):
    """Returns (ok, error_dict). Caller should short-circuit when ok is False.

    Limits are the ones the active ors-config.yml preset would also enforce
    -- but rejecting Snowflake-side avoids round-tripping a multi-MB body
    to ORS only to be 4xx'd."""
    if not isinstance(payload, dict):
        return True, None
    locations = payload.get('locations') or []
    if endpoint == 'matrix':
        if isinstance(locations, list) and len(locations) > GUARDRAIL_MATRIX_MAX_LOCATIONS:
            return False, _guardrail_response(
                endpoint, host,
                f'Matrix payload has {len(locations)} locations; gateway cap is '
                f'{GUARDRAIL_MATRIX_MAX_LOCATIONS}. Reduce the request, or chunk via '
                f'OPTIMIZATION_TABULAR / _retry_matrix_chunked which already splits.',
                {'max_locations': GUARDRAIL_MATRIX_MAX_LOCATIONS, 'observed_locations': len(locations)},
            )
    elif endpoint == 'isochrones':
        if isinstance(locations, list) and len(locations) > GUARDRAIL_ISOCHRONES_MAX_LOCATIONS:
            return False, _guardrail_response(
                endpoint, host,
                f'Isochrones payload has {len(locations)} locations; ORS engine '
                f'cap is {GUARDRAIL_ISOCHRONES_MAX_LOCATIONS}. Split into separate calls.',
                {'max_locations': GUARDRAIL_ISOCHRONES_MAX_LOCATIONS, 'observed_locations': len(locations)},
            )
        ranges = payload.get('range') or []
        if isinstance(ranges, list):
            if len(ranges) > GUARDRAIL_ISOCHRONES_MAX_INTERVALS:
                return False, _guardrail_response(
                    endpoint, host,
                    f'Isochrones has {len(ranges)} intervals; cap is '
                    f'{GUARDRAIL_ISOCHRONES_MAX_INTERVALS}.',
                    {'max_intervals': GUARDRAIL_ISOCHRONES_MAX_INTERVALS, 'observed_intervals': len(ranges)},
                )
            range_type = payload.get('range_type', 'time')
            if range_type == 'time' and ranges and max(ranges) > GUARDRAIL_ISOCHRONES_MAX_RANGE_S:
                return False, _guardrail_response(
                    endpoint, host,
                    f'Isochrones range {max(ranges)}s exceeds {GUARDRAIL_ISOCHRONES_MAX_RANGE_S}s. '
                    f'For continental reach, deploy the continental preset and widen '
                    f'ORS_GUARDRAIL_ISOCHRONES_MAX_RANGE_S to match.',
                    {'max_range_s': GUARDRAIL_ISOCHRONES_MAX_RANGE_S, 'observed_range_s': max(ranges)},
                )
    elif endpoint == 'directions':
        if isinstance(locations, list) and len(locations) > GUARDRAIL_DIRECTIONS_MAX_WAYPOINTS:
            return False, _guardrail_response(
                endpoint, host,
                f'Directions has {len(locations)} waypoints; cap is '
                f'{GUARDRAIL_DIRECTIONS_MAX_WAYPOINTS}.',
                {'max_waypoints': GUARDRAIL_DIRECTIONS_MAX_WAYPOINTS, 'observed_waypoints': len(locations)},
            )
    return True, None

_BREAKER_STATE = {}  # host -> {failures: [ts...], open_until: float, state: 'CLOSED'|'OPEN'|'HALF_OPEN'}


def _breaker_check(host):
    """Returns (allow, reason). allow=False means fail fast without calling ORS."""
    st = _BREAKER_STATE.get(host)
    if not st:
        return True, None
    now = time.monotonic()
    if st['state'] == 'OPEN':
        if now >= st.get('open_until', 0):
            st['state'] = 'HALF_OPEN'
            logger.warning(f'circuit-breaker HALF_OPEN for {host} after cooldown')
            return True, None
        return False, 'circuit_open'
    return True, None


def _breaker_on_success(host):
    st = _BREAKER_STATE.get(host)
    if not st:
        return
    if st['state'] != 'CLOSED':
        logger.warning(f'circuit-breaker CLOSED for {host}')
    st['state'] = 'CLOSED'
    st['failures'] = []
    st['open_until'] = 0


def _breaker_on_failure(host):
    now = time.monotonic()
    st = _BREAKER_STATE.setdefault(host, {'failures': [], 'open_until': 0, 'state': 'CLOSED'})
    # Drop failures outside the rolling window.
    cutoff = now - ORS_BREAKER_ROLLING_WINDOW_S
    st['failures'] = [t for t in st['failures'] if t >= cutoff]
    st['failures'].append(now)
    if st['state'] == 'HALF_OPEN' or len(st['failures']) >= ORS_BREAKER_FAILURE_THRESHOLD:
        st['state'] = 'OPEN'
        st['open_until'] = now + ORS_BREAKER_COOLDOWN_S
        logger.error(f'circuit-breaker OPEN for {host} (failures={len(st["failures"])}, cooldown={ORS_BREAKER_COOLDOWN_S}s)')


def _emit_metric(endpoint, profile, host, status, latency_ms, req_bytes, resp_bytes,
                 error_code=None, caller=None, region=None, request_id=None):
    """Stream one `[ORS_METRIC] {json}` line to stdout. Picked up by the
    INGEST_ORS_METRICS Snowflake procedure on a 1-minute schedule (see
    08_observability.sql). Never raise from here -- a logging failure must
    never break a routing call. (#56)
    """
    try:
        payload = {
            'ts': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
            'request_id': request_id or uuid.uuid4().hex,
            'endpoint': endpoint,
            'profile': profile,
            'region': region,
            'ors_host': host,
            'status': status,
            'error': error_code,
            'latency_ms': latency_ms,
            'req_bytes': req_bytes,
            'resp_bytes': resp_bytes,
            'caller': caller,
        }
        # Single-line emission so SPLIT_TO_TABLE works cleanly in the ingest proc.
        sys.stdout.write('[ORS_METRIC] ' + json.dumps(payload, separators=(',', ':')) + '\n')
        sys.stdout.flush()
    except Exception:
        pass


def get_ors_response(function, profile, payload, format, ors_host=None, region_hint=None, caller='request'):
    host = ors_host or resolve_ors_host(None)
    endpoint = "/".join(filter(None, [ORS_API_PATH, function, profile, format]))
    if not endpoint.startswith('/'):
        endpoint = '/' + endpoint

    downstream_url = f'http://{host}:{ORS_PORT}{endpoint}'
    downstream_headers = {"Content-Type": "application/json"}
    # Isochrones on large graphs (e.g. USA driving-hgv) can take > 120 s because
    # fastisochrones preparation is not enabled. Use a longer per-endpoint
    # timeout for isochrones to avoid silent gateway-side cliffs.
    if function == 'isochrones':
        timeout_s = ORS_TIMEOUT_ISOCHRONES
    elif function == 'matrix':
        timeout_s = ORS_TIMEOUT_MATRIX
    else:
        timeout_s = ORS_TIMEOUT_DEFAULT
    logger.info(f'Calling: {downstream_url} (timeout={timeout_s}s)')
    logger.info(f'Payload: {payload}')

    # Pre-compute payload byte size once for observability.
    try:
        req_bytes = len(json.dumps(payload).encode('utf-8'))
    except Exception:
        req_bytes = None

    # Request-size guardrails (#51). Fail fast with a structured 4xx-shape
    # before burning the gateway timeout budget on a request the engine
    # will reject anyway.
    ok, guard_err = _validate_request(function, payload, host)
    if not ok:
        req_id = uuid.uuid4().hex
        _emit_metric(function, profile, host, 413, 0, req_bytes, None,
                     error_code='request_too_large', caller=caller, region=region_hint, request_id=req_id)
        return guard_err

    # Circuit breaker (#50). Fail fast without touching ORS while OPEN.
    allow, breaker_reason = _breaker_check(host)
    if not allow:
        req_id = uuid.uuid4().hex
        _emit_metric(function, profile, host, 503, 0, req_bytes, None,
                     error_code='circuit_open', caller=caller, region=region_hint, request_id=req_id)
        return {
            'error': 'circuit_open',
            'message': f'Circuit breaker is OPEN for {host} after repeated failures. '
                       f'Calls will resume after the {ORS_BREAKER_COOLDOWN_S}s cooldown. '
                       f'See the Observability page for the failing endpoint history.',
            'ors_host': host,
        }

    last_error_payload = None
    for attempt in range(1, ORS_RETRY_MAX_ATTEMPTS + 1):
        req_id = uuid.uuid4().hex
        t0 = time.monotonic()
        retried_caller = caller if attempt == 1 else f'{caller}.retry{attempt - 1}'
        try:
            r = requests.post(url=downstream_url, headers=downstream_headers, json=payload, timeout=timeout_s)
            latency_ms = int((time.monotonic() - t0) * 1000)
            resp_bytes = len(r.content) if r.content is not None else None
            resp = r.json()
            logger.debug(resp)
            annotated = _annotate_engine_error(resp, host, payload)
            engine_err = annotated.get('error') if isinstance(annotated, dict) else None
            err_code = (engine_err if isinstance(engine_err, str)
                        else (engine_err.get('code') if isinstance(engine_err, dict) else None))
            _emit_metric(function, profile, host, r.status_code, latency_ms, req_bytes, resp_bytes,
                         error_code=err_code, caller=retried_caller, region=region_hint, request_id=req_id)
            # Retry only on server-side transient failures (5xx). 4xx are user errors,
            # 2xx/3xx are success-shaped, both end the loop here.
            if 500 <= r.status_code < 600 and attempt < ORS_RETRY_MAX_ATTEMPTS:
                last_error_payload = annotated
                _breaker_on_failure(host)
                backoff_s = (ORS_RETRY_BACKOFF_BASE_MS * (2 ** (attempt - 1))) / 1000.0
                # +/-25% jitter (full random distribution) so simultaneous
                # callers do not synchronize retries. Using random.uniform
                # avoids the previous deterministic-per-req_id pattern that
                # only produced 3 distinct jitter values.
                backoff_s *= random.uniform(0.75, 1.25)
                logger.warning(f'ORS {r.status_code} on {host}; retry {attempt}/{ORS_RETRY_MAX_ATTEMPTS - 1} after {backoff_s:.2f}s')
                time.sleep(backoff_s)
                continue
            _breaker_on_success(host)
            return annotated
        except requests.exceptions.ConnectionError:
            latency_ms = int((time.monotonic() - t0) * 1000)
            region_label = f' (host: {host})' if host != resolve_ors_host(None) else ''
            # Differentiate warming-up vs suspended/unknown by probing /health separately.
            state = _probe_ors_state(host)
            if state == 'warming_up':
                logger.info(f'ORS{region_label} is warming up - graph still loading')
                _emit_metric(function, profile, host, 503, latency_ms, req_bytes, None,
                             error_code='service_warming_up', caller=retried_caller, region=region_hint, request_id=req_id)
                # Do not retry warming-up: the graph load takes minutes, not
                # milliseconds. Surface the wait-and-retry hint to the caller.
                return {
                    'error': 'service_warming_up',
                    'graph_loading': True,
                    'message': f'ORS{region_label} is warming up: graph is loading from stage. '
                               f'Typical wait: 1-10 min depending on region size. '
                               f'Re-poll SELECT CORE.ORS_STATUS(region) until service_ready=true, then retry.',
                    'ors_host': host
                }
            logger.error(f'Cannot connect to ORS{region_label} (attempt {attempt}) - suspended or not provisioned')
            _emit_metric(function, profile, host, 502, latency_ms, req_bytes, None,
                         error_code='service_unreachable', caller=retried_caller, region=region_hint, request_id=req_id)
            _breaker_on_failure(host)
            last_error_payload = {
                'error': 'service_unreachable',
                'graph_loading': False,
                'message': f'Cannot connect to ORS{region_label}. Service appears suspended or region not provisioned. '
                           f'Try: 1) CALL CORE.RESUME_ALL_SERVICES() to resume, '
                           f'2) SELECT CORE.ORS_STATUS(region) to check readiness, '
                           f'3) CALL CORE.SETUP_CITY_ORS(region) to provision a new region.',
                'ors_host': host,
            }
            if attempt < ORS_RETRY_MAX_ATTEMPTS:
                backoff_s = (ORS_RETRY_BACKOFF_BASE_MS * (2 ** (attempt - 1))) / 1000.0
                logger.warning(f'service_unreachable on {host}; retry {attempt}/{ORS_RETRY_MAX_ATTEMPTS - 1} after {backoff_s:.2f}s')
                time.sleep(backoff_s)
                continue
            return last_error_payload
        except requests.exceptions.Timeout:
            # Do not retry on timeout. A timed-out call already burned the full
            # per-endpoint timeout budget; retrying would multiply load on a
            # likely-overloaded ORS without improving the outcome.
            latency_ms = int((time.monotonic() - t0) * 1000)
            logger.error(f'ORS request timed out on {host} after {timeout_s}s')
            _emit_metric(function, profile, host, 504, latency_ms, req_bytes, None,
                         error_code='timeout', caller=retried_caller, region=region_hint, request_id=req_id)
            _breaker_on_failure(host)
            return {
                'error': 'timeout',
                'message': f'ORS request timed out on {host} after {timeout_s}s. '
                           f'Possible causes: graphs still loading after resume (~2-3 min), '
                           f'or request too large (e.g. very large isochrone range on a continental graph). '
                           f'Try reducing range/batch size, or check ORS_STATUS().',
                'ors_host': host,
                'timeout_seconds': timeout_s
            }

    return last_error_payload or {'error': 'unknown', 'message': 'no response from ORS', 'ors_host': host}


if __name__ == '__main__':
    app.run(host=SERVICE_HOST, port=SERVICE_PORT)
