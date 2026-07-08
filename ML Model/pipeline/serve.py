"""FastAPI wrapper around `MobileRecommendationPipeline`.

Run with: `uvicorn pipeline.serve:app --port 8002`
Endpoints:
    GET  /health         liveness + model status
    POST /predict        body: {phone_features} → predicted AnTuTu + SHAP top-N
    POST /score          body: {phone_features} → composite score dict
    POST /recommend      body: UserPreferenceInput → ranked list of phones

The model is loaded once at process start.  The Node/Express backend at
`backend/src/routes/recommendRoutes.mjs` calls these endpoints over HTTP.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
sys.path.insert(0, str(PROJECT_ROOT))

from pipeline.model import MobileRecommendationPipeline  # noqa: E402
from pipeline.recommend import PersonaType, UserPreferenceInput  # noqa: E402
from pipeline.scoring import compute_scores  # noqa: E402


ARTIFACT_DIR = PROJECT_ROOT / "artifacts"
DATA_PATH = PROJECT_ROOT / "After_EDA_and_Feature_ENginering.csv"


# ---------------------------------------------------------------------------
# startup: load model + cache the candidate dataset (with scores pre-computed)
# ---------------------------------------------------------------------------
app = FastAPI(title="Mobile Recommendation ML Service", version="1.0.0")

print(f"[startup] loading pipeline from {ARTIFACT_DIR} …", flush=True)
pipeline = MobileRecommendationPipeline(ARTIFACT_DIR)
print(f"[startup] loaded. n_features={len(pipeline.feature_columns)}", flush=True)

# cache: the full engineered dataset, with all 11 score columns pre-computed,
# so /recommend is a single rank() over the in-memory frame.
_candidates_scored: Optional[pd.DataFrame] = None


def _load_candidates() -> pd.DataFrame:
    global _candidates_scored
    if _candidates_scored is not None:
        return _candidates_scored
    if not DATA_PATH.exists():
        print(f"[startup] WARNING: candidate dataset not found at {DATA_PATH}", flush=True)
        return pd.DataFrame()
    df = pd.read_csv(DATA_PATH)
    df = compute_scores(df, pipeline.scoring_snap)
    _candidates_scored = df
    print(f"[startup] cached {len(df)} scored candidates", flush=True)
    return df


@app.on_event("startup")
def _warm_cache() -> None:
    _load_candidates()


# ---------------------------------------------------------------------------
# schemas
# ---------------------------------------------------------------------------
class PhoneFeatures(BaseModel):
    """Arbitrary phone-feature payload. Anything missing is filled by the model."""

    features: Dict[str, Any] = Field(default_factory=dict)

    def to_df(self) -> pd.DataFrame:
        return pd.DataFrame([self.features])


class PredictRequest(BaseModel):
    features: Dict[str, Any]
    top_n_shap: int = 5


class ScoreRequest(BaseModel):
    features: Dict[str, Any]


class RecommendRequest(BaseModel):
    budget_max_eur: float
    budget_min_eur: float = 0.0
    persona: str = "All_Rounder"
    preferred_brands: Optional[List[str]] = None
    exclude_brands: Optional[List[str]] = None
    min_ram_gb: Optional[float] = None
    require_5g: bool = False
    require_purchasable: bool = False
    custom_weights_stars: Optional[Dict[str, int]] = None
    top_n_results: int = 5
    exclude_imputed_price: bool = True


# ---------------------------------------------------------------------------
# endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "model_loaded": True,
        "n_features": len(pipeline.feature_columns),
        "training_report": pipeline.training_report,
    }


@app.post("/predict")
def predict(req: PredictRequest) -> Dict[str, Any]:
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


@app.post("/score")
def score(req: ScoreRequest) -> Dict[str, Any]:
    df = pd.DataFrame([req.features])
    if df.empty:
        raise HTTPException(status_code=400, detail="Empty features payload")
    try:
        return pipeline.score_one(df)
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/recommend")
def recommend(req: RecommendRequest) -> Dict[str, Any]:
    try:
        persona = PersonaType(req.persona)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid persona '{req.persona}'. Valid: {[p.value for p in PersonaType]}",
        ) from exc

    pref = UserPreferenceInput(
        budget_max_eur=req.budget_max_eur,
        budget_min_eur=req.budget_min_eur,
        persona=persona,
        preferred_brands=req.preferred_brands,
        exclude_brands=req.exclude_brands,
        min_ram_gb=req.min_ram_gb,
        require_5g=req.require_5g,
        require_purchasable=req.require_purchasable,
        custom_weights_stars=req.custom_weights_stars,
        top_n_results=req.top_n_results,
        exclude_imputed_price=req.exclude_imputed_price,
    )
    candidates = _load_candidates()
    if candidates.empty:
        raise HTTPException(status_code=503, detail="No candidate dataset available")

    results, err = pipeline.recommend(pref, candidates=candidates)
    if err:
        return {"results": [], "error": err}
    return {"results": results, "error": None}


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
