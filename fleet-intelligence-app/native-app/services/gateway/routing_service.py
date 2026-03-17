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
    logger.info(f'Payload: {payload}')
    
    r = requests.post(url=downstream_url, headers=downstream_headers, json=payload)
    logger.debug(r.json())
    return r.json()

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
