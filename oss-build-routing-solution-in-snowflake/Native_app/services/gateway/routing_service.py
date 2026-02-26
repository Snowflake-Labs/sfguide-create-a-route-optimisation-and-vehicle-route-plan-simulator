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

@app.get("/ors_status")
def get_ors_status():
    '''
    Get ORS Status including graph bounds
    Returns service status with bounding box information for available profiles
    '''
    try:
        # Query ORS status endpoint
        status_url = f'http://{ORS_HOST}:{ORS_PORT}{ORS_API_PATH}/status'
        logger.info(f'Querying ORS status: {status_url}')
        r = requests.get(url=status_url, timeout=10)
        status_data = r.json()
        
        # Try to get bounds by making a test isochrone request at the center
        # This helps determine if the service is ready and where the graph covers
        bounds_info = {}
        
        if 'profiles' in status_data:
            for profile_name, profile_data in status_data['profiles'].items():
                bounds_info[profile_name] = {
                    'ready': True,
                    'encoder_name': profile_data.get('encoder_name', profile_name),
                    'graph_build_date': profile_data.get('graph_build_date'),
                    'osm_date': profile_data.get('osm_date')
                }
        
        status_data['bounds_info'] = bounds_info
        status_data['service_ready'] = len(bounds_info) > 0
        
        return status_data
    except requests.exceptions.Timeout:
        logger.error('ORS status request timed out - graphs may still be building')
        return {'error': 'timeout', 'message': 'ORS service not ready - graphs may still be building', 'service_ready': False}
    except Exception as e:
        logger.error(f'Error getting ORS status: {str(e)}')
        return {'error': str(e), 'service_ready': False}

@app.post("/ors_status")
def post_ors_status():
    '''
    ORS Status Handler for Snowflake External Function
    Returns service status with graph information
    '''
    message = request.json
    logger.debug(f'Received status request: {message}')
    
    if message is None or not message.get('data'):
        return {"data": [[0, get_ors_status()]]}
    
    input_rows = message['data']
    status = get_ors_status()
    output_rows = [[row[0], status] for row in input_rows]
    
    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    return response

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

@app.post("/matrix_tabular")
@app.post("/matrix_tabular/<format>")
def post_matrix_tabular(format="json"):
    '''
    Matrix Tabular Handler

    MATRIX(method string, locations array)

    row[1] - method/profile string (e.g., 'driving-car')
    row[2] - locations array of [lon, lat] pairs
    
    Returns duration and distance matrix between all locations
    '''
    message = request.json
    logger.debug(f'Received request: {message}')
    if message is None or not message['data']:
        logger.info('Received empty message')
        return {}

    input_rows = message['data']

    output_rows = [[row[0], get_ors_response('matrix', row[1], {
        'locations': row[2],
        'metrics': ['distance', 'duration'],
        'resolve_locations': True
    }, format)] for row in input_rows]
        
    logger.info(f'Produced {len(output_rows)} rows')

    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    logger.debug(f'Sending response: {response.json}')

    return response

@app.post("/matrix")
@app.post("/matrix/<format>")
def post_matrix(format="json"):
    '''
    Matrix Handler

    MATRIX(method string, options variant)

    row[1] - method/profile string (e.g., 'driving-car')
    row[2] - full matrix options as JSON/variant (locations, metrics, sources, destinations, etc.)
    
    See: https://openrouteservice.org/dev/#/api-docs/v2/matrix/{profile}/post
    '''
    message = request.json
    logger.debug(f'Received request: {message}')
    if message is None or not message['data']:
        logger.info('Received empty message')
        return {}

    input_rows = message['data']

    output_rows = [[row[0], get_ors_response('matrix', row[1], row[2], format)] for row in input_rows]
        
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