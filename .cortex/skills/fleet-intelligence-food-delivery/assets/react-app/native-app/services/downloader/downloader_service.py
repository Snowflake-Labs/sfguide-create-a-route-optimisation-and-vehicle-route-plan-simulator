from flask import Flask, request, make_response
import requests
import logging
import os
import sys

SERVICE_HOST = os.getenv('SERVER_HOST', '0.0.0.0')
SERVICE_PORT = os.getenv('SERVER_PORT', 8081)

BASE_FOLDER = '/downloads'

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

logger = get_logger('downloader-service')

app = Flask(__name__)

@app.get("/health")
def readiness_probe():
    return "OK"

@app.post("/download_to_stage")
def post_download_to_stage():
    message = request.json
    logger.debug(f'Received request: {message}')
    if message is None or not message['data']:
        logger.info('Received empty message')
        return {}

    input_rows = message['data']
    output_rows = [[row[0], download_file(row[3], '/'.join([BASE_FOLDER, row[1], row[2]]))] for row in input_rows]

    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    logger.debug(f'Sending response: {response.json}')
    return response

def download_file(url, file_path):
    try:
        logger.info(f'Downloading {url} to {file_path}...')
        response = requests.get(url, stream=True, timeout=1800)
        if response.status_code == 200:
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            total = 0
            with open(file_path, 'wb') as file:
                for chunk in response.iter_content(chunk_size=8192):
                    file.write(chunk)
                    total += len(chunk)
            size_mb = total / (1024 * 1024)
            logger.info(f'Download successful: {file_path} ({size_mb:.1f} MB)')
            return 'success'
        else:
            logger.error(f'Download failed with status {response.status_code}')
            return f'HTTP {response.status_code}'
    except Exception as e:
        logger.error(f'Download error: {e}')
        return f"An error occurred: {e}"

if __name__ == '__main__':
    app.run(host=SERVICE_HOST, port=SERVICE_PORT)
