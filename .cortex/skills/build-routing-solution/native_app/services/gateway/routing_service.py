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
VROOM_HOST = os.getenv('VROOM_HOST', 'vroom-service')
VROOM_PORT = os.getenv('VROOM_PORT', 3000)
ORS_HOST = os.getenv('ORS_HOST', 'ors-service')
ORS_PORT = os.getenv('ORS_PORT', 8082)
ORS_API_PATH = os.getenv('ORS_API_PATH', '/ors/v2')
MATRIX_CONCURRENCY = int(os.getenv('MATRIX_CONCURRENCY', '6'))
GATEWAY_VERSION = 'v0.9.6'

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


def resolve_ors_host(region=None):
    if not region:
        return ORS_HOST
    normalized = region.strip().lower().replace(' ', '')
    return f'ors-service-{normalized}'


def _make_response(output_rows):
    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    return response


def _parse_rows(message):
    if message is None or not message.get('data'):
        return None
    return message['data']


@app.get("/health")
def readiness_probe():
    return {'status': 'OK', 'version': GATEWAY_VERSION, 'ors_host': ORS_HOST, 'vroom_host': VROOM_HOST}


def _get_ors_health(ors_host=None):
    host = ors_host or ORS_HOST
    try:
        health_url = f'http://{host}:{ORS_PORT}{ORS_API_PATH}/health'
        r = requests.get(url=health_url, timeout=5)
        return r.status_code == 200
    except Exception:
        return False


def _get_ors_status(ors_host=None):
    host = ors_host or ORS_HOST
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
        logger.error(f'Cannot connect to ORS at {host} - service may not be provisioned or is suspended')
        return {
            'error': 'connection_failed',
            'message': f'Cannot connect to ORS at {host}. Region may not be provisioned or service is suspended. '
                       f'Use SETUP_CITY_ORS(region) to provision.',
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
    message = request.json
    logger.debug(f'Received status request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {"data": [[0, _get_ors_status()]]}
    status = _get_ors_status()
    return _make_response([[row[0], status] for row in input_rows])


@app.post("/r/ors_status")
def post_ors_status_region():
    message = request.json
    logger.debug(f'Received region status request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {"data": [[0, _get_ors_status()]]}
    output_rows = []
    for row in input_rows:
        region = row[1]
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
    for item in (jobs or []):
        if isinstance(item, dict) and 'location' in item:
            t = tuple(item['location'])
            if t in indices:
                item['location_index'] = indices[t]
                del item['location']
    for item in (vehicles or []):
        if not isinstance(item, dict):
            continue
        for key, idx_key in [('start', 'start_index'), ('end', 'end_index')]:
            if key in item:
                t = tuple(item[key])
                if t in indices:
                    item[idx_key] = indices[t]
                    del item[key]


def _handle_optimization_tabular(input_rows, ors_host_override=None):
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
        if ors_host_override and ors_host_override != ORS_HOST and 'matrices' not in payload:
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
        resp = get_vroom_response(build_vroom_payload(row))
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
    '''
    row[1] - jobs array
    row[2] - vehicles array
    row[3] - matrices object (optional)
    '''
    message = request.json
    logger.debug(f'Received request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}
    output_rows = _handle_optimization_tabular(input_rows)
    logger.info(f'Produced {len(output_rows)} rows')
    return _make_response(output_rows)


@app.post("/r/optimization_tabular")
def post_optimization_tabular_region():
    '''
    row[1] - region string
    row[2] - jobs array
    row[3] - vehicles array
    row[4] - matrices object (optional)
    '''
    message = request.json
    logger.debug(f'Received region optimization request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}
    region = input_rows[0][1] if input_rows else None
    ors_host = resolve_ors_host(region) if region else ORS_HOST
    shifted_rows = []
    for row in input_rows:
        shifted = [row[0]] + list(row[2:])
        shifted_rows.append(shifted)
    output_rows = _handle_optimization_tabular(shifted_rows, ors_host_override=ors_host)
    logger.info(f'Produced {len(output_rows)} rows')
    return _make_response(output_rows)


@app.post("/optimization")
def post_optimization():
    '''
    row[1] - problem varchar
    '''
    message = request.json
    logger.debug(f'Received request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}
    output_rows = [[row[0], get_vroom_response(row[1])] for row in input_rows]
    logger.info(f'Produced {len(output_rows)} rows')
    return _make_response(output_rows)


def _handle_directions_tabular(input_rows, format, ors_host=None):
    host = ors_host or ORS_HOST
    output_rows = []
    for row in input_rows:
        output_rows.append([row[0], get_ors_response('directions', row[1], {'coordinates': [row[2], row[3]]}, format, host)])
    return output_rows


@app.post("/directions_tabular")
@app.post("/directions_tabular/<format>")
def post_directions_tabular_with_format(format="geojson"):
    message = request.json
    logger.debug(f'Received request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}
    output_rows = _handle_directions_tabular(input_rows, format)
    return _make_response(output_rows)


@app.post("/r/directions_tabular")
@app.post("/r/directions_tabular/<format>")
def post_directions_tabular_region(format="geojson"):
    '''
    row[1] - region, row[2] - method, row[3] - start, row[4] - end
    '''
    message = request.json
    logger.debug(f'Received region directions request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}
    output_rows = []
    for row in input_rows:
        ors_host = resolve_ors_host(row[1])
        shifted = [row[0], row[2], row[3], row[4]]
        output_rows.append([row[0], get_ors_response('directions', row[2], {'coordinates': [row[3], row[4]]}, format, ors_host)])
    return _make_response(output_rows)


def _handle_directions(input_rows, format, ors_host=None):
    host = ors_host or ORS_HOST
    return [[row[0], get_ors_response('directions', row[1], row[2], format, host)] for row in input_rows]


@app.post("/directions")
@app.post("/directions/<format>")
def post_directions_with_format(format="geojson"):
    message = request.json
    logger.debug(f'Received request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}
    output_rows = _handle_directions(input_rows, format)
    return _make_response(output_rows)


@app.post("/r/directions")
@app.post("/r/directions/<format>")
def post_directions_region(format="geojson"):
    '''
    row[1] - region, row[2] - method, row[3] - locations
    '''
    message = request.json
    logger.debug(f'Received region directions request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}
    output_rows = []
    for row in input_rows:
        ors_host = resolve_ors_host(row[1])
        output_rows.append([row[0], get_ors_response('directions', row[2], row[3], format, ors_host)])
    return _make_response(output_rows)


def _handle_isochrones_tabular(input_rows, format, ors_host=None):
    host = ors_host or ORS_HOST
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
    message = request.json
    logger.debug(f'Received request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}
    output_rows = _handle_isochrones_tabular(input_rows, format)
    logger.info(f'Produced {len(output_rows)} rows')
    return _make_response(output_rows)


@app.post("/r/isochrones_tabular")
@app.post("/r/isochrones_tabular/<format>")
def post_isochrones_tabular_region(format="geojson"):
    '''
    row[1] - region, row[2] - method, row[3] - lon, row[4] - lat, row[5] - range
    '''
    message = request.json
    logger.debug(f'Received region isochrones request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}
    output_rows = []
    for row in input_rows:
        ors_host = resolve_ors_host(row[1])
        output_rows.append([row[0], get_ors_response('isochrones', row[2], {
            'locations': [[row[3], row[4]]],
            'range': [row[5] * 60],
            'location_type': 'start',
            'range_type': 'time',
            'smoothing': 10
        }, format, ors_host)])
    logger.info(f'Produced {len(output_rows)} rows')
    return _make_response(output_rows)


@app.post("/isochrones")
@app.post("/isochrones/<format>")
def post_isochrones(format="geojson"):
    message = request.json
    logger.debug(f'Received request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}
    output_rows = [[row[0], get_ors_response('isochrones', row[1], json.loads(row[2]), format)] for row in input_rows]
    logger.info(f'Produced {len(output_rows)} rows')
    return _make_response(output_rows)


@app.post("/r/isochrones")
@app.post("/r/isochrones/<format>")
def post_isochrones_region(format="geojson"):
    '''
    row[1] - region, row[2] - method, row[3] - options json string
    '''
    message = request.json
    logger.debug(f'Received region isochrones request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}
    output_rows = []
    for row in input_rows:
        ors_host = resolve_ors_host(row[1])
        output_rows.append([row[0], get_ors_response('isochrones', row[2], json.loads(row[3]), format, ors_host)])
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
    '''
    2-arg: MATRIX(method, locations)        -> row = [id, method, locations]
    3-arg: MATRIX_TABULAR(method, origin, destinations) -> row = [id, method, origin, destinations]
    '''
    message = request.json
    logger.debug(f'Received request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}

    def _process_row(row):
        has_dest = len(row) == 4
        body = _build_matrix_body(row[1], row[2:], has_dest)
        resp = get_ors_response('matrix', row[1], body, format)
        error_obj = resp.get('error') if isinstance(resp, dict) else None
        if isinstance(error_obj, dict) and error_obj.get('code') == 6099 and has_dest:
            origin = row[2]
            destinations = row[3]
            if origin and not isinstance(origin[0], list):
                origin = [origin]
            locations = origin + destinations
            sources_idx = list(range(len(origin)))
            destinations_idx = list(range(len(origin), len(locations)))
            resp = _retry_matrix_chunked(row[1], locations, sources_idx, destinations_idx, format, ORS_HOST)
        return [row[0], resp]

    with ThreadPoolExecutor(max_workers=MATRIX_CONCURRENCY) as executor:
        output_rows = list(executor.map(_process_row, input_rows))

    logger.info(f'Produced {len(output_rows)} rows')
    return _make_response(output_rows)


@app.post("/r/matrix_tabular")
@app.post("/r/matrix_tabular/<format>")
def post_matrix_tabular_region(format="json"):
    '''
    Region-aware matrix:
    2-arg: MATRIX(region, method, locations)        -> row = [id, region, method, locations]
    3-arg: MATRIX_TABULAR(region, method, origin, destinations) -> row = [id, region, method, origin, destinations]
    '''
    message = request.json
    logger.debug(f'Received region matrix request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}

    def _process_row(row):
        region = row[1]
        ors_host = resolve_ors_host(region)
        method = row[2]
        has_dest = len(row) == 5
        body = _build_matrix_body(method, row[3:], has_dest)
        resp = get_ors_response('matrix', method, body, format, ors_host)
        error_obj = resp.get('error') if isinstance(resp, dict) else None
        if isinstance(error_obj, dict) and error_obj.get('code') == 6099 and has_dest:
            origin = row[3]
            destinations = row[4]
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
    '''
    row[1] - method/profile string
    row[2] - full matrix options as JSON/variant
    '''
    message = request.json
    logger.debug(f'Received request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}

    output_rows = []
    for row in input_rows:
        body = row[2]
        if isinstance(body, list):
            body = {
                'locations': body,
                'metrics': ['distance', 'duration'],
                'resolve_locations': True
            }
        output_rows.append([row[0], get_ors_response('matrix', row[1], body, format)])

    logger.info(f'Produced {len(output_rows)} rows')
    return _make_response(output_rows)


@app.post("/r/matrix")
@app.post("/r/matrix/<format>")
def post_matrix_region(format="json"):
    '''
    row[1] - region, row[2] - method, row[3] - full matrix options
    '''
    message = request.json
    logger.debug(f'Received region matrix request: {message}')
    input_rows = _parse_rows(message)
    if not input_rows:
        return {}

    output_rows = []
    for row in input_rows:
        ors_host = resolve_ors_host(row[1])
        body = row[3]
        if isinstance(body, list):
            body = {
                'locations': body,
                'metrics': ['distance', 'duration'],
                'resolve_locations': True
            }
        output_rows.append([row[0], get_ors_response('matrix', row[2], body, format, ors_host)])

    logger.info(f'Produced {len(output_rows)} rows')
    return _make_response(output_rows)


def get_vroom_response(payload):
    logger.info(payload)
    downstream_url = f'http://{VROOM_HOST}:{VROOM_PORT}'
    downstream_headers = {"Content-Type": "application/json"}
    try:
        r = requests.post(url=downstream_url, headers=downstream_headers, json=payload, timeout=300)
        vroom_r = r.json()
    except requests.exceptions.ConnectionError:
        logger.error(f'Cannot connect to VROOM at {VROOM_HOST}:{VROOM_PORT}')
        return {'error': 'connection_failed', 'message': f'Cannot connect to VROOM service at {VROOM_HOST}:{VROOM_PORT}'}
    except requests.exceptions.Timeout:
        logger.error(f'VROOM request timed out')
        return {'error': 'timeout', 'message': 'VROOM optimization request timed out'}
    logger.debug(f'VROOM response: {vroom_r}')
    if 'routes' in vroom_r:
        for route in vroom_r['routes']:
            if 'geometry' in route:
                decoded_geometry = decode(route['geometry'])
                route['geometry'] = [[lon, lat] for lat, lon in decoded_geometry]
    return vroom_r


def get_ors_response(function, profile, payload, format, ors_host=None):
    host = ors_host or ORS_HOST
    endpoint = "/".join(filter(None, [ORS_API_PATH, function, profile, format]))
    if not endpoint.startswith('/'):
        endpoint = '/' + endpoint

    downstream_url = f'http://{host}:{ORS_PORT}{endpoint}'
    downstream_headers = {"Content-Type": "application/json"}
    logger.info(f'Calling: {downstream_url}')
    logger.info(f'Payload: {payload}')

    try:
        r = requests.post(url=downstream_url, headers=downstream_headers, json=payload, timeout=120)
        logger.debug(r.json())
        return r.json()
    except requests.exceptions.ConnectionError:
        region_hint = f' (host: {host})' if host != ORS_HOST else ''
        logger.error(f'Cannot connect to ORS{region_hint}')
        return {
            'error': 'connection_failed',
            'message': f'Cannot connect to ORS{region_hint}. '
                       f'Region may not be provisioned or service is suspended. '
                       f'Try: 1) CALL CORE.RESUME_ALL_SERVICES() to resume, '
                       f'2) SELECT CORE.ORS_STATUS(region) to check readiness, '
                       f'3) CALL CORE.SETUP_CITY_ORS(region) to provision a new region.',
            'ors_host': host
        }
    except requests.exceptions.Timeout:
        logger.error(f'ORS request timed out on {host}')
        return {
            'error': 'timeout',
            'message': f'ORS request timed out on {host}. '
                       f'Possible causes: graphs still loading after resume (~2-3 min), '
                       f'or request too large. Try reducing batch size or check ORS_STATUS().',
            'ors_host': host
        }


if __name__ == '__main__':
    app.run(host=SERVICE_HOST, port=SERVICE_PORT)
