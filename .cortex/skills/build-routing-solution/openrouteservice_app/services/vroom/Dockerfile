ARG BASE_IMAGE=ghcr.io/vroom-project/vroom-docker:v1.14.0
FROM $BASE_IMAGE

COPY config.yml /conf/config.yml
COPY docker-entrypoint-region.sh /docker-entrypoint-region.sh
USER root
RUN chmod +x /docker-entrypoint-region.sh /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint-region.sh"]
