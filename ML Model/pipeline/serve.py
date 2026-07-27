"""FastAPI wrapper around `MobileRecommendationPipeline`.

Run with: `uvicorn pipeline.serve:app --port 8002`

Endpoints:
    GET  /health                  liveness + model status
    POST /predict                 body: {phone_features} -> predicted AnTuTu + SHAP top-N
    POST /predict_new             body: {raw: <cleaned phone row>} -> predict + score + SHAP
    POST /score                   body: {phone_features} -> composite score dict
    POST /recommend               body: UserPreferenceInput -> ranked list of phones
    POST /compare                 body: {model_name_a, model_name_b} -> per-dim winner
    GET  /explain/<model_name>    -> SHAP top-N for a phone in the pool


The model is loaded once at process start. The Node/Express backend at
`backend/src/routes/recommendRoutes.mjs` calls these endpoints over HTTP.
"""

from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
sys.path.insert(0, str(PROJECT_ROOT))

from pipeline.model import MobileRecommendationPipeline  # noqa: E402
from pipeline.recommend import PersonaType, UserPreferenceInput  # noqa: E402
from pipeline.scoring import compute_scores  # noqa: E402


ARTIFACT_DIR = PROJECT_ROOT / "artifacts"
DATA_PATH = PROJECT_ROOT / "After_EDA_and_Feature_ENginering.csv"


# ---------------------------------------------------------------------------
# Frontend ↔ ML persona key mapping
#
# The FE sends lowercase short keys ("gamer", "camera", "battery",
# "allrounder"). The Python `PersonaType` enum uses PascalCase / underscore
# values. We accept BOTH for forward-compat, but the FE-friendly short keys
# are the canonical form per the API spec.
# ---------------------------------------------------------------------------
PERSONA_ALIASES: Dict[str, str] = {
    # FE-friendly short keys
    "gamer": "Gamer",
    "camera": "Camera_Lover",
    "battery": "Battery_Focused",
    "allrounder": "All_Rounder",
    "business": "Business_User",
    "custom": "Custom",
    # PascalCase pass-through (server-to-server callers may use these)
    "Gamer": "Gamer",
    "Camera_Lover": "Camera_Lover",
    "Battery_Focused": "Battery_Focused",
    "All_Rounder": "All_Rounder",
    "Business_User": "Business_User",
    "Custom": "Custom",
}

# Lowercase preference slider keys → SCORE_DIMENSIONS PascalCase keys.
# FE sends {gaming, camera, battery, display}; ML wants {Gaming, Camera, ...}.
# We also pad missing dimensions with 3 (a neutral "I don't care" value) so
# callers who only tune 4 sliders still get sensible 9-dim rankings.
_DIM_KEY_NORMALIZE: Dict[str, str] = {
    "gaming": "Gaming",
    "camera": "Camera",
    "battery": "Battery",
    "display": "Display",
    "software": "Software",
    "storage": "Storage",
    "connectivity": "Connectivity",
    "security": "Security",
    "portability": "Portability",
}


def _resolve_persona(raw: str) -> PersonaType:
    """Map an incoming persona string to PersonaType, or raise 400."""
    mapped = PERSONA_ALIASES.get(raw)
    if mapped is None:
        valid = sorted(set(PERSONA_ALIASES.keys()))
        raise HTTPException(
            status_code=400,
            detail=f"Invalid persona '{raw}'. Valid: {valid}",
        )
    try:
        return PersonaType(mapped)
    except ValueError as exc:
        # Defensive: if the alias target isn't a valid enum value, surface
        # the mismatch instead of returning a confusing 500.
        raise HTTPException(
            status_code=400,
            detail=f"Persona alias target '{mapped}' is not a valid PersonaType",
        ) from exc


# ---------------------------------------------------------------------------
# startup: load model + cache the candidate dataset (with scores pre-computed)
# ---------------------------------------------------------------------------
pipeline: Optional[MobileRecommendationPipeline] = None
_candidates_scored: Optional[pd.DataFrame] = None
_model_load_error: Optional[str] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load artifacts once on startup; warm the candidate cache.

    Failures here are recorded but do not crash the process — /health
    reports `model_loaded: false` and /recommend returns 503, which is
    the right behavior for a sidecar that's still warming up.
    """
    global pipeline, _candidates_scored, _model_load_error
    print(f"[startup] loading pipeline from {ARTIFACT_DIR} …", flush=True)
    try:
        pipeline = MobileRecommendationPipeline(ARTIFACT_DIR)
        print(
            f"[startup] loaded. n_features={len(pipeline.feature_columns)}",
            flush=True,
        )
    except Exception as exc:  # noqa: BLE001
        _model_load_error = str(exc)
        print(f"[startup] FAILED to load pipeline: {exc}", flush=True)
        pipeline = None
    else:
        _candidates_scored = _load_candidates()
    yield
    # No teardown needed — uvicorn handles it.


app = FastAPI(
    title="Mobile Recommendation ML Service",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS — allow all origins in development. The Node/Express backend is the
# primary caller, but the FE may also hit this directly during local
# debugging. Tighten `allow_origins` in production.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,  # required False when allow_origins="*"
    allow_methods=["*"],
    allow_headers=["*"],
)


def _load_candidates() -> Optional[pd.DataFrame]:
    """Read the candidate CSV and pre-compute the 11 score columns.

    Cached in module state so /recommend is a single rank() over an
    in-memory frame, not a re-score per request.
    """
    if not DATA_PATH.exists():
        print(
            f"[startup] WARNING: candidate dataset not found at {DATA_PATH}",
            flush=True,
        )
        return None
    df = pd.read_csv(DATA_PATH)
    df = compute_scores(df, pipeline.scoring_snap)  # type: ignore[union-attr]
    print(f"[startup] cached {len(df)} scored candidates", flush=True)
    return df


@app.on_event("startup")
def _warm_cache() -> None:
    df = _load_candidates()
    # Hand the scored pool to the pipeline so /explain and /compare
    # (which read pipeline._candidates) work without a second load.
    if not df.empty:
        pipeline._candidates = df  # noqa: SLF001 — intentional bootstrap


# ---------------------------------------------------------------------------
# schemas
# ---------------------------------------------------------------------------
class Budget(BaseModel):
    min: float = 0.0
    max: float = Field(..., gt=0)


class RecommendRequest(BaseModel):
    persona: str
    budget: Budget
    # Optional override of dimension weights (1-5 stars per dimension).
    # Used as `custom_weights_stars` when persona=Custom; otherwise the
    # persona preset wins.
    preferences: Dict[str, int] = Field(default_factory=dict)
    # Step C — Profile Fusion Engine output. Filled in by the Express
    # layer when a logged-in user has both an explicit persona AND a
    # non-empty behaviour score map. Shape: {Gaming: 4, Camera: 2, ...}
    # (1-5 stars per ML dim). When provided AND non-empty, this takes
    # precedence over the persona preset regardless of `persona` —
    # i.e. fusion always uses Custom-style weights internally. When
    # absent or empty, the persona preset / `preferences` flow is used
    # unchanged, so Phase 1 callers see no behaviour at all.
    fusion_weights: Dict[str, int] = Field(default_factory=dict)
    topN: int = Field(default=6, ge=1, le=50)

    @field_validator("persona")
    @classmethod
    def _persona_nonempty(cls, v: str) -> str:
        if not isinstance(v, str) or not v.strip():
            raise ValueError("persona must be a non-empty string")
        return v

    @field_validator("preferences")
    @classmethod
    def _preferences_in_range(cls, v: Dict[str, int]) -> Dict[str, int]:
        for k, val in v.items():
            if not isinstance(val, int) or not (1 <= val <= 5):
                raise ValueError(
                    f"preferences['{k}'] must be an integer in [1, 5]",
                )
        return v

    @field_validator("fusion_weights")
    @classmethod
    def _fusion_weights_in_range(cls, v: Dict[str, int]) -> Dict[str, int]:
        # Step C — same shape as `preferences` but emitted by the
        # Fusion Engine and asserted to be a full 9-dim PascalCase
        # map. We accept any PascalCase key that's a valid scoring
        # dim, plus the lowercase aliases for the common four (the
        # FE sends them lowercase in `preferences`).
        allowed = set(_DIM_KEY_NORMALIZE.values()) | set(_DIM_KEY_NORMALIZE.keys())
        for k, val in v.items():
            if k not in allowed:
                raise ValueError(
                    f"fusion_weights['{k}'] is not a known dimension "
                    f"(valid: {sorted(allowed)})",
                )
            if not isinstance(val, int) or not (1 <= val <= 5):
                raise ValueError(
                    f"fusion_weights['{k}'] must be an integer in [1, 5]",
                )
        return v


class PredictRequest(BaseModel):
    features: Dict[str, Any]
    top_n_shap: int = 5


class ScoreRequest(BaseModel):
    features: Dict[str, Any]


# ---------------------------------------------------------------------------
# global error envelope — keeps the JSON shape consistent across all errors
# ---------------------------------------------------------------------------
def _error_envelope(
    status: int, code: str, message: str, details: Any = None
) -> JSONResponse:
    body: Dict[str, Any] = {"success": False, "code": code, "message": message}
    if details is not None:
        body["details"] = details
    return JSONResponse(status_code=status, content=body)


class PredictNewRequest(BaseModel):
    """A raw phone row in the cleaned schema (single row, dict-shaped)."""
    raw: Dict[str, Any]


class CompareRequest(BaseModel):
    model_name_a: str
    model_name_b: str


# ---------------------------------------------------------------------------
# endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
def health() -> Dict[str, Any]:
    loaded = pipeline is not None
    payload: Dict[str, Any] = {
        "status": "ok" if loaded else "degraded",
        "model_loaded": loaded,
        "candidates_count": int(len(_candidates_scored)) if _candidates_scored is not None else 0,
    }
    if not loaded and _model_load_error:
        payload["load_error"] = _model_load_error
    return payload


@app.post("/predict")
def predict(req: PredictRequest) -> Dict[str, Any]:
    if pipeline is None:
        raise HTTPException(
            status_code=503,
            detail="Model not loaded. Check /health for load_error.",
        )
    df = pd.DataFrame([req.features])
    if df.empty:
        raise HTTPException(status_code=400, detail="Empty features payload")
    try:
        score = float(pipeline.predict(df)[0])
        log = float(pipeline.predict_log(df)[0])
        shap_pairs = pipeline.explain_one(df, top_n=req.top_n_shap)
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {
        "antutu_log": log,
        "antutu_score": score,
        "top_features": [
            {"feature": f, "shap": v} for f, v in shap_pairs
        ],
    }


@app.post("/predict_new")
def predict_new(req: PredictNewRequest) -> Dict[str, Any]:
    """Score a phone that isn't in the dataset (raw cleaned row)."""
    try:
        return pipeline.predict_new(req.raw)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/compare")
def compare(req: CompareRequest) -> Dict[str, Any]:
    """Compare two phones from the candidates pool across all 9 score dimensions."""
    if _load_candidates().empty:
        raise HTTPException(status_code=503, detail="No candidate dataset available")
    try:
        return pipeline.compare_phones(req.model_name_a, req.model_name_b)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/explain/{model_name}")
def explain(model_name: str, top_n: int = 5) -> Dict[str, Any]:
    """SHAP top-|n| features for a phone in the candidates pool."""
    if _load_candidates().empty:
        raise HTTPException(status_code=503, detail="No candidate dataset available")
    try:
        pairs = pipeline.explain_phone(model_name, top_n=top_n)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"model_name": model_name, "top_features": [{"feature": f, "shap": v} for f, v in pairs]}


@app.post("/score")
def score(req: ScoreRequest) -> Dict[str, Any]:
    if pipeline is None:
        raise HTTPException(
            status_code=503,
            detail="Model not loaded. Check /health for load_error.",
        )
    df = pd.DataFrame([req.features])
    if df.empty:
        raise HTTPException(status_code=400, detail="Empty features payload")
    try:
        return pipeline.score_one(df)
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/recommend")
def recommend(req: RecommendRequest) -> Dict[str, Any]:
    # 503 — model not ready
    if pipeline is None:
        raise HTTPException(
            status_code=503,
            detail="Model not loaded. Check /health for load_error.",
        )

    # 400 — bad persona
    try:
        persona = _resolve_persona(req.persona)
    except HTTPException:
        raise

    # 400 — bad budget (Budget model already enforces max > 0; this is a
    # belt-and-suspenders check that min <= max)
    if req.budget.min < 0:
        raise HTTPException(
            status_code=400,
            detail=f"budget.min must be >= 0 (got {req.budget.min})",
        )
    if req.budget.min > req.budget.max:
        raise HTTPException(
            status_code=400,
            detail=(
                f"budget.min ({req.budget.min}) must be <= "
                f"budget.max ({req.budget.max})"
            ),
        )

    # Translate FE preferences (lowercase keys, partial) into the ML's
    # expected PascalCase 9-dim dict, padding missing dims with 3 (neutral).
    custom_weights_stars: Optional[Dict[str, int]] = None
    if req.fusion_weights:
        # Step C — Profile Fusion Engine output. The Express layer has
        # already done the explicit-vs-behaviour math and produced a
        # full 9-dim star map; we honour it as-is. To force the ranker
        # to use these weights, we resolve the persona to CUSTOM (the
        # ranker only consults `custom_weights_stars` when
        # persona == Custom — see UserPreferenceInput.resolve_weights).
        custom_weights_stars = {}
        for raw_key, stars in req.fusion_weights.items():
            norm = _DIM_KEY_NORMALIZE.get(raw_key, raw_key)
            custom_weights_stars[norm] = stars
        persona = PersonaType.CUSTOM
    elif req.preferences:
        custom_weights_stars = {}
        for raw_key, stars in req.preferences.items():
            norm = _DIM_KEY_NORMALIZE.get(raw_key.lower())
            if norm is None:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Unknown preference key '{raw_key}'. "
                        f"Valid: {sorted(_DIM_KEY_NORMALIZE.keys())}"
                    ),
                )
            custom_weights_stars[norm] = stars

    pref = UserPreferenceInput(
        budget_max_eur=req.budget.max,
        budget_min_eur=req.budget.min,
        persona=persona,
        custom_weights_stars=custom_weights_stars,
        top_n_results=req.topN,
    )

    # 503 — candidate dataset not loaded (e.g. CSV missing at startup)
    if _candidates_scored is None or _candidates_scored.empty:
        raise HTTPException(
            status_code=503,
            detail=(
                f"No candidate dataset available (expected at {DATA_PATH}). "
                "Check /health for details."
            ),
        )

    try:
        results, err = pipeline.recommend(pref, candidates=_candidates_scored)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    if err:
        # The ranker's "no phones match" message is a 400 (caller's filter
        # is too tight), not a 500. Re-surface the ranker's exact reason.
        raise HTTPException(status_code=400, detail=err)
    return {"results": results or [], "error": None}


# ---------------------------------------------------------------------------
# uniform error envelope — overrides FastAPI's default {"detail": ...} shape
# so the FE only has to handle one error format
# ---------------------------------------------------------------------------
@app.exception_handler(HTTPException)
async def _http_exception_handler(_req: Request, exc: HTTPException) -> JSONResponse:
    code = {
        400: "VALIDATION_INVALID_INPUT",
        404: "RESOURCE_NOT_FOUND",
        503: "SERVICE_UNAVAILABLE",
    }.get(exc.status, "ERROR")
    return _error_envelope(exc.status, code, str(exc.detail))


@app.exception_handler(Exception)
async def _unhandled_exception_handler(_req: Request, exc: Exception) -> JSONResponse:
    return _error_envelope(500, "INTERNAL_ERROR", f"Unexpected error: {exc}")


# ---------------------------------------------------------------------------
# dev entrypoint: `python -m pipeline.serve`
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "pipeline.serve:app",
        host=os.environ.get("ML_HOST", "127.0.0.1"),
        port=int(os.environ.get("ML_PORT", "8002")),
        reload=False,
    )