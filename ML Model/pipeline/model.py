"""The main pipeline class.

`MobileRecommendationPipeline` loads a trained XGBoost booster + frozen
categorical dtypes + frozen scoring quantile snapshot from `artifacts/`,
and exposes `predict` / `explain` / `score` / `recommend` methods.
"""

from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import shap
import xgboost as xgb

from .recommend import (
    PersonaType,
    UserPreferenceInput,
    recommend as _recommend,
    score_cols_map,
    
)
from .scoring import ScoringSnapshot, compute_scores, score_one


# ---------------------------------------------------------------------------
# internal: keep categorical dtype info consistent between train and predict
# ---------------------------------------------------------------------------
class CategoricalDtypeManager:
    """Owns the train-time category index per object column.

    XGBoost crashes if a predict-time row contains a category the booster
    has never seen, and silently codes it as NaN if the dtype is plain
    object.  We snapshot the training categories and union them with any
    new categories that show up at predict time.
    """

    def __init__(self, mapping: Dict[str, List[str]]):
        self._cats: Dict[str, List[str]] = {k: list(v) for k, v in mapping.items()}

    @classmethod
    def from_dataframe(cls, df: pd.DataFrame, cat_columns: List[str]) -> "CategoricalDtypeManager":
        mapping: Dict[str, List[str]] = {}
        for c in cat_columns:
            if c in df.columns:
                # Use observed categories + a placeholder for "missing"
                cats = df[c].astype("string").fillna("__nan__").unique().tolist()
                # Stable order: sort but keep "__nan__" last
                cats_sorted = sorted([x for x in cats if x != "__nan__"])
                if "__nan__" in cats:
                    cats_sorted.append("__nan__")
                mapping[c] = cats_sorted
        return cls(mapping)

    def transform(self, df: pd.DataFrame) -> pd.DataFrame:
        """Cast columns to category with the **frozen** training categories.

        XGBoost's `enable_categorical=True` requires the column's category
        set to include the training categories.  Any value in the input
        that wasn't seen at training time is mapped to NaN (which XGBoost
        handles as a missing value), so a phone with a brand-new CPU/Brand
        still produces a sensible prediction instead of crashing.
        """
        df = df.copy()
        for col, cats in self._cats.items():
            if col not in df.columns:
                df[col] = np.nan
                continue
            s = df[col].astype("string").fillna("__nan__")
            cat_dtype = pd.CategoricalDtype(categories=list(cats), ordered=False)
            encoded = s.astype(cat_dtype)
            # Map anything outside the training categories to NaN.
            train_set = set(cats)
            df[col] = encoded.where(encoded.isin(train_set), other=np.nan)
        return df

    def to_dict(self) -> Dict[str, List[str]]:
        return {k: list(v) for k, v in self._cats.items()}


# ---------------------------------------------------------------------------
# the pipeline class
# ---------------------------------------------------------------------------
class MobileRecommendationPipeline:
    """Loads artifacts, exposes predict / explain / score / recommend."""

    def __init__(self, artifact_dir: str | os.PathLike = "artifacts"):
        self.artifact_dir = Path(artifact_dir)
        self._load_artifacts()
        self._explainer: Optional[shap.TreeExplainer] = None  # lazy

    # -------- load --------
    def _load_artifacts(self) -> None:
        with open(self.artifact_dir / "feature_columns.json", "r", encoding="utf-8") as f:
            self.feature_columns: List[str] = json.load(f)
        with open(self.artifact_dir / "category_dtypes.json", "r", encoding="utf-8") as f:
            cat_map = json.load(f)
        self.cat_manager = CategoricalDtypeManager(cat_map)

        with open(self.artifact_dir / "scoring_snapshot.json", "r", encoding="utf-8") as f:
            self.scoring_snap = ScoringSnapshot.from_json(f.read())

        with open(self.artifact_dir / "training_report.json", "r", encoding="utf-8") as f:
            self.training_report: Dict[str, Any] = json.load(f)

        self.model = xgb.XGBRegressor(enable_categorical=True, tree_method="hist")
        self.model.load_model(str(self.artifact_dir / "model.json"))

    # -------- predict --------
    def _prepare_X(self, df: pd.DataFrame) -> pd.DataFrame:
        """Reorder columns, fill missing ones, cast categorical dtypes."""
        # add any missing feature columns as NaN/__nan__ (will be encoded)
        for col in self.feature_columns:
            if col not in df.columns:
                df[col] = "__nan__" if col in self.cat_manager._cats else np.nan
        # keep only the model's expected columns, in the right order
        X = df[self.feature_columns].copy()
        X = self.cat_manager.transform(X)
        return X

    def predict(self, df: pd.DataFrame) -> np.ndarray:
        """Return predicted AnTuTu score (raw, after expm1 of the log target)."""
        X = self._prepare_X(df)
        log_pred = self.model.predict(X)
        return np.expm1(log_pred)

    def predict_log(self, df: pd.DataFrame) -> np.ndarray:
        """Return predicted log1p(AnTuTu score)."""
        X = self._prepare_X(df)
        return self.model.predict(X)

    # -------- explain --------
    def _get_explainer(self) -> shap.TreeExplainer:
        if self._explainer is None:
            self._explainer = shap.TreeExplainer(self.model)
        return self._explainer

    def explain(self, df: pd.DataFrame, top_n: int = 5) -> List[List[Tuple[str, float]]]:
        """Return a list (one per row) of (feature, shap_value) pairs, top-|n| by magnitude.

        Matches the format from cell 107.
        """
        X = self._prepare_X(df)
        explainer = self._get_explainer()
        sv = explainer(X)
        results: List[List[Tuple[str, float]]] = []
        for i in range(len(X)):
            row = sv[i]
            pairs = sorted(
                zip(self.feature_columns, row.values),
                key=lambda p: -abs(p[1]),
            )[:top_n]
            results.append([(feat, float(val)) for feat, val in pairs])
        return results

    def explain_one(self, df_one_row: pd.DataFrame, top_n: int = 5) -> List[Tuple[str, float]]:
        """Convenience: explain a single-row dataframe."""
        return self.explain(df_one_row, top_n=top_n)[0]

    # -------- composite scoring --------
    def score(self, df: pd.DataFrame) -> pd.DataFrame:
        """Add the 11 score columns (Gaming…Overall + Value) using frozen quantiles."""
        return compute_scores(df, self.scoring_snap)

    def score_one(self, df_one_row: pd.DataFrame) -> Dict[str, float]:
        return score_one(df_one_row, self.scoring_snap)

    # -------- recommend --------
    def recommend(
        self,
        request: UserPreferenceInput,
        candidates: Optional[pd.DataFrame] = None,
    ) -> Tuple[Optional[List[Dict[str, Any]]], Optional[str]]:
        """Filter + rank phones by `request`.

        If `candidates` is None, callers are expected to have already
        pre-computed the score columns on the dataset (the typical
        `recommend` flow uses a precomputed score frame to avoid
        re-scoring the whole dataset per request).
        """
        if candidates is None:
            return None, "No candidates DataFrame provided."
        return _recommend(candidates, request, score_cols_map)

    # -------- introspection --------
    def metadata(self) -> Dict[str, Any]:
        return {
            "artifact_dir": str(self.artifact_dir),
            "n_features": len(self.feature_columns),
            "n_categorical_columns": len(self.cat_manager._cats),
            "training_report": self.training_report,
        }
