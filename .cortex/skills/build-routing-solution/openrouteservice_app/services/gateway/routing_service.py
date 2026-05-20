from flask import Flask
from flask import request
from flask import make_response
from polyline import decode
import requests
import logging
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

SERVICE_HOST = os.getenv('SERVER_HOST', '0.0.0.0')
SERVICE_PORT = os.getenv('SERVER_PORT', 8080)
VROOM_PORT = os.getenv('VROOM_PORT', 3000)
ORS_PORT = os.getenv('ORS_PORT', 8082)
ORS_API_PATH = os.getenv('ORS_API_PATH', '/ors/v2')
MATRIX_CONCURRENCY = int(os.getenv('MATRIX_CONCURRENCY', '6'))
# v1.1.0 — Unified region model. There is NO global ORS_SERVICE or VROOM_SERVICE
# anymore; every region (including the default) is served by a per-region pair
# named ORS_SERVICE_<REGION> / VROOM_SERVICE_<REGION>. When a caller does not
# supply a region, we resolve it to DEFAULT_REGION_NAME so we still produce a
# valid per-region hostname. ORS_HOST / VROOM_HOST env vars are no longer read.
DEFAULT_REGION_NAME = os.getenv('DEFAULT_REGION_NAME', 'SanFrancisco')
# Per-endpoint downstream timeouts (seconds). Isochrones on continental graphs
# (e.g. USA driving-hgv) routinely take longer than the legacy 120 s default
# because fastisochrones is not enabled — see GitHub issue tracking that.
ORS_TIMEOUT_DEFAULT = int(os.getenv('ORS_TIMEOUT_DEFAULT', '120'))
ORS_TIMEOUT_ISOCHRONES = int(os.getenv('ORS_TIMEOUT_ISOCHRONES', '300'))
GATEWAY_VERSION = 'v1.1.5'

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
    ORS_SERVICE — even the default region resolves to ors-service-<default>."""
    return f'ors-service-{_normalize_region(region)}'


def resolve_vroom_host(region=None):
    """Per-region VROOM service co-located with the region's ORS. After v1.1.0
    there is no global VROOM_SERVICE — the default region maps to
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
    logger.info(f'Pre-computing matrix from regional ORS: {url} with {len(locations)} locations')
    try:
        r = requests.post(url=url, headers={'Content-Type': 'application/json'}, json=body, timeout=120)
        data = r.json()
        if 'durations' in data and 'distances' in data:
            durations = [[round(v) if v is not None else 0 for v in row] for row in data['durations']]
            costs = [[round(v) if v is not None else 0 for v in row] for row in data['distances']]
            return {'durations': durations, 'costs': costs}
        if 'error' in data:
            logger.error(f'ORS matrix error: {data}')
            return None
        return None
    except Exception as e:
        logger.error(f'Failed to pre-compute matrix from {ors_host}: {e}')
        return None


def _collect_locations(jobs, vehicles):
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
    return locs, indices


def _remap_indices(jobs, vehicles, indices):
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


def _handle_optimization_tabular(input_rows, ors_host_override=None, vroom_host_override=None):
    _collected_locs = []

    def build_vroom_payload(row):
        _collected_locs.clear()
        vehicles = row[2]
        for v in vehicles:
            if isinstance(v, dict) and 'profile' not in v:
                v['profile'] = 'driving-car'
        payload = {'jobs': row[1], 'vehicles': vehicles}
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
            profile = 'driving-car'
            for v in vehs:
                if isinstance(v, dict) and 'profile' in v:
                    profile = v['profile']
                    break
            locs, loc_indices = _collect_locations(jobs, vehs)
            if len(locs) >= 2:
                computed = _compute_matrices_from_ors(locs, profile, ors_host_override)
                if computed:
                    _remap_indices(jobs, vehs, loc_indices)
                    payload['matrices'] = {profile: computed}
                    payload['options'] = {'g': False}
                    _collected_locs.extend(locs)
                    logger.info(f'Injected pre-computed {len(locs)}x{len(locs)} matrix for {ors_host_override}')
                else:
                    logger.warning(f'Matrix pre-computation failed for {ors_host_override}, VROOM will use default ORS')
        return payload

    results = []
    for row in input_rows:
        resp = get_vroom_response(build_vroom_payload(row), vroom_host=vroom_host_override)
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
                [[row[0], row[1].get('jobs', []), row[1].get('vehicles', []), row[1].get('matrices', [])]],
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


def _handle_isochrones_tabular(input_rows, format, ors_host=None):
    host = ors_host or resolve_ors_host(None)
    output_rows = []
    for row in input_rows:
        output_rows.append([row[0], get_ors_response('isochrones', row[1], {
            'locations': [[row[2], row[3]]],
            'range': [row[4] * 60],
            'location_type': 'start',
            'range_type': 'time',
            'smoothing': 10
        }, format, host)])
    return output_rows


@app.post("/isochrones_tabular")
@app.post("/isochrones_tabular/<format>")
def post_isochrones_tabular(format="geojson"):
    """
    row = [id, method, lon, lat, range, region]
    region is the LAST column and can be NULL.
    """
    message = request.json
    logger.debug(f'Received request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}
    output_rows = []
    for row in input_rows:
        region = _extract_region(row, 5)
        ors_host = resolve_ors_host(region)
        output_rows.append([row[0], get_ors_response('isochrones', row[1], {
            'locations': [[row[2], row[3]]],
            'range': [row[4] * 60],
            'location_type': 'start',
            'range_type': 'time',
            'smoothing': 10
        }, format, ors_host)])
    logger.info(f'Produced {len(output_rows)} rows')
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


def _retry_matrix_chunked(profile, locations, sources_idx, destinations_idx, format, ors_host, chunk_size=50):
    all_durations = None
    all_distances = None

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
            if chunk_size > 10:
                partial = _retry_matrix_chunked(profile, locations, sources_idx, chunk_dests, format, ors_host, 10)
                if partial and 'error' not in partial:
                    if all_durations is None:
                        all_durations = [[] for _ in partial.get('durations', [])]
                        all_distances = [[] for _ in partial.get('distances', [])]
                    for r_idx, dur_row in enumerate(partial.get('durations', [])):
                        all_durations[r_idx].extend(dur_row)
                    for r_idx, dist_row in enumerate(partial.get('distances', [])):
                        all_distances[r_idx].extend(dist_row)
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

    return {
        'durations': all_durations,
        'distances': all_distances,
        'sources': sources_idx,
        'destinations': destinations_idx
    }


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


def get_ors_response(function, profile, payload, format, ors_host=None):
    host = ors_host or resolve_ors_host(None)
    endpoint = "/".join(filter(None, [ORS_API_PATH, function, profile, format]))
    if not endpoint.startswith('/'):
        endpoint = '/' + endpoint

    downstream_url = f'http://{host}:{ORS_PORT}{endpoint}'
    downstream_headers = {"Content-Type": "application/json"}
    # Isochrones on large graphs (e.g. USA driving-hgv) can take > 120 s because
    # fastisochrones preparation is not enabled. Use a longer per-endpoint
    # timeout for isochrones to avoid silent gateway-side cliffs.
    timeout_s = ORS_TIMEOUT_ISOCHRONES if function == 'isochrones' else ORS_TIMEOUT_DEFAULT
    logger.info(f'Calling: {downstream_url} (timeout={timeout_s}s)')
    logger.info(f'Payload: {payload}')

    try:
        r = requests.post(url=downstream_url, headers=downstream_headers, json=payload, timeout=timeout_s)
        resp = r.json()
        logger.debug(resp)
        return _annotate_engine_error(resp, host, payload)
    except requests.exceptions.ConnectionError:
        region_hint = f' (host: {host})' if host != resolve_ors_host(None) else ''
        # Differentiate warming-up vs suspended/unknown by probing /health separately.
        state = _probe_ors_state(host)
        if state == 'warming_up':
            logger.info(f'ORS{region_hint} is warming up - graph still loading')
            return {
                'error': 'service_warming_up',
                'graph_loading': True,
                'message': f'ORS{region_hint} is warming up: graph is loading from stage. '
                           f'Typical wait: 1-10 min depending on region size. '
                           f'Re-poll SELECT CORE.ORS_STATUS(region) until service_ready=true, then retry.',
                'ors_host': host
            }
        logger.error(f'Cannot connect to ORS{region_hint} - suspended or not provisioned')
        return {
            'error': 'service_unreachable',
            'graph_loading': False,
            'message': f'Cannot connect to ORS{region_hint}. Service appears suspended or region not provisioned. '
                       f'Try: 1) CALL CORE.RESUME_ALL_SERVICES() to resume, '
                       f'2) SELECT CORE.ORS_STATUS(region) to check readiness, '
                       f'3) CALL CORE.SETUP_CITY_ORS(region) to provision a new region.',
            'ors_host': host
        }
    except requests.exceptions.Timeout:
        logger.error(f'ORS request timed out on {host} after {timeout_s}s')
        return {
            'error': 'timeout',
            'message': f'ORS request timed out on {host} after {timeout_s}s. '
                       f'Possible causes: graphs still loading after resume (~2-3 min), '
                       f'or request too large (e.g. very large isochrone range on a continental graph). '
                       f'Try reducing range/batch size, or check ORS_STATUS().',
            'ors_host': host,
            'timeout_seconds': timeout_s
        }


if __name__ == '__main__':
    app.run(host=SERVICE_HOST, port=SERVICE_PORT)
