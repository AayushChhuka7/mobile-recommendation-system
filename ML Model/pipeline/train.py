"""Train the XGBoost AnTuTu-Score regressor and serialize all artifacts.

Run with: `python -m pipeline.train`
Outputs to: `artifacts/`

Reuses cell 107's exact training config:
    XGBRegressor(
        enable_categorical=True, tree_method='hist',
        max_depth=6, n_estimators=300, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, reg_lambda=2.0, random_state=42
    )
Target = log1p(AnTuTu_Score).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import List, Tuple

import numpy as np
import pandas as pd
from sklearn.model_selection import KFold, cross_val_score, train_test_split
from sklearn.metrics import mean_absolute_error, r2_score
import xgboost as xgb

from .model import CategoricalDtypeManager
from .scoring import ScoringSnapshot


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------
HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
DATA_PATH = PROJECT_ROOT / "After_EDA_and_Feature_ENginering.csv"
ARTIFACT_DIR = PROJECT_ROOT / "artifacts"

# columns explicitly dropped from X (verbatim from cell 107)
DROP_COLS = [
    "AnTuTu_Score", "AnTuTu_Score_is_imputed", "Model_Name", "Model_URL",
    "Model_Image", "AnTuTu_Score_Source",
]


def _build_X(df: pd.DataFrame) -> Tuple[pd.DataFrame, List[str], CategoricalDtypeManager]:
    """Build X from the cleaned df, dropping target + identifiers + provenance.

    Returns (X, feature_columns, cat_manager).
    """
    X = df.drop(columns=[c for c in DROP_COLS if c in df.columns])

    # cast object/string columns to pandas category, but track them
    cat_cols: List[str] = []
    for c in X.select_dtypes(include=["object", "string"]).columns:
        X[c] = X[c].astype("string").fillna("__nan__")
        cat_cols.append(c)
    # numeric bool columns: keep as-is
    for c in X.select_dtypes(include=["bool"]).columns:
        X[c] = X[c].astype(int)

    # drop leftover provenance columns (any *_Source / *_is_imputed still around)
    provenance = [c for c in X.columns if c.endswith("_Source") or c.endswith("_is_imputed")]
    X = X.drop(columns=provenance)

    # freeze the category lists from the full training matrix
    cat_manager = CategoricalDtypeManager.from_dataframe(X, cat_cols)
    X = cat_manager.transform(X)

    feature_columns = list(X.columns)
    return X, feature_columns, cat_manager


def main() -> int:
    if not DATA_PATH.exists():
        print(f"ERROR: data file not found: {DATA_PATH}", file=sys.stderr)
        return 1

    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Loading {DATA_PATH} …")
    df = pd.read_csv(DATA_PATH)
    print(f"  total rows: {len(df)}")

    # only train on rows with real AnTuTu (matches cell 107)
    if "AnTuTu_Score_is_imputed" in df.columns:
        df_model = df[df["AnTuTu_Score_is_imputed"] == False].copy()  # noqa: E712
        print(f"  after dropping imputed AnTuTu rows: {len(df_model)}")
    else:
        df_model = df.copy()

    print("Building X …")
    X, feature_columns, cat_manager = _build_X(df_model)
    y = np.log1p(df_model["AnTuTu_Score"])
    print(f"  X.shape={X.shape}, n_features={len(feature_columns)}")

    # train/test split
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    )

    # XGBoost (cell 107 config)
    print("Training XGBoost (max_depth=6, n_estimators=300, lr=0.05) …")
    model = xgb.XGBRegressor(
        enable_categorical=True,
        tree_method="hist",
        max_depth=6,
        n_estimators=300,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        reg_lambda=2.0,
        random_state=42,
    )
    model.fit(X_train, y_train)

    train_r2 = float(r2_score(y_train, model.predict(X_train)))
    test_r2 = float(r2_score(y_test, model.predict(X_test)))
    test_mae_log = float(mean_absolute_error(y_test, model.predict(X_test)))
    print(f"  Train R² = {train_r2:.4f}")
    print(f"  Test  R² = {test_r2:.4f}")
    print(f"  Test  MAE (log-space) = {test_mae_log:.4f}")

    # 5-fold CV
    print("Running 5-fold cross-validation …")
    kf = KFold(n_splits=5, shuffle=True, random_state=42)
    cv_scores = cross_val_score(model, X, y, cv=kf, scoring="r2")
    cv_mean = float(cv_scores.mean())
    cv_std = float(cv_scores.std())
    print(f"  CV R² = {cv_mean:.4f} ± {cv_std:.4f}  (per fold: {np.round(cv_scores, 4)})")

    # ------ save artifacts ------
    print(f"Saving artifacts to {ARTIFACT_DIR} …")
    model.save_model(str(ARTIFACT_DIR / "model.json"))
    (ARTIFACT_DIR / "feature_columns.json").write_text(
        json.dumps(feature_columns, indent=2), encoding="utf-8"
    )
    (ARTIFACT_DIR / "category_dtypes.json").write_text(
        json.dumps(cat_manager.to_dict(), indent=2), encoding="utf-8"
    )

    snap = ScoringSnapshot.from_dataframe(df_model)
    (ARTIFACT_DIR / "scoring_snapshot.json").write_text(snap.to_json(), encoding="utf-8")

    report = {
        "model_config": {
            "max_depth": 6, "n_estimators": 300, "learning_rate": 0.05,
            "subsample": 0.8, "colsample_bytree": 0.8, "reg_lambda": 2.0,
            "random_state": 42, "tree_method": "hist",
        },
        "n_train": int(len(X_train)),
        "n_test": int(len(X_test)),
        "n_features": len(feature_columns),
        "n_categorical_columns": len(cat_manager._cats),
        "train_r2": train_r2,
        "test_r2": test_r2,
        "test_mae_log": test_mae_log,
        "cv_r2_mean": cv_mean,
        "cv_r2_std": cv_std,
        "cv_r2_folds": [float(x) for x in cv_scores],
    }
    (ARTIFACT_DIR / "training_report.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )

    print("Done.")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
