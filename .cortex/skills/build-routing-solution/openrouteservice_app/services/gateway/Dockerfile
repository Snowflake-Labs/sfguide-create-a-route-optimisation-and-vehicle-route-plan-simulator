ARG BASE_IMAGE=python:3.10-slim-buster
FROM $BASE_IMAGE
RUN pip install --upgrade pip && \
pip install flask requests polyline gunicorn

COPY routing_service.py ./
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "2", "--threads", "4", "--timeout", "300", "routing_service:app"]
