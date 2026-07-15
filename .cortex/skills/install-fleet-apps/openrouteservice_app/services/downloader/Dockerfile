ARG BASE_IMAGE=python:3.10-slim-buster
FROM $BASE_IMAGE
RUN pip install --upgrade pip && \
pip install flask requests  

COPY downloader_service.py ./
CMD ["python3", "downloader_service.py"]

