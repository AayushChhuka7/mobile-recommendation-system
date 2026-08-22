# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# CF Recommender — FastAPI inference service.
#
# Lightweight image — only uvicorn + a small numpy/pandas/sklearn set.
# The CFRecommender pickle is mounted at runtime rather than COPY'd
# into the image so a retrain only requires re-mounting the volume
# (no image rebuild). The compose file handles the bind via CF_MODEL_DIR.
#
# Reuses python:3.11-slim — same glibc + numpy/pandas wheel stack as the
# existing ml-service so we don't need a second virtualenv story.
#
# Production notes:
#   * uvicorn binds 0.0.0.0 — required for Docker port publishing AND
#     for inter-container calls from the Node backend.
#   * Pickle load happens ONCE at startup inside the FastAPI lifespan
#     handler (cf_service/app.py). We do NOT reload the model per
#     request — unchanged from the previous Dockerfile.
#   * `--port` reads `$PORT` at runtime, defaulting to 9001 so the
#     image works locally AND on cloud platforms.
# ---------------------------------------------------------------------------

# ---- Stage 1: builder ----
FROM python:3.11-slim AS builder

WORKDIR /build

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        build-essential \
        gcc \
 && rm -rf /var/lib/apt/lists/*

# requirements-cf.txt pins only the deps the CF service actually imports.
COPY requirements-cf.txt .
RUN pip install \
        --no-cache-dir \
        --disable-pip-version-check \
        --upgrade-strategy only-if-needed \
        --prefix=/install \
        -r requirements-cf.txt


# ---- Stage 2: runtime ----
FROM python:3.11-slim AS runtime

WORKDIR /app

# curl (healthcheck) + tini (clean SIGTERM forwarding to uvicorn).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        curl \
        tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /install/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder /install/bin /usr/local/bin

# CF service module + cf_model.py (the recommender class lives one dir up
# at 03_collaborative_filtering/cf_model.py). The pickle, catalog CSV,
# and profiles CSV are bind-mounted from the host at runtime so a
# retrain doesn't require rebuilding this image.
COPY cf_service/ ./cf_service/
COPY 03_collaborative_filtering/cf_model.py ./cf_model.py

ENV PORT=9001
EXPOSE 9001

# Healthcheck — same curl pattern as ml-service so compose behaviour is
# consistent across the two services.
HEALTHCHECK --interval=10s --timeout=5s --retries=5 --start-period=30s \
  CMD ["curl", "-fsS", "http://127.0.0.1:9001/health"]

# tini as PID 1 — forwards SIGTERM so uvicorn exits cleanly.
ENTRYPOINT ["/usr/bin/tini", "--"]
# `-k worker` is enough for this service. The pickle load happens once
# at startup; per-request work is ~30 ms. Single worker so the in-memory
# model is shared across requests.
CMD ["sh", "-c", "exec uvicorn cf_service.app:app --host 0.0.0.0 --port ${PORT} --workers 1"]
