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

@app.get("/health")
def readiness_probe():
    return "OK"

@app.post("/optimization_tabular")
def post_optimization_tabular():
    '''
    Tabular Optimization Handler

    Easy Optimization problem solver

    row[1] - jobs array
    row[2] - vehicles array
    row[3] - matrices array (optional) - pre-computed cost matrices per profile
             Format: {"profile_name": {"durations": [[...]], "distances": [[...]]}}
             When provided, jobs/vehicles should use location_index instead of location
    '''
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
def post_optimization():
    '''
    Optimization Handler

    Takes raw Optimization problem, according to the https://openrouteservice.org/dev/#/api-docs/optimization

    row[1] - problem varchar
    '''
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
def post_directions_tabular_with_format(format="geojson"):
    '''
    Directions Handler with format option
    '''
    message = request.json
    logger.debug(f'Received request: {message}')
    if message is None or not message['data']:
        logger.info('Received empty message')
        return {}

    input_rows = message['data']
    output_rows = [[row[0], get_ors_response('directions', row[1], {'coordinates': [row[2], row[3]]}, format)] for row in input_rows]

    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    logger.debug(f'Sending response: {response.json}')

    return response

@app.post("/directions")
@app.post("/directions/<format>")
def post_directions_with_format(format="geojson"):
    '''
    Directions Handler with format option
    '''
    message = request.json
    logger.debug(f'Received request: {message}')
    if message is None or not message['data']:
        logger.info('Received empty message')
        return {}
    
    input_rows = message['data']
    output_rows = [[row[0], get_ors_response('directions', row[1], row[2], format)] for row in input_rows]

    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    logger.debug(f'Sending response: {response.json}')

    return response

@app.post("/isochrones_tabular")
@app.post("/isochrones_tabular/<format>")
def post_isochrones_tabular(format="geojson"):
    '''
    Isochrones Tabular Handler

    ISOCHRONES(method string, lon float, lat float, range int)

    row[1] - method string, 
    row[2] - lon float 
    row[3] - lat float
    row[4] - range int
    '''
    message = request.json
    logger.debug(f'Received request: {message}')
    if message is None or not message['data']:
        logger.info('Received empty message')
        return {}

    input_rows = message['data']

    output_rows = [[row[0], get_ors_response('isochrones', row[1], {'locations': [[row[2], row[3]]], 'range':[row[4]*60],
                    'location_type':'start',
                    'range_type':'time',
                    'smoothing':10}, format)]for row in input_rows]
        
    logger.info(f'Produced {len(output_rows)} rows')

    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    logger.debug(f'Sending response: {response.json}')

    return response


@app.post("/isochrones")
@app.post("/isochrones/<format>")
def post_isochrones(format="geojson"):
    '''
    Isochrones Tabular Handler

    ISOCHRONES(method string, lon float, lat float, range int)

    row[1] - problem varchar
    '''
    message = request.json
    logger.debug(f'Received request: {message}')
    if message is None or not message['data']:
        logger.info('Received empty message')
        return {}

    input_rows = message['data']

    output_rows = [[row[0], get_ors_response('isochrones', row[1], json.loads(row[2]), format)]for row in input_rows]
        
    logger.info(f'Produced {len(output_rows)} rows')

    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    logger.debug(f'Sending response: {response.json}')

    return response

@app.post("/matrix")
def post_matrix():
    '''
    Matrix Handler - calculates travel time/distance matrix between multiple locations

    MATRIX(method varchar, locations array, metrics array)

    row[1] - method (profile) e.g. 'driving-car'
    row[2] - locations array of [lon, lat] pairs
    row[3] - metrics array e.g. ['duration', 'distance']
    '''
    message = request.json
    logger.debug(f'Received request: {message}')
    if message is None or not message['data']:
        logger.info('Received empty message')
        return {}

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
        
        result = get_ors_matrix_response(profile, payload)
        output_rows.append([row[0], result])
        
    logger.info(f'Produced {len(output_rows)} rows')

    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    logger.debug(f'Sending response: {response.json}')

    return response

@app.post("/matrix_tabular")
def post_matrix_tabular():
    '''
    Matrix Tabular Handler - calculates travel time/distance between origin and destinations

    MATRIX_TABULAR(method varchar, origin array, destinations array)

    row[1] - method (profile) e.g. 'driving-car'
    row[2] - origin [lon, lat]
    row[3] - destinations array of [lon, lat] pairs
    '''
    message = request.json
    logger.debug(f'Received request: {message}')
    if message is None or not message['data']:
        logger.info('Received empty message')
        return {}

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
        
        result = get_ors_matrix_response(profile, payload)
        output_rows.append([row[0], result])
        
    logger.info(f'Produced {len(output_rows)} rows')

    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    logger.debug(f'Sending response: {response.json}')

    return response

def get_ors_matrix_response(profile, payload):
    '''
    ORS Matrix Endpoint abstraction
    '''
    endpoint = f'{ORS_API_PATH}/matrix/{profile}'
    if not endpoint.startswith('/'):
        endpoint = '/' + endpoint

    downstream_url = f'http://{ORS_HOST}:{ORS_PORT}{endpoint}'
    downstream_headers = {"Content-Type": "application/json"}
    logger.info(f'Calling: {downstream_url}')
    logger.info(f'Payload: {payload}')
    
    r = requests.post(url=downstream_url, headers=downstream_headers, json=payload)
    logger.debug(r.json())
    return r.json()

def get_vroom_response(payload):
    '''
    Vroom Service Endpoint Abstraction
    '''
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

def get_ors_response(function, profile, payload, format):
    '''
    ORS Endpoint abstraction
    '''
    endpoint = "/".join(filter(None, [ORS_API_PATH, function, profile, format]))
    if not endpoint.startswith('/'):
        endpoint = '/' + endpoint

    downstream_url = f'http://{ORS_HOST}:{ORS_PORT}{endpoint}'
    downstream_headers ={"Content-Type":"application/json"}
    logger.info(f'Calling: {downstream_url}')
    logger.info(f'Payload: {payload}')
    
    r = requests.post(url = downstream_url, headers=downstream_headers, json = payload)
    logger.debug(r.json())
    return r.json()

if __name__ == '__main__':
    app.run(host=SERVICE_HOST, port=SERVICE_PORT)