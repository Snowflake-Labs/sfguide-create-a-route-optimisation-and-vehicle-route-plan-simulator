from flask import Flask
from flask import request
from flask import make_response
import requests
import logging
import os
import sys
import json
import time
import threading
from concurrent.futures import ThreadPoolExecutor

SERVICE_HOST = os.getenv('SERVER_HOST', '0.0.0.0')
SERVICE_PORT = os.getenv('SERVER_PORT', 8081)
CHUNK_SIZE = 8_192_000

# Number of parallel byte-range connections used for large (range-capable)
# downloads. Geofabrik throttles per-connection (~1 MB/s observed), so several
# parallel segments multiply effective throughput and keep multi-GB continental
# PBFs (e.g. europe-latest ~34 GB) under the SQL provisioning poll ceiling.
CONCURRENCY = max(1, min(int(os.getenv('DOWNLOAD_CONCURRENCY', '6')), 8))
# Per-segment retry budget. A transient connection reset (e.g. IncompleteRead)
# resumes the SAME segment from its current offset rather than restarting the
# whole file, so status stays 'in_progress' and the SQL poll loop keeps waiting.
MAX_RETRIES = max(1, int(os.getenv('DOWNLOAD_MAX_RETRIES', '6')))
# Flush the on-disk resume sidecar at most this often (per segment) to bound I/O.
SEGMENT_FLUSH_BYTES = 16 * 1024 * 1024

BASE_FOLDER = '/downloads'

# Status registry: target_path -> {"status": str, "error": str|None,
#                                  "progress": {"done": int, "total": int}}
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


def _part_path(file_path):
    return file_path + '.part'


def _sidecar_path(file_path):
    return file_path + '.part.progress'


def _set_job_status(target_path, status, error=None):
    with _download_lock:
        job = _download_jobs.get(target_path) or {}
        job['status'] = status
        job['error'] = error
        _download_jobs[target_path] = job


def _set_progress(target_path, done, total):
    with _download_lock:
        job = _download_jobs.get(target_path)
        if job is None:
            job = {'status': 'in_progress', 'error': None}
        job['progress'] = {'done': done, 'total': total}
        _download_jobs[target_path] = job


def _get_job_status(target_path):
    with _download_lock:
        return _download_jobs.get(target_path)


def _resolve_status(folder, filename):
    target_path = _target_path(folder, filename)
    part_path = _part_path(target_path)
    sidecar = _sidecar_path(target_path)

    job = _get_job_status(target_path)
    if job is not None:
        if job['status'] == 'error':
            return job['error'] or 'error'
        # NOTE: the SQL provisioning poll loop matches the status string
        # EXACTLY against ('started', 'in_progress', 'not_started', 'success').
        # We therefore return the bare 'in_progress' token (no percent suffix)
        # to stay backward-compatible; human-readable progress is emitted to the
        # container logs instead (see _flush in _download_ranged).
        return job['status']

    # No in-memory job. This happens after a container restart: the in-memory
    # registry is gone but the staged .part + sidecar persist on the volume.
    if os.path.isfile(target_path) and os.path.getsize(target_path) > 0:
        return 'success'

    # A leftover .part / sidecar is a RESUMABLE partial download, not an error.
    # Returning 'not_started' lets the next /download_to_stage trigger resume
    # from the sidecar offsets instead of failing the provision.
    if os.path.exists(sidecar) or os.path.exists(part_path):
        return 'not_started'

    return 'not_started'


def _probe(url):
    '''Return (total_size:int|None, supports_ranges:bool) for a URL.

    Tries a HEAD first; if the server is unhelpful, falls back to a 1-byte
    Range GET and derives the size from the Content-Range header.
    '''
    total = None
    supports_ranges = False
    try:
        r = requests.head(url, timeout=(30, 60), allow_redirects=True)
        if r.ok:
            cl = r.headers.get('Content-Length')
            if cl and cl.isdigit():
                total = int(cl)
            if r.headers.get('Accept-Ranges', '').lower() == 'bytes':
                supports_ranges = True
    except Exception as exc:
        logger.warning('HEAD probe failed for %s: %s', url, exc)

    if not supports_ranges or total is None:
        try:
            r = requests.get(url, headers={'Range': 'bytes=0-0'},
                             stream=True, timeout=(30, 60), allow_redirects=True)
            try:
                if r.status_code == 206:
                    content_range = r.headers.get('Content-Range', '')
                    if '/' in content_range:
                        tail = content_range.rsplit('/', 1)[-1].strip()
                        if tail.isdigit():
                            total = int(tail)
                            supports_ranges = True
            finally:
                r.close()
        except Exception as exc:
            logger.warning('Range probe failed for %s: %s', url, exc)

    return total, supports_ranges


def _plan_segments(total, n):
    seg_size = total // n
    segments = []
    start = 0
    for i in range(n):
        end = total - 1 if i == n - 1 else (start + seg_size - 1)
        segments.append({'start': start, 'end': end, 'done': 0})
        start = end + 1
    return segments


def _load_sidecar(sidecar, url, total):
    if not os.path.exists(sidecar):
        return None
    try:
        with open(sidecar) as f:
            data = json.load(f)
        if (data.get('url') == url and data.get('total') == total
                and isinstance(data.get('segments'), list)
                and data['segments']):
            return data['segments']
    except Exception as exc:
        logger.warning('Ignoring unreadable sidecar %s: %s', sidecar, exc)
    return None


def _write_sidecar(sidecar, url, total, segments):
    tmp = sidecar + '.tmp'
    with open(tmp, 'w') as f:
        json.dump({'url': url, 'total': total, 'segments': segments}, f)
    os.replace(tmp, sidecar)


def _preallocate(part_path, total):
    flags = os.O_RDWR | os.O_CREAT
    fd = os.open(part_path, flags)
    try:
        os.ftruncate(fd, total)
    finally:
        os.close(fd)


def _download_segment(url, part_path, seg, seg_lock):
    '''Download a single byte-range segment, resuming from seg['done'].

    Retries the SAME segment from its current offset on transient errors so a
    connection reset never discards already-written bytes.
    '''
    attempt = 0
    while True:
        resume_at = seg['start'] + seg['done']
        if resume_at > seg['end']:
            return
        headers = {'Range': 'bytes=%d-%d' % (resume_at, seg['end'])}
        try:
            r = requests.get(url, headers=headers, stream=True,
                             timeout=(30, 300))
            if r.status_code not in (200, 206):
                raise RuntimeError('HTTP %d' % r.status_code)
            with open(part_path, 'r+b') as out:
                out.seek(resume_at)
                for chunk in r.iter_content(chunk_size=CHUNK_SIZE):
                    if not chunk:
                        continue
                    out.write(chunk)
                    with seg_lock:
                        seg['done'] += len(chunk)
            return
        except Exception as exc:
            attempt += 1
            if attempt > MAX_RETRIES:
                raise RuntimeError(
                    'segment %d-%d failed after %d retries: %s'
                    % (seg['start'], seg['end'], MAX_RETRIES, exc))
            backoff = min(2 ** attempt, 60)
            logger.warning(
                'segment %d-%d retry %d/%d after %ss (resume at %d): %s',
                seg['start'], seg['end'], attempt, MAX_RETRIES, backoff,
                seg['start'] + seg['done'], exc)
            time.sleep(backoff)


def _download_ranged(url, file_path, total):
    part_path = _part_path(file_path)
    sidecar = _sidecar_path(file_path)
    os.makedirs(os.path.dirname(file_path), exist_ok=True)

    segments = _load_sidecar(sidecar, url, total)
    if segments is None:
        segments = _plan_segments(total, CONCURRENCY)
        _preallocate(part_path, total)
        _write_sidecar(sidecar, url, total, segments)
        logger.info('Starting ranged download %s (%d bytes, %d segments)',
                    file_path, total, len(segments))
    else:
        if not os.path.exists(part_path) or os.path.getsize(part_path) != total:
            _preallocate(part_path, total)
        done = sum(s['done'] for s in segments)
        logger.info('Resuming ranged download %s from %d/%d bytes (%d%%)',
                    file_path, done, total, int(done * 100 / total))

    seg_lock = threading.Lock()
    stop_flusher = threading.Event()

    def _flush():
        with seg_lock:
            snapshot = [dict(s) for s in segments]
        _write_sidecar(sidecar, url, total, snapshot)
        done = sum(s['done'] for s in snapshot)
        _set_progress(file_path, done, total)
        logger.info('Download progress %s: %d/%d bytes (%d%%)',
                    file_path, done, total, int(done * 100 / total))

    # Periodic background flusher: persists resume state and logs progress
    # roughly every 15s without coupling to per-chunk write paths.
    def _flusher_loop():
        while not stop_flusher.wait(15):
            try:
                _flush()
            except Exception as exc:
                logger.warning('progress flush failed: %s', exc)

    flusher = threading.Thread(target=_flusher_loop, daemon=True)
    flusher.start()

    errors = []
    try:
        with ThreadPoolExecutor(max_workers=len(segments)) as ex:
            futures = [ex.submit(_download_segment, url, part_path, seg, seg_lock)
                       for seg in segments]
            for fut in futures:
                try:
                    fut.result()
                except Exception as exc:
                    errors.append(str(exc))
    finally:
        stop_flusher.set()
        flusher.join(timeout=5)

    # Persist final segment state before evaluating success/failure so a
    # subsequent resume sees the latest offsets.
    try:
        _flush()
    except Exception:
        pass

    if errors:
        raise RuntimeError('; '.join(errors))

    final_size = os.path.getsize(part_path)
    if final_size != total:
        raise RuntimeError('size mismatch: got %d, expected %d'
                           % (final_size, total))

    if os.path.exists(file_path):
        os.remove(file_path)
    os.rename(part_path, file_path)
    if os.path.exists(sidecar):
        os.remove(sidecar)
    logger.info('Download successful to %s (%d bytes via %d segments)',
                file_path, total, len(segments))
    return total


def _download_file_streaming(url, file_path):
    '''Single-connection streaming fallback (server lacks range support).'''
    part_path = _part_path(file_path)
    os.makedirs(os.path.dirname(file_path), exist_ok=True)

    if os.path.exists(part_path):
        os.remove(part_path)

    response = requests.get(url, stream=True, timeout=(30, 300))
    if response.status_code != 200:
        # Permanent HTTP error on the fallback path: drop the empty .part.
        if os.path.exists(part_path):
            os.remove(part_path)
        raise RuntimeError('HTTP %d from %s' % (response.status_code, url))

    downloaded = 0
    with open(part_path, 'wb') as out_file:
        for chunk in response.iter_content(chunk_size=CHUNK_SIZE):
            if chunk:
                out_file.write(chunk)
                downloaded += len(chunk)
                _set_progress(file_path, downloaded, 0)

    if os.path.exists(file_path):
        os.remove(file_path)
    os.rename(part_path, file_path)
    logger.info('Download successful to %s (%d bytes, single-stream)',
                file_path, downloaded)
    return downloaded


def _download_file(url, file_path):
    total, supports_ranges = _probe(url)
    if supports_ranges and total:
        return _download_ranged(url, file_path, total)
    logger.info('Range not supported or size unknown for %s; '
                'using single-stream fallback', url)
    return _download_file_streaming(url, file_path)


def _run_download(url, file_path):
    _set_job_status(file_path, 'in_progress')
    try:
        _download_file(url, file_path)
        _set_job_status(file_path, 'success')
    except Exception as exc:
        # IMPORTANT: do NOT delete .part / .part.progress here. They are the
        # resume state. The next /download_to_stage trigger resumes from the
        # sidecar offsets instead of restarting the whole transfer from byte 0.
        message = 'error: %s' % exc
        _set_job_status(file_path, 'error', message)
        logger.exception('Download failed for %s', file_path)


def _start_download(url, file_path):
    job = _get_job_status(file_path)
    if job is not None and job['status'] in ('started', 'in_progress'):
        # A live download thread already owns this target; do not restart it.
        return job['status']

    if os.path.isfile(file_path) and os.path.getsize(file_path) > 0:
        _set_job_status(file_path, 'success')
        return 'success'

    # Fresh start OR resume-after-error/restart: a single new thread that
    # _download_ranged will transparently resume from the sidecar if present.
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
