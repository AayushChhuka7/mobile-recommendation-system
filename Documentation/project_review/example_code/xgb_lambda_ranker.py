"""
xgb_lambda_ranker.py
Reference implementation for xgboost_ideas/06_lambda_ranker.md.

Trains an XGBRanker (LambdaMART) on the rec_log feature table.
Each query = one recommendation session (one rec_id).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import ndcg_score


FEATURES = [
    "persona_match_score",       # computed by persona-weights step
    "brand_loyalty_proba",       # output of xgb_brand_loyalty_classifier.py
    "camera_tier_proba",         # output of xgb_camera_tier.py
    "antutu_pred",               # output of the existing XGBoost regressor
    "value_score",               # spec_to_score / price
    "days_since_release",        # novelty
    "wishlist_match",            # 0/1 if user has this phone on wishlist
    "segment_match_score",       # segment similarity to user
]


def train(df: pd.DataFrame, seed: int = 42) -> tuple[xgb.XGBRanker, dict]:
    """`df` is a flat table with columns: rec_id, mobile_id, label, plus FEATURES."""
    df = df.sort_values("rec_id").reset_index(drop=True)

    # Build group sizes (one query = one rec_id)
    group_sizes = df.groupby("rec_id").size().tolist()

    X = df[FEATURES].astype(float).values
    y = df["label"].astype(int).values  # 0 = ignore, 1 = click, 3 = wish, 5 = purchase

    ranker = xgb.XGBRanker(
        objective="rank:pairwise",
        learning_rate=0.05,
        max_depth=6,
        n_estimators=300,
        random_state=seed,
        eval_metric="ndcg@10",
    )
    ranker.fit(X, y, group=group_sizes)

    # Eval: rebuild per-session matrices and compute NDCG@10
    pred = ranker.predict(X)
    ndcgs = []
    start = 0
    for size in group_sizes:
        if size < 2:
            start += size
            continue
        true_rel = y[start:start + size].reshape(1, -1)
        scores = pred[start:start + size].reshape(1, -1)
        ndcgs.append(ndcg_score(true_rel, scores, k=10))
        start += size

    return ranker, {"ndcg_at_10_mean": float(np.mean(ndcgs)), "n_sessions": len(group_sizes)}


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--train-parquet", required=True, type=Path,
                   help="Output of mv_user_rec_ltr materialised view.")
    p.add_argument("--model-out", required=True, type=Path)
    args = p.parse_args()

    df = pd.read_parquet(args.train_parquet)
    ranker, metrics = train(df)
    args.model_out.parent.mkdir(parents=True, exist_ok=True)
    ranker.save_model(args.model_out)
    (args.model_out.with_suffix(".metrics.json")).write_text(json.dumps(metrics, indent=2))
    print(f"NDCG@10 = {metrics['ndcg_at_10_mean']:.3f} over {metrics['n_sessions']} sessions")


if __name__ == "__main__":
    main()