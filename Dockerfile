FROM python:3.12-slim

ARG VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/getdom44-afk/registre" \
      org.opencontainers.image.description="Registre : gestion de comptes personnels"

ENV PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    PORT=8080 \
    APP_VERSION=${VERSION}

RUN useradd --create-home --uid 1000 registre \
 && mkdir -p /data /backups && chown registre:registre /data /backups

WORKDIR /app
COPY app/ /app/

USER registre
VOLUME ["/data", "/backups"]
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/auth', timeout=4)" || exit 1

CMD ["python", "/app/server.py"]
