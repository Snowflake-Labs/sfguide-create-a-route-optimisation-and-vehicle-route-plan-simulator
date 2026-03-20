from flask import Flask
from flask import request
from flask import make_response
from polyline import decode
import requests
import logging
import json
import os
import sys

SERVICE_HOST = os.getenv('SERVER_HOST', '0.0.0.0')
SERVICE_PORT = os.getenv('SERVER_PORT', 8080)
VROOM_HOST = os.getenv('VROOM_HOST', 'vroom-service')
VROOM_PORT = os.getenv('VROOM_PORT', 3000)
ORS_HOST = os.getenv('ORS_HOST', 'ors-service')
ORS_PORT = os.getenv('ORS_PORT', 8082)
ORS_API_PATH = os.getenv('ORS_API_PATH', '/ors/v2')
ORS_SCHEMA = os.getenv('ORS_SCHEMA', 'routing')

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
    return f'ors-service-{region.lower()}'

@app.get("/health")
def readiness_probe():
    return "OK"

@app.post("/optimization_tabular")
@app.post("/city/<region>/optimization_tabular")
def post_optimization_tabular(region=None):
    message = request.json
    logger.debug(f'Received request: {message}')
    if message is None or not message['data']:
        logger.info('Received empty message')
        return {}

    input_rows = message['data']

    def build_vroom_payload(row):
        payload = {'jobs': row[1], 'vehicles': row[2]}
        if len(row) > 3 and row[3]:
            matrices = row[3]
            if isinstance(matrices, dict) and len(matrices) > 0:
                payload['matrices'] = matrices
                payload['options'] = {'g': False}
            elif isinstance(matrices, list) and len(matrices) > 0:
                payload['matrices'] = matrices[0] if len(matrices) == 1 and isinstance(matrices[0], dict) else matrices
                payload['options'] = {'g': False}
        return payload

    output_rows = [[row[0], get_vroom_response(build_vroom_payload(row))] for row in input_rows]
        
    logger.info(f'Produced {len(output_rows)} rows')

    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    logger.debug(f'Sending response: {response.json}')

    return response

@app.post("/optimization")
@app.post("/city/<region>/optimization")
def post_optimization(region=None):
    message = request.json
    logger.debug(f'Received request: {message}')
    if message is None or not message['data']:
        logger.info('Received empty message')
        return {}

    input_rows = message['data']

    output_rows = [[row[0], get_vroom_response(row[1])] for row in input_rows]
    logger.info(f'Produced {len(output_rows)} rows')

    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    logger.debug(f'Sending response: {response.json}')

    return response

@app.post("/directions_tabular")
@app.post("/directions_tabular/<format>")
@app.post("/city/<region>/directions_tabular")
@app.post("/city/<region>/directions_tabular/<format>")
def post_directions_tabular_with_format(format="geojson", region=None):
    message = request.json
    logger.debug(f'Received request: {message}')
    if message is None or not message['data']:
        logger.info('Received empty message')
        return {}

    ors_host = resolve_ors_host(region)
    input_rows = message['data']
    output_rows = [[row[0], get_ors_response('directions', row[1], {'coordinates': [row[2], row[3]]}, format, ors_host)] for row in input_rows]

    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    logger.debug(f'Sending response: {response.json}')

    return response

@app.post("/directions")
@app.post("/directions/<format>")
@app.post("/city/<region>/directions")
@app.post("/city/<region>/directions/<format>")
def post_directions_with_format(format="geojson", region=None):
    message = request.json
    logger.debug(f'Received request: {message}')
    if message is None or not message['data']:
        logger.info('Received empty message')
        return {}
    
    ors_host = resolve_ors_host(region)
    input_rows = message['data']
    output_rows = [[row[0], get_ors_response('directions', row[1], row[2], format, ors_host)] for row in input_rows]

    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    logger.debug(f'Sending response: {response.json}')

    return response

@app.post("/isochrones_tabular")
@app.post("/isochrones_tabular/<format>")
@app.post("/city/<region>/isochrones_tabular")
@app.post("/city/<region>/isochrones_tabular/<format>")
def post_isochrones_tabular(format="geojson", region=None):
    message = request.json
    logger.debug(f'Received request: {message}')
    if message is None or not message['data']:
        logger.info('Received empty message')
        return {}

    ors_host = resolve_ors_host(region)
    input_rows = message['data']

    output_rows = [[row[0], get_ors_response('isochrones', row[1], {'locations': [[row[2], row[3]]], 'range':[row[4]*60],
                    'location_type':'start',
                    'range_type':'time',
                    'smoothing':10}, format, ors_host)]for row in input_rows]
        
    logger.info(f'Produced {len(output_rows)} rows')

    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    logger.debug(f'Sending response: {response.json}')

    return response


@app.post("/isochrones")
@app.post("/isochrones/<format>")
@app.post("/city/<region>/isochrones")
@app.post("/city/<region>/isochrones/<format>")
def post_isochrones(format="geojson", region=None):
    message = request.json
    logger.debug(f'Received request: {message}')
    if message is None or not message['data']:
        logger.info('Received empty message')
        return {}

    ors_host = resolve_ors_host(region)
    input_rows = message['data']

    output_rows = [[row[0], get_ors_response('isochrones', row[1], json.loads(row[2]), format, ors_host)]for row in input_rows]
        
    logger.info(f'Produced {len(output_rows)} rows')

    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    logger.debug(f'Sending response: {response.json}')

    return response

@app.post("/matrix")
@app.post("/city/<region>/matrix")
def post_matrix(region=None):
    message = request.json
    logger.debug(f'Received request: {message}')
    if message is None or not message['data']:
        logger.info('Received empty message')
        return {}

    ors_host = resolve_ors_host(region)
    input_rows = message['data']
    output_rows = []
    
    for row in input_rows:
        profile = row[1]
        locations = row[2]
        metrics = row[3] if len(row) > 3 and row[3] else ['duration', 'distance']
        
        payload = {
            'locations': locations,
            'metrics': metrics
        }
        
        result = get_ors_matrix_response(profile, payload, ors_host)
        output_rows.append([row[0], result])
        
    logger.info(f'Produced {len(output_rows)} rows')

    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    logger.debug(f'Sending response: {response.json}')

    return response

@app.post("/matrix_tabular")
@app.post("/city/<region>/matrix_tabular")
def post_matrix_tabular(region=None):
    message = request.json
    logger.debug(f'Received request: {message}')
    if message is None or not message['data']:
        logger.info('Received empty message')
        return {}

    ors_host = resolve_ors_host(region)
    input_rows = message['data']
    output_rows = []
    
    for row in input_rows:
        profile = row[1]
        origin = row[2]
        destinations = row[3]
        
        locations = [origin] + destinations
        sources = [0]
        destinations_idx = list(range(1, len(locations)))
        
        payload = {
            'locations': locations,
            'sources': sources,
            'destinations': destinations_idx,
            'metrics': ['duration', 'distance']
        }
        
        result = get_ors_matrix_response(profile, payload, ors_host)
        output_rows.append([row[0], result])
        
    logger.info(f'Produced {len(output_rows)} rows')

    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    logger.debug(f'Sending response: {response.json}')

    return response

def get_ors_matrix_response(profile, payload, ors_host=None):
    if not ors_host:
        ors_host = ORS_HOST
    endpoint = f'{ORS_API_PATH}/matrix/{profile}'
    if not endpoint.startswith('/'):
        endpoint = '/' + endpoint

    downstream_url = f'http://{ors_host}:{ORS_PORT}{endpoint}'
    downstream_headers = {"Content-Type": "application/json"}
    logger.info(f'Calling: {downstream_url}')
    logger.debug(f'Payload locations count: {len(payload.get("locations", []))}')

    r = requests.post(url=downstream_url, headers=downstream_headers, json=payload, timeout=30)
    result = r.json()

    if 'error' in result and result['error'].get('code') == 6099:
        logger.warning(f'ORS 6099: unreachable nodes — retrying with chunked destinations')
        result = _retry_matrix_chunked(profile, payload, downstream_url, downstream_headers)

    return result


def _retry_matrix_chunked(profile, payload, url, headers):
    locations = payload['locations']
    origin = locations[0]
    dest_locations = locations[1:]
    dest_indices_orig = payload.get('destinations', list(range(1, len(locations))))

    CHUNK_SIZE = 50
    merged_durations = [None] * len(dest_locations)
    merged_distances = [None] * len(dest_locations)
    metadata = None
    sources_info = None
    dest_info = [None] * len(dest_locations)
    success_count = 0

    for chunk_start in range(0, len(dest_locations), CHUNK_SIZE):
        chunk_end = min(chunk_start + CHUNK_SIZE, len(dest_locations))
        chunk_dests = dest_locations[chunk_start:chunk_end]
        chunk_locs = [origin] + chunk_dests
        chunk_payload = {
            'locations': chunk_locs,
            'sources': [0],
            'destinations': list(range(1, len(chunk_locs))),
            'metrics': ['duration', 'distance']
        }
        try:
            cr = requests.post(url=url, headers=headers, json=chunk_payload, timeout=15)
            chunk_result = cr.json()

            if 'error' in chunk_result and chunk_result['error'].get('code') == 6099:
                logger.warning(f'Chunk [{chunk_start}:{chunk_end}] has unreachable nodes, splitting into sub-chunks')
                SUB_CHUNK = 10
                for sub_start in range(0, len(chunk_dests), SUB_CHUNK):
                    sub_end = min(sub_start + SUB_CHUNK, len(chunk_dests))
                    sub_dests = chunk_dests[sub_start:sub_end]
                    sub_locs = [origin] + sub_dests
                    sub_payload = {
                        'locations': sub_locs,
                        'sources': [0],
                        'destinations': list(range(1, len(sub_locs))),
                        'metrics': ['duration', 'distance']
                    }
                    try:
                        sr = requests.post(url=url, headers=headers, json=sub_payload, timeout=15)
                        sub_result = sr.json()
                        if 'durations' in sub_result:
                            for i in range(len(sub_dests)):
                                idx = chunk_start + sub_start + i
                                merged_durations[idx] = sub_result['durations'][0][i]
                                merged_distances[idx] = sub_result['distances'][0][i]
                                success_count += 1
                                if sub_result.get('destinations') and i < len(sub_result['destinations']):
                                    dest_info[idx] = sub_result['destinations'][i]
                                if not metadata and sub_result.get('metadata'):
                                    metadata = sub_result['metadata']
                                if not sources_info and sub_result.get('sources'):
                                    sources_info = sub_result['sources']
                    except Exception:
                        pass
                continue

            if 'durations' in chunk_result:
                for i in range(len(chunk_dests)):
                    idx = chunk_start + i
                    merged_durations[idx] = chunk_result['durations'][0][i]
                    merged_distances[idx] = chunk_result['distances'][0][i]
                    success_count += 1
                    if chunk_result.get('destinations') and i < len(chunk_result['destinations']):
                        dest_info[idx] = chunk_result['destinations'][i]
                if not metadata and chunk_result.get('metadata'):
                    metadata = chunk_result['metadata']
                if not sources_info and chunk_result.get('sources'):
                    sources_info = chunk_result['sources']

        except Exception as e:
            logger.error(f'Chunk [{chunk_start}:{chunk_end}] failed: {e}')

    if success_count == 0:
        return {'error': {'code': 6099, 'message': 'All destinations unreachable after chunked retry'}}

    logger.info(f'Chunked retry: {success_count}/{len(dest_locations)} destinations resolved')
    return {
        'durations': [merged_durations],
        'distances': [merged_distances],
        'destinations': dest_info,
        'sources': sources_info or [{'location': origin, 'snapped_distance': 0}],
        'metadata': metadata or {}
    }

def get_vroom_response(payload):
    logger.info(payload)
    downstream_url = f'http://{VROOM_HOST}:{VROOM_PORT}'
    downstream_headers ={"Content-Type":"application/json"}
    r = requests.post(url = downstream_url, headers=downstream_headers, json = payload)
    vroom_r = r.json()
    logger.debug(f'VROOM response: {vroom_r}')
    if 'routes' in vroom_r:
        for route in vroom_r['routes']:
            if 'geometry' in route:
                decoded_geometry = decode(route['geometry'])
                route['geometry'] = [[lon, lat] for lat, lon in decoded_geometry]
    return vroom_r

def get_ors_response(function, profile, payload, format, ors_host=None):
    if not ors_host:
        ors_host = ORS_HOST
    endpoint = "/".join(filter(None, [ORS_API_PATH, function, profile, format]))
    if not endpoint.startswith('/'):
        endpoint = '/' + endpoint

    downstream_url = f'http://{ors_host}:{ORS_PORT}{endpoint}'
    downstream_headers ={"Content-Type":"application/json"}
    logger.info(f'Calling: {downstream_url}')
    logger.info(f'Payload: {payload}')
    
    r = requests.post(url = downstream_url, headers=downstream_headers, json = payload)
    logger.debug(r.json())
    return r.json()

@app.post("/ors_status")
@app.post("/city/<region>/ors_status")
def post_ors_status(region=None):
    message = request.json
    if message is None or not message['data']:
        return {}
    ors_host = resolve_ors_host(region)
    input_rows = message['data']
    output_rows = []
    for row in input_rows:
        endpoint = f'{ORS_API_PATH}/health'
        if not endpoint.startswith('/'):
            endpoint = '/' + endpoint
        downstream_url = f'http://{ors_host}:{ORS_PORT}{endpoint}'
        try:
            r = requests.get(url=downstream_url, timeout=10)
            result = r.json()
        except Exception as e:
            result = {'error': str(e)}
        output_rows.append([row[0], result])
    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    return response

if __name__ == '__main__':
    app.run(host=SERVICE_HOST, port=int(SERVICE_PORT), threaded=True)
