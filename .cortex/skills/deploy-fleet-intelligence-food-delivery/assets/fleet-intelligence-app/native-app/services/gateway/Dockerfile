ARG BASE_IMAGE=python:3.10-slim-buster
FROM $BASE_IMAGE
RUN pip install --upgrade pip && \
pip install flask requests polyline gunicorn

COPY routing_service.py ./
CMD ["gunicorn", "-w", "4", "-b", "0.0.0.0:8000", "--timeout", "120", "routing_service:app"]
