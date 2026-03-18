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

    row[1] - j  obs array
    row[2] - vehicles array
    '''
    message = request.json
    logger.debug(f'Received request: {message}')
    if message is None or not message['data']:
        logger.info('Received empty message')
        return {}

    input_rows = message['data']

    output_rows = [[row[0], get_vroom_response({'jobs': row[1], 'vehicles': row[2]})]for row in input_rows]
        
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

def get_vroom_response(payload):
    '''
    Vroom Service Endpoint Abstraction
    '''
    logger.info(payload)
    downstream_url = f'http://{VROOM_HOST}:{VROOM_PORT}'
    downstream_headers ={"Content-Type":"application/json"}
    r = requests.post(url = downstream_url, headers=downstream_headers, json = payload)
    vroom_r = r.json()
    # Process the result to include GeoJSON geometry. Reverse the coordinates
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