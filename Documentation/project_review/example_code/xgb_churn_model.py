"""
xgb_churn_model.py
Reference implementation for xgboost_ideas/04_churn_prediction.md.

Predicts whether a customer will churn (no purchase in next 90 days).
Uses scale_pos_weight to handle the heavy class imbalance.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import average_precision_score, classification_report, roc_auc_score
from sklearn.model_selection import train_test_split


def build_features(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    """Required columns:
       customer_id, last_purchase_date, n_purchases, avg_spend_npr,
       n_wishlist_items, support_tickets_90d, churned (target).
    """
    X = df[
        ["n_purchases", "avg_spend_npr", "n_wishlist_items",
         "support_tickets_90d", "days_since_last_purchase"]
    ].copy()
    y = df["churned"].astype(int)
    return X, y


def train(df: pd.DataFrame, seed: int = 42) -> tuple[xgb.XGBClassifier, dict]:
    X, y = build_features(df)
    X_tr, X_te, y_tr, y_te = train_test_split(
        X, y, test_size=0.2, random_state=seed, stratify=y
    )

    pos_w = (y_tr == 0).sum() / max(1, (y_tr == 1).sum())
    clf = xgb.XGBClassifier(
        objective="binary:logistic",
        eval_metric="aucpr",
        max_depth=4,
        n_estimators=250,
        learning_rate=0.05,
        scale_pos_weight=pos_w,
        random_state=seed,
    )
    clf.fit(X_tr, y_tr, eval_set=[(X_te, y_te)], verbose=False)
    proba = clf.predict_proba(X_te)[:, 1]
    return clf, {
        "auc": float(roc_auc_score(y_te, proba)),
        "ap": float(average_precision_score(y_te, proba)),
        "report": classification_report(y_te, (proba > 0.5).astype(int), output_dict=True),
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--train-csv", required=True, type=Path)
    p.add_argument("--model-out", required=True, type=Path)
    args = p.parse_args()

    df = pd.read_csv(args.train_csv)
    clf, metrics = train(df)
    args.model_out.parent.mkdir(parents=True, exist_ok=True)
    clf.save_model(args.model_out)
    (args.model_out.with_suffix(".metrics.json")).write_text(json.dumps(metrics, indent=2))
    print(f"AUC = {metrics['auc']:.3f}; AP = {metrics['ap']:.3f}")


if __name__ == "__main__":
    main()