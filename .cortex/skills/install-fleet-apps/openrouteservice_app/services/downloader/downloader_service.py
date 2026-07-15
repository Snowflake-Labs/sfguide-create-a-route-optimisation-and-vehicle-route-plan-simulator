from flask import Flask
from flask import request
from flask import make_response
import requests
import logging
import os
import sys
import json
import time
import shutil
import struct
import hashlib
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
# Per-segment retry budget. A transient connection reset re-downloads only that
# one segment (1/N of the file), not the whole transfer, so status stays
# 'in_progress' and the SQL poll loop keeps waiting.
MAX_RETRIES = max(1, int(os.getenv('DOWNLOAD_MAX_RETRIES', '6')))

BASE_FOLDER = '/downloads'

# IMPORTANT: SPCS stage-backed volume mounts are object-storage/FUSE backed and
# do NOT support random-offset writes (seek + write into an existing object).
# They DO support sequential writes of whole new objects. This downloader
# therefore fetches each byte-range segment in parallel into its OWN segment
# file (written sequentially from offset 0), then sequentially concatenates the
# segment files into the final object. No seek-into-preallocated-file is used.

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


def _seg_path(file_path, idx):
    return '%s.seg%d' % (file_path, idx)


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
    # registry is gone but staged segment files + sidecar persist on the volume.
    if os.path.isfile(target_path) and os.path.getsize(target_path) > 0:
        return 'success'

    # A leftover sidecar means a RESUMABLE partial download, not an error.
    # Returning 'not_started' lets the next /download_to_stage trigger resume
    # (completed segment files are skipped) instead of failing the provision.
    if os.path.exists(sidecar):
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


def _seg_len(seg):
    return seg['end'] - seg['start'] + 1


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
    # Small file; write directly (a torn write is tolerable because resume also
    # validates each segment file's on-disk size). Avoids rename churn on the
    # object-store mount.
    with open(sidecar, 'w') as f:
        json.dump({'url': url, 'total': total, 'segments': segments}, f)


def _download_segment(url, seg_file, seg, seg_lock):
    '''Fetch one byte-range segment sequentially into its own file.

    Each retry re-fetches the whole segment from offset 0 into a fresh file
    (sequential write only -- safe on object-store mounts). A failure costs at
    most one segment (1/N of the file), never the whole transfer.
    '''
    expected = _seg_len(seg)

    # Skip if a previous run already completed this segment (cross-restart resume).
    if os.path.exists(seg_file) and os.path.getsize(seg_file) == expected:
        with seg_lock:
            seg['done'] = expected
        return

    attempt = 0
    while True:
        headers = {'Range': 'bytes=%d-%d' % (seg['start'], seg['end'])}
        try:
            r = requests.get(url, headers=headers, stream=True,
                             timeout=(30, 300))
            if r.status_code not in (200, 206):
                raise RuntimeError('HTTP %d' % r.status_code)
            written = 0
            with open(seg_file, 'wb') as out:
                for chunk in r.iter_content(chunk_size=CHUNK_SIZE):
                    if not chunk:
                        continue
                    out.write(chunk)
                    written += len(chunk)
                    with seg_lock:
                        seg['done'] = written
            if written != expected:
                raise RuntimeError('segment short read: got %d, expected %d'
                                   % (written, expected))
            return
        except Exception as exc:
            attempt += 1
            with seg_lock:
                seg['done'] = 0
            if attempt > MAX_RETRIES:
                raise RuntimeError(
                    'segment %d-%d failed after %d retries: %s'
                    % (seg['start'], seg['end'], MAX_RETRIES, exc))
            backoff = min(2 ** attempt, 60)
            logger.warning('segment %d-%d retry %d/%d after %ss: %s',
                           seg['start'], seg['end'], attempt, MAX_RETRIES,
                           backoff, exc)
            time.sleep(backoff)


def _concatenate(file_path, segments, total):
    '''Sequentially concatenate segment files into the final object.'''
    part_path = _part_path(file_path)
    with open(part_path, 'wb') as out:
        for idx in range(len(segments)):
            seg_file = _seg_path(file_path, idx)
            with open(seg_file, 'rb') as src:
                shutil.copyfileobj(src, out, CHUNK_SIZE)

    final_size = os.path.getsize(part_path)
    if final_size != total:
        raise RuntimeError('assembled size mismatch: got %d, expected %d'
                           % (final_size, total))

    if os.path.exists(file_path):
        os.remove(file_path)
    os.rename(part_path, file_path)

    # Cleanup segment files + sidecar after a successful assemble.
    for idx in range(len(segments)):
        try:
            os.remove(_seg_path(file_path, idx))
        except OSError:
            pass
    sidecar = _sidecar_path(file_path)
    if os.path.exists(sidecar):
        try:
            os.remove(sidecar)
        except OSError:
            pass


def _download_ranged(url, file_path, total):
    sidecar = _sidecar_path(file_path)
    os.makedirs(os.path.dirname(file_path), exist_ok=True)

    segments = _load_sidecar(sidecar, url, total)
    if segments is None:
        segments = _plan_segments(total, CONCURRENCY)
        _write_sidecar(sidecar, url, total, segments)
        logger.info('Starting ranged download %s (%d bytes, %d segments)',
                    file_path, total, len(segments))
    else:
        done = sum(min(s['done'], _seg_len(s)) for s in segments)
        logger.info('Resuming ranged download %s (~%d/%d bytes, %d segments)',
                    file_path, done, total, len(segments))

    seg_lock = threading.Lock()
    stop_flusher = threading.Event()

    def _flush():
        with seg_lock:
            snapshot = [dict(s) for s in segments]
        _write_sidecar(sidecar, url, total, snapshot)
        done = sum(min(s['done'], _seg_len(s)) for s in snapshot)
        _set_progress(file_path, done, total)
        logger.info('Download progress %s: %d/%d bytes (%d%%)',
                    file_path, done, total, int(done * 100 / total))

    def _flusher_loop():
        while not stop_flusher.wait(30):
            try:
                _flush()
            except Exception as exc:
                logger.warning('progress flush failed: %s', exc)

    flusher = threading.Thread(target=_flusher_loop, daemon=True)
    flusher.start()

    errors = []
    try:
        with ThreadPoolExecutor(max_workers=len(segments)) as ex:
            futures = []
            for idx, seg in enumerate(segments):
                seg_file = _seg_path(file_path, idx)
                futures.append(
                    ex.submit(_download_segment, url, seg_file, seg, seg_lock))
            for fut in futures:
                try:
                    fut.result()
                except Exception as exc:
                    errors.append(str(exc))
    finally:
        stop_flusher.set()
        flusher.join(timeout=5)

    try:
        _flush()
    except Exception:
        pass

    if errors:
        raise RuntimeError('; '.join(errors))

    logger.info('All %d segments complete for %s; concatenating...',
                len(segments), file_path)
    _concatenate(file_path, segments, total)
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


# --- PBF integrity validation ---------------------------------------------
# A corrupt/truncated OSM PBF passes the byte-count check (bytes == server
# Content-Length) yet makes ORS abort graph init with
#   RuntimeException "Couldn't process file ...osm.pbf, error: Index N out of
#   bounds for length 0"
# which then hangs the SQL provisioning rescue loop for hours. We therefore
# structurally validate the file HERE, before it is ever handed to ORS, and on
# failure delete the file + resume state so the next attempt re-downloads clean.

# Reject a completed download whose size is below this fraction of the expected
# (probed) size. Catches servers that report a truncated Content-Length.
MIN_SIZE_FRACTION = float(os.getenv('PBF_MIN_SIZE_FRACTION', '0.5'))


def _is_pbf_target(file_path):
    lower = file_path.lower()
    return lower.endswith('.pbf') or lower.endswith('.osm.pbf')


def _validate_pbf_magic(file_path):
    '''Confirm the file begins with a well-formed OSM PBF header blob.

    PBF layout: 4-byte big-endian BlobHeader length, then a protobuf
    BlobHeader whose `type` field is the string "OSMHeader" for the first
    blob. We read the length prefix (must be a small, sane value), then scan
    the header bytes for the "OSMHeader" marker. This cheaply rejects HTML
    error pages, gzip'd partials, and truncated/garbage first blocks.
    '''
    with open(file_path, 'rb') as f:
        prefix = f.read(4)
        if len(prefix) < 4:
            raise RuntimeError('PBF too short to contain a BlobHeader length')
        header_len = struct.unpack('>i', prefix)[0]
        # Real OSM BlobHeaders are tiny (tens of bytes); cap generously at 64 KiB.
        if header_len <= 0 or header_len > 64 * 1024:
            raise RuntimeError(
                'implausible PBF BlobHeader length %d (not a valid PBF)'
                % header_len)
        header = f.read(header_len)
        if len(header) < header_len:
            raise RuntimeError('PBF truncated inside first BlobHeader')
        if b'OSMHeader' not in header:
            raise RuntimeError(
                'first PBF blob is not an OSMHeader (corrupt or not a PBF)')


def _file_md5(file_path):
    h = hashlib.md5()
    with open(file_path, 'rb') as f:
        for chunk in iter(lambda: f.read(CHUNK_SIZE), b''):
            h.update(chunk)
    return h.hexdigest()


def _validate_pbf_md5(url, file_path):
    '''Best-effort checksum check against Geofabrik's `<url>.md5` sidecar.

    Geofabrik publishes `<pbf>.md5` next to every PBF. If it is reachable we
    verify it (authoritative corruption detector). If the sidecar is missing
    or unreachable, we skip -- magic-byte + size-band checks still apply.
    '''
    md5_url = url + '.md5'
    try:
        r = requests.get(md5_url, timeout=(30, 60), allow_redirects=True)
        if r.status_code != 200 or not r.text.strip():
            logger.info('No usable md5 sidecar at %s (HTTP %d); skipping '
                        'checksum verification', md5_url, r.status_code)
            return
        expected = r.text.strip().split()[0].lower()
    except Exception as exc:
        logger.info('md5 sidecar fetch failed for %s: %s; skipping checksum',
                    md5_url, exc)
        return

    if len(expected) != 32:
        logger.info('md5 sidecar for %s not a valid hash (%r); skipping',
                    md5_url, expected)
        return

    actual = _file_md5(file_path)
    if actual != expected:
        raise RuntimeError('md5 mismatch: got %s, expected %s (corrupt download)'
                           % (actual, expected))
    logger.info('md5 verified for %s (%s)', file_path, actual)


def _validate_download(url, file_path, expected_total):
    '''Validate a completed PBF download; raise on any integrity failure.'''
    if not _is_pbf_target(file_path):
        return
    size = os.path.getsize(file_path) if os.path.isfile(file_path) else 0
    if size <= 0:
        raise RuntimeError('downloaded PBF is empty')
    if expected_total and size < int(expected_total * MIN_SIZE_FRACTION):
        raise RuntimeError(
            'downloaded PBF size %d is below %.0f%% of expected %d '
            '(truncated download)'
            % (size, MIN_SIZE_FRACTION * 100, expected_total))
    _validate_pbf_magic(file_path)
    _validate_pbf_md5(url, file_path)
    logger.info('PBF validation passed for %s (%d bytes)', file_path, size)


def _purge_download_state(file_path):
    '''Delete the corrupt final file + all resume state so the next attempt
    starts a clean re-download instead of treating the bad bytes as success.'''
    for p in [file_path, _part_path(file_path), _sidecar_path(file_path)]:
        try:
            if os.path.exists(p):
                os.remove(p)
        except OSError:
            pass
    idx = 0
    while True:
        seg = _seg_path(file_path, idx)
        if not os.path.exists(seg):
            break
        try:
            os.remove(seg)
        except OSError:
            pass
        idx += 1


def _run_download(url, file_path):
    _set_job_status(file_path, 'in_progress')
    try:
        expected_total = _download_file(url, file_path)
        _validate_download(url, file_path, expected_total)
        _set_job_status(file_path, 'success')
    except RuntimeError as exc:
        # Validation failure (or a download error surfaced as RuntimeError from
        # a corrupt payload). For a validation failure the bytes on disk are bad
        # and must NOT be treated as resumable success, so purge everything.
        msg = str(exc)
        if ('corrupt' in msg or 'mismatch' in msg or 'truncated' in msg
                or 'not a valid PBF' in msg or 'not a PBF' in msg
                or 'OSMHeader' in msg or 'PBF' in msg):
            _purge_download_state(file_path)
        _set_job_status(file_path, 'error', 'error: %s' % msg)
        logger.exception('Download failed for %s', file_path)
    except Exception as exc:
        # IMPORTANT: do NOT delete segment files / sidecar here. They are the
        # resume state. The next /download_to_stage trigger resumes, skipping
        # segments already complete on disk instead of restarting from scratch.
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
    # _download_ranged transparently resumes from the sidecar + segment files.
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
