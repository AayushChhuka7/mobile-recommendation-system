# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Mobile Recommendation ML — FastAPI service
#
# Multi-stage build:
#   1. `builder`  — installs ALL pip dependencies (compile + runtime) into a
#                   prefix directory. Compiles wheels for any C-extension
#                   packages (numpy, pandas, scikit-learn) which take minutes
#                   to build from source. This stage is the slow one; its
#                   layer is cached as long as requirements.txt is unchanged.
#   2. `runtime`  — slimmer base, copies the prebuilt site-packages from
#                   `builder` and only the source files we actually need.
#                   Final image is ~1 GB smaller than the single-stage version.
#
# Why python:3.11-slim for both stages:
#   - Slim = Debian 12 minus the GUI stack, ~80 MB compressed
#   - Has glibc, which matches most published wheels (numpy/pandas/sklearn
#     all ship glibc wheels; no `python:3.11-alpine` musl recompile pain)
#   - `slim` is the standard recommendation for FastAPI images
#
# Production notes:
#   * uvicorn binds 0.0.0.0 — required for Docker port publishing AND
#     for inter-container calls from the Node backend.
#   * The model is loaded ONCE in pipeline/serve.py's lifespan handler,
#     NOT on every request. See pipeline/serve.py (unchanged).
#   * `--port` reads `$PORT` at runtime, defaulting to 8002 so the
#     image works locally AND on Render/Railway/Fly.io (which all set
#     PORT automatically).
#   * A `/health` endpoint already exists in serve.py — we do NOT add
#     a duplicate one.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM python:3.11-slim AS builder

WORKDIR /build

# Install build dependencies first as their own layer so they cache well.
# build-essential, gcc, libffi-dev, and libssl-dev are needed to compile
# any wheel that doesn't ship a prebuilt version for our Python version.
# If a future dep requires BLAS/LAPACK, add libopenblas-dev here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        build-essential \
        gcc \
        libffi-dev \
        libssl-dev \
 && rm -rf /var/lib/apt/lists/*

# Copy ONLY requirements.txt first. This is the layer that caches longest —
# the deps themselves take ~3-5 min to install from scratch, but with this
# layer cached, subsequent builds that only change source code skip pip.
COPY requirements.txt .

# Install into a prefix directory we copy out of in the next stage.
# --prefix is the canonical way to relocate a virtualenv-free pip install.
# --no-cache-dir keeps the layer small (no pip wheel cache).
# --disable-pip-version-check is a small startup-time win.
# --upgrade-strategy only-if-needed respects the pin in requirements.txt.
RUN pip install \
        --no-cache-dir \
        --disable-pip-version-check \
        --upgrade-strategy only-if-needed \
        --prefix=/install \
        -r requirements.txt


# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

WORKDIR /app

# Runtime-only system libraries. curl is needed for the container
# healthcheck (also used by docker-compose). Adding tini so SIGTERM
# is forwarded correctly to uvicorn — avoids stuck shutdowns on
# platform restarts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        curl \
        tini \
 && rm -rf /var/lib/apt/lists/*

# Copy the prebuilt site-packages from the builder. This is the
# magic step that makes multi-stage builds worth it.
COPY --from=builder /install/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder /install/bin /usr/local/bin

# Copy only the files serve.py actually needs at runtime:
#   - pipeline/   (the code)
#   - artifacts/  (model.json + feature columns + scoring snapshot)
#   - the engineered CSV the candidates cache loads on startup
# Everything else (notebooks, .venv, batch data, scratch dumps) is
# excluded by ML Model/.dockerignore BEFORE the context ever reaches the
# daemon — see .dockerignore for the full filter list.
COPY pipeline/ ./pipeline/
COPY artifacts/ ./artifacts/
COPY After_EDA_and_Feature_ENginering.csv .
# Step D — content-based similarity bundle. Lazy-loaded by
# /similarity/score on first hit (not at startup), so the 566 MB cost
# is paid only when the BE actually asks for content-based ranking.
COPY similarity_bundle.joblib .

# Default port — overridable by the platform's PORT env. uvicorn reads
# the `--port` flag at startup; we inject $PORT into the CMD via shell
# so platforms that set PORT (Render, Railway, Fly.io, Heroku) just work.
ENV PORT=8002
EXPOSE 8002

# Healthcheck — uvicorn takes a few seconds to import numpy/pandas/sklearn.
# 30s start_period covers the slow first-time import.
HEALTHCHECK --interval=10s --timeout=5s --retries=5 --start-period=30s \
  CMD ["curl", "-fsS", "http://127.0.0.1:8002/health"]

# tini forwards SIGTERM correctly; uvicorn then drains in-flight
# requests and exits cleanly within docker's 10s grace window.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "exec uvicorn pipeline.serve:app --host 0.0.0.0 --port ${PORT}"]
