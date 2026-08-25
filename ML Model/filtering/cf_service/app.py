"""CF Recommender FastAPI service.

A tiny HTTP wrapper around the trained CFRecommender pickle
(`cf_recommender.pkl`). Loads the model once at startup and serves
recommendation requests from the Node.js backend on port 9001.

Endpoints
---------
GET /health   → liveness + whether the model artifact loaded successfully.
GET /recommend?customer_id=CUST-XXXX&top_n=10
              → {"results": [{"model_name", "score", "reason"}, ...]}

The model itself lives in `03_collaborative_filtering/output/`. We add it
to the Python path so the CFRecommender class is importable from the same
file the training script uses.
"""

from __future__ import annotations

import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=os.environ.get("CF_LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("cf_service")

# ---------------------------------------------------------------------------
# Paths — match the on-disk layout the training pipeline writes to.
# The Dockerfile places this service under /app, so MODEL_DIR is overridden
# via the CF_MODEL_DIR env var when running in Docker.
# ---------------------------------------------------------------------------
HERE = Path(__file__).resolve().parent
DEFAULT_MODEL_DIR = (
    HERE.parent / "03_collaborative_filtering" / "output"
)
MODEL_DIR = Path(os.environ.get("CF_MODEL_DIR", str(DEFAULT_MODEL_DIR)))

# Make the parent module importable so we can reach `cf_model.CFRecommender`.
CF_SRC_DIR = Path(
    os.environ.get("CF_SRC_DIR", str(HERE.parent / "03_collaborative_filtering"))
)
if str(CF_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(CF_SRC_DIR))

from cf_model import CFRecommender  # noqa: E402  — after sys.path manipulation

_recommender: Optional[CFRecommender] = None
_load_error: Optional[str] = None


def _try_load_recommender() -> Optional[CFRecommender]:
    """Load the pickle once at startup. Returns the instance or None if
    loading fails; the error message is stored on `_load_error` so /health
    can surface it."""
    global _load_error
    pkl_path = MODEL_DIR / "cf_recommender.pkl"
    if not pkl_path.exists():
        _load_error = f"Pickle not found at {pkl_path}"
        log.error(_load_error)
        return None
    try:
        log.info("Loading CF recommender from %s …", MODEL_DIR)
        rec = CFRecommender.load(MODEL_DIR)
        _load_error = None
        log.info("CF recommender loaded: %d users, %d items", rec.data.n_users, rec.data.n_items)
        return rec
    except Exception as exc:  # pragma: no cover — startup path
        _load_error = f"{type(exc).__name__}: {exc}"
        log.exception("Failed to load CF recommender")
        return None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Load the model once on startup, log a clean shutdown on exit."""
    global _recommender
    _recommender = _try_load_recommender()
    yield
    log.info("Shutting down CF service")


app = FastAPI(
    title="CF Recommender Service",
    version="1.0.0",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/health")
def health() -> dict:
    """Liveness probe + model-loaded status.

    The compose healthcheck uses this to wait until the model is ready
    before letting the backend boot. Returns 200 when the pickle loaded
    cleanly; returns 503 when it didn't (so the healthcheck can fail
    loudly rather than silently serving cold-start fallbacks).
    """
    if _recommender is None:
        return JSONResponse(
            status_code=503,
            content={
                "status": "model-not-loaded",
                "model_dir": str(MODEL_DIR),
                "error": _load_error,
            },
        )
    return {
        "status": "ok",
        "model_dir": str(MODEL_DIR),
        "n_users": _recommender.data.n_users,
        "n_items": _recommender.data.n_items,
        "cf_weight": _recommender.cf_weight,
        "content_weight": _recommender.content_weight,
    }


@app.get("/recommend")
def recommend(
    customer_id: str = Query(..., min_length=1, description="CF dataset customer_id, e.g. CUST-000EFD69"),
    top_n: int = Query(10, ge=1, le=50, description="Maximum number of phones to return (1..50)"),
) -> dict:
    """Return up to `top_n` phones for the given customer.

    Response shape is a clean JSON envelope:

        {
          "results": [
            {
              "model_name": "Apple iPhone 14 Pro Max",
              "score":      0.302,
              "reason":     "matches your preferred brand Apple; ..."
            },
            ...
          ],
          "customer_id": "CUST-000EFD69",
          "cold_start":  false,
          "top_n":       10
        }

    `cold_start` is `true` when the customer was unknown to the
    interaction log and the model fell back to the cluster / province /
    district / global popularity chain — useful for the BE to flag the
    request and for analytics to separate cold-start traffic from
    warm CF traffic.
    """
    if _recommender is None:
        # Return an empty result envelope rather than a 5xx so the BE's
        # hybrid merge degrades to content-only gracefully.
        return JSONResponse(
            status_code=503,
            content={
                "results": [],
                "customer_id": customer_id,
                "top_n": top_n,
                "cold_start": True,
                "error": _load_error or "model not loaded",
            },
        )

    cold = customer_id not in _recommender.data.user_index
    results = _recommender.get_recommendations(customer_id, top_n=top_n)

    return {
        "results": results,
        "customer_id": customer_id,
        "cold_start": cold,
        "top_n": top_n,
    }
