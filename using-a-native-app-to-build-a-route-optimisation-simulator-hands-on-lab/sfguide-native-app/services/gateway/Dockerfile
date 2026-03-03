ARG BASE_IMAGE=python:3.10-slim-buster
FROM $BASE_IMAGE
RUN pip install --upgrade pip && \
pip install flask requests polyline 

COPY routing_service.py ./
CMD ["python3", "routing_service.py"]

