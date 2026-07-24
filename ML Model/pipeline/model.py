"""The main pipeline class.

`MobileRecommendationPipeline` loads a trained XGBoost booster + frozen
categorical dtypes + frozen scoring quantile snapshot from `artifacts/`,
and exposes `predict` / `explain` / `score` / `recommend` methods.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import shap
import xgboost as xgb

from .recommend import (
    UserPreferenceInput,
    recommend as _recommend,
    score_cols_map,
)
from .scoring import ScoringSnapshot, compute_scores, score_one
from .features import engineer_all


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

    def __init__(
        self,
        artifact_dir: str | os.PathLike = "artifacts",
        candidates_csv: Optional[str | os.PathLike] = None,
    ):
        self.artifact_dir = Path(artifact_dir)
        self._load_artifacts()
        self._explainer: Optional[shap.TreeExplainer] = None  # lazy
        self._candidates: Optional[pd.DataFrame] = None
        if candidates_csv is not None:
            self.load_candidates(candidates_csv)

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

    # -------- candidates (pre-scored pool for /recommend) --------
    def load_candidates(self, csv_path: str | os.PathLike) -> pd.DataFrame:
        """Read the engineered CSV, add the 11 score columns, cache it.

        Idempotent — repeat calls re-read from disk.  Use `self.candidates`
        to access the in-memory frame.
        """
        df = pd.read_csv(csv_path)
        df = compute_scores(df, self.scoring_snap)
        self._candidates = df
        return df

    @property
    def candidates(self) -> Optional[pd.DataFrame]:
        return self._candidates

    # -------- predict --------
    def _prepare_X(self, df: pd.DataFrame) -> pd.DataFrame:
        """Reorder columns, fill missing ones, cast categorical dtypes.

        Does not mutate the caller's df.
        """
        df = df.copy()
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

        If `candidates` is None, falls back to `self.candidates` (loaded
        by `load_candidates()`).  Returns (results, error).
        """
        pool = candidates if candidates is not None else self._candidates
        if pool is None:
            return None, "No candidates loaded — call load_candidates(csv_path) first."
        return _recommend(pool, request, score_cols_map)

    # -------- predict a NEW (un-engineered) phone --------
    def predict_new(self, raw: pd.DataFrame | Dict[str, Any]) -> Dict[str, Any]:
        """Run the full raw-row → engineered-frame → predict pipeline.

        `raw` is a single phone row in the **cleaned** schema
        (i.e. one row from `GSMArena_Cleaned_Dataset.csv`).  This wraps
        `engineer_all` + `predict` + `score_one` + `explain_one` in one
        call so the backend can score a phone that's not in the dataset.

        Returns a dict with the AnTuTu prediction, all 11 score columns,
        and the top-N SHAP drivers.
        """
        if isinstance(raw, dict):
            raw = pd.DataFrame([raw])
        elif not isinstance(raw, pd.DataFrame):
            raise TypeError(f"raw must be a dict or DataFrame, got {type(raw).__name__}")
        if raw.empty:
            raise ValueError("raw row is empty")

        engineered = engineer_all(raw)
        antutu = float(self.predict(engineered)[0])
        scores = self.score_one(engineered)
        shap_pairs = self.explain_one(engineered, top_n=5)
        return {
            "predicted_antutu": antutu,
            "scores": scores,
            "top_features": [{"feature": f, "shap": v} for f, v in shap_pairs],
        }

    # -------- compare two phones (cell 112 of the EDA notebook) --------
    def compare_phones(
        self,
        model_name_a: str,
        model_name_b: str,
    ) -> Dict[str, Any]:
        """Compare two phones in the candidates pool on every score dim.

        Looks them up by exact `Model_Name` match in `self.candidates`.
        Returns a dict with per-dimension scores, the overall winner by
        number-of-dims-won, and the SHAP top-features for each.
        """
        pool = self._candidates
        if pool is None:
            raise RuntimeError("No candidates loaded — call load_candidates(csv_path) first.")
        if "Model_Name" not in pool.columns:
            raise RuntimeError("candidates pool has no Model_Name column")

        a = pool[pool["Model_Name"] == model_name_a]
        b = pool[pool["Model_Name"] == model_name_b]
        if a.empty:
            raise ValueError(f"Phone A not found: {model_name_a!r}")
        if b.empty:
            raise ValueError(f"Phone B not found: {model_name_b!r}")
        phone_a = a.iloc[0]
        phone_b = b.iloc[0]

        comparison: Dict[str, Dict[str, Any]] = {}
        for dim, col in score_cols_map.items():
            val_a = float(phone_a[col])
            val_b = float(phone_b[col])
            if val_a > val_b:
                winner = model_name_a
            elif val_b > val_a:
                winner = model_name_b
            else:
                winner = "Tie"
            comparison[dim] = {"A": round(val_a, 1), "B": round(val_b, 1), "Winner": winner}

        wins_a = sum(1 for v in comparison.values() if v["Winner"] == model_name_a)
        wins_b = sum(1 for v in comparison.values() if v["Winner"] == model_name_b)
        overall = model_name_a if wins_a > wins_b else (
            model_name_b if wins_b > wins_a else "Tie"
        )

        # SHAP top features for each (re-uses the trained model directly)
        shap_a = self.explain_one(a, top_n=5)
        shap_b = self.explain_one(b, top_n=5)

        return {
            "Phone_A": model_name_a,
            "Price_A": float(phone_a.get("Price_EUR", float("nan"))),
            "Phone_B": model_name_b,
            "Price_B": float(phone_b.get("Price_EUR", float("nan"))),
            "Dimension_Comparison": comparison,
            "Overall_Winner": overall,
            "SHAP_A": [{"feature": f, "shap": v} for f, v in shap_a],
            "SHAP_B": [{"feature": f, "shap": v} for f, v in shap_b],
        }

    # -------- explain a single phone from the pool --------
    def explain_phone(
        self,
        model_name: str,
        top_n: int = 5,
    ) -> List[Tuple[str, float]]:
        """Return SHAP top-|n| (feature, value) pairs for a phone in the pool."""
        pool = self._candidates
        if pool is None:
            raise RuntimeError("No candidates loaded — call load_candidates(csv_path) first.")
        if "Model_Name" not in pool.columns:
            raise RuntimeError("candidates pool has no Model_Name column")
        hits = pool[pool["Model_Name"] == model_name]
        if hits.empty:
            raise ValueError(f"Phone not found: {model_name!r}")
        return self.explain_one(hits.iloc[[0]], top_n=top_n)

    # -------- introspection --------
    def metadata(self) -> Dict[str, Any]:
        return {
            "artifact_dir": str(self.artifact_dir),
            "n_features": len(self.feature_columns),
            "n_categorical_columns": len(self.cat_manager._cats),
            "training_report": self.training_report,
        }
