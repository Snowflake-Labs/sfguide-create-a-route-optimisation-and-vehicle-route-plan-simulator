ARG BASE_IMAGE=python:3.10-slim-buster
FROM $BASE_IMAGE
# pip runs as root in this single-purpose image by design; without this every
# build prints pip's "Running pip as the 'root' user" WARNING into the install log.
ENV PIP_ROOT_USER_ACTION=ignore
RUN pip install --upgrade pip && \
pip install flask requests polyline gunicorn

COPY routing_service.py ./
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "2", "--threads", "4", "--timeout", "360", "routing_service:app"]
