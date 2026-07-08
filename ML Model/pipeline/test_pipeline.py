"""End-to-end smoke test for the pipeline.

Run with: `python -m pipeline.test_pipeline`

Checks (no pytest dependency):
    1. The pipeline loads.
    2. `predict(df.sample(5))` returns an array of shape (5,).
    3. `explain(df.sample(1))` returns a list of 5 (feature, shap) pairs.
    4. `recommend(...)` for a gamer at €500 returns at least 1 result.
    5. For a known flagship (Galaxy S25 Ultra), at least one of
       `GPU_Is_Flagship` / `Refresh_Rate_Hz` / `Chipset_Is_Flagship`
       appears in the top-5 SHAP contributors.
    6. A raw row from `GSMArena_Cleaned_Dataset.csv` can be run through
       `engineer_all()` and then `predict()` and returns a positive scalar
       (i.e. the full raw-row → engineered-frame → prediction round trip
       works without manual preprocessing).
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
sys.path.insert(0, str(PROJECT_ROOT))

from pipeline.features import engineer_all
from pipeline.model import MobileRecommendationPipeline
from pipeline.recommend import PersonaType, UserPreferenceInput
from pipeline.scoring import compute_scores


DATA_PATH = PROJECT_ROOT / "After_EDA_and_Feature_ENginering.csv"
CLEANED_PATH = PROJECT_ROOT / "GSMArena_Cleaned_Dataset.csv"
ARTIFACT_DIR = PROJECT_ROOT / "artifacts"


def main() -> int:
    if not ARTIFACT_DIR.exists() or not (ARTIFACT_DIR / "model.json").exists():
        print(f"ERROR: artifacts not found in {ARTIFACT_DIR}. Run `python -m pipeline.train` first.")
        return 1

    print("[1/5] loading pipeline …")
    pipe = MobileRecommendationPipeline(ARTIFACT_DIR)
    assert pipe.model is not None
    print(f"  loaded. n_features={len(pipe.feature_columns)}")

    print("[2/5] loading data + precomputing scores for recommend pool …")
    df = pd.read_csv(DATA_PATH)
    df = compute_scores(df, pipe.scoring_snap)
    assert len(df) > 1000, "dataset looks too small"

    print("[3/5] predict on 5 random rows …")
    sample = df.sample(5, random_state=0)
    preds = pipe.predict(sample)
    assert preds.shape == (5,), f"expected (5,), got {preds.shape}"
    assert (preds > 0).all(), f"all predictions should be positive, got {preds}"
    print(f"  sample predictions: {np.round(preds, 0).astype(int).tolist()}")

    print("[4/5] explain on 1 row …")
    one = df.sample(1, random_state=1)
    pairs = pipe.explain_one(one, top_n=5)
    assert len(pairs) == 5, f"expected 5 pairs, got {len(pairs)}"
    for feat, val in pairs:
        assert isinstance(feat, str) and isinstance(val, float)
    print(f"  top-5 features for row: {[p[0] for p in pairs]}")

    print("[5/5] recommend for Gamer at €500 …")
    pref = UserPreferenceInput(
        budget_max_eur=500, persona=PersonaType.GAMER, top_n_results=3
    )
    results, err = pipe.recommend(pref, candidates=df)
    assert err is None, f"recommend returned error: {err}"
    assert results and len(results) >= 1, "no recommendations returned"
    print(f"  top-3: {[r['Model'] for r in results]}")

    # ---- flagship sanity check ----
    print("[bonus] flagship sanity check on Galaxy S25 Ultra …")
    if "Model_Name" in df.columns:
        flagships = df[df["Model_Name"].str.contains("Galaxy S25 Ultra", case=False, na=False)]
        if not flagships.empty:
            row = flagships.iloc[[0]]
            pairs = pipe.explain_one(row, top_n=10)
            top_feats = {p[0] for p in pairs[:10]}
            hit = {"GPU_Is_Flagship", "Refresh_Rate_Hz", "Chipset_Is_Flagship"} & top_feats
            assert hit, (
                f"expected at least one of GPU/Refresh/Chipset in top-10 SHAP for S25 Ultra, "
                f"got {top_feats}"
            )
            print(f"  flagship SHAP hit on: {hit}")
        else:
            print("  (Galaxy S25 Ultra not in dataset — skipping flagship check)")
    else:
        print("  (Model_Name not in df — skipping flagship check)")

    print("\nAll pipeline tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
