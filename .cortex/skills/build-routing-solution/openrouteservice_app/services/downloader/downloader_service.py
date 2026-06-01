from flask import Flask
from flask import request
from flask import make_response
import requests
import logging
import os
import sys
import threading

SERVICE_HOST = os.getenv('SERVER_HOST', '0.0.0.0')
SERVICE_PORT = os.getenv('SERVER_PORT', 8081)
CHUNK_SIZE = 8_192_000

BASE_FOLDER = '/downloads'

# Status registry: target_path -> {"status": str, "error": str|None}
_download_jobs = {}
_download_lock = threading.Lock()


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


def _target_path(folder, filename):
    return '/'.join([BASE_FOLDER, folder, filename])


def _set_job_status(target_path, status, error=None):
    with _download_lock:
        _download_jobs[target_path] = {'status': status, 'error': error}


def _get_job_status(target_path):
    with _download_lock:
        return _download_jobs.get(target_path)


def _resolve_status(folder, filename):
    target_path = _target_path(folder, filename)
    part_path = target_path + '.part'

    job = _get_job_status(target_path)
    if job is not None:
        if job['status'] == 'error':
            return job['error'] or 'error'
        return job['status']

    if os.path.exists(part_path):
        return 'error: partial download detected (incomplete .part file on disk)'

    if os.path.isfile(target_path) and os.path.getsize(target_path) > 0:
        return 'success'

    return 'not_started'


def _download_file_streaming(url, file_path):
    part_path = file_path + '.part'
    os.makedirs(os.path.dirname(file_path), exist_ok=True)

    if os.path.exists(part_path):
        os.remove(part_path)

    response = requests.get(url, stream=True, timeout=(30, 300))
    if response.status_code != 200:
        raise RuntimeError(f'HTTP {response.status_code} from {url}')

    downloaded = 0
    with open(part_path, 'wb') as out_file:
        for chunk in response.iter_content(chunk_size=CHUNK_SIZE):
            if chunk:
                out_file.write(chunk)
                downloaded += len(chunk)

    if os.path.exists(file_path):
        os.remove(file_path)
    os.rename(part_path, file_path)
    logger.info('Download successful to %s (%s bytes)', file_path, downloaded)
    return downloaded


def _run_download(url, file_path):
    _set_job_status(file_path, 'in_progress')
    try:
        _download_file_streaming(url, file_path)
        _set_job_status(file_path, 'success')
    except Exception as exc:
        part_path = file_path + '.part'
        if os.path.exists(part_path):
            try:
                os.remove(part_path)
            except OSError:
                pass
        message = f'error: {exc}'
        _set_job_status(file_path, 'error', message)
        logger.exception('Download failed for %s', file_path)


def _start_download(url, file_path):
    job = _get_job_status(file_path)
    if job is not None and job['status'] in ('started', 'in_progress'):
        return job['status']

    if os.path.isfile(file_path) and os.path.getsize(file_path) > 0:
        _set_job_status(file_path, 'success')
        return 'success'

    _set_job_status(file_path, 'started')
    thread = threading.Thread(
        target=_run_download,
        args=(url, file_path),
        daemon=True,
    )
    thread.start()
    return 'started'


@app.get("/health")
def readiness_probe():
    return "OK"


@app.post("/download_to_stage")
def post_download_to_stage():
    '''
    Non-blocking download handler.

    row[1] - target folder
    row[2] - filename with path
    row[3] - URL
    '''
    message = request.json
    logger.debug('Received request: %s', message)
    if message is None or not message.get('data'):
        logger.info('Received empty message')
        return {}

    input_rows = message['data']
    output_rows = []
    for row in input_rows:
        file_path = _target_path(row[1], row[2])
        status = _start_download(row[3], file_path)
        output_rows.append([row[0], status])

    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    logger.debug('Sending response: %s', response.get_json())
    return response


@app.post("/download_status")
def post_download_status():
    '''
    Poll download status for a staged file.

    row[1] - target folder
    row[2] - filename with path
    '''
    message = request.json
    logger.debug('Received status request: %s', message)
    if message is None or not message.get('data'):
        logger.info('Received empty status message')
        return {}

    input_rows = message['data']
    output_rows = []
    for row in input_rows:
        status = _resolve_status(row[1], row[2])
        output_rows.append([row[0], status])

    response = make_response({"data": output_rows})
    response.headers['Content-type'] = 'application/json'
    logger.debug('Sending status response: %s', response.get_json())
    return response


if __name__ == '__main__':
    app.run(host=SERVICE_HOST, port=SERVICE_PORT)
