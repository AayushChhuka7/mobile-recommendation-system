"""
xgb_brand_loyalty_classifier.py
Reference implementation for xgboost_ideas/01_brand_loyalty_classifier.md.

Predicts whether a customer is brand-loyal (1) or switcher (0) based on
their purchase history features.

Usage:
    python xgb_brand_loyalty_classifier.py \
        --train-csv path/to/After_EDA.csv \
        --model-out models/loyalty_v1.json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
import shap
import xgboost as xgb
from sklearn.metrics import classification_report, roc_auc_score
from sklearn.model_selection import train_test_split


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    """Construct per-customer features.

    Required columns in df:
      - customer_id, mobile_brand_purchased, purchase_date, price_npr
    """
    out = df.groupby("customer_id").agg(
        n_purchases=("mobile_brand_purchased", "count"),
        n_distinct_brands=("mobile_brand_purchased", "nunique"),
        avg_spend_npr=("price_npr", "mean"),
        max_spend_npr=("price_npr", "max"),
    )
    out["dominant_brand_share"] = (
        df.groupby("customer_id")["mobile_brand_purchased"]
        .agg(lambda s: s.value_counts(normalize=True).iloc[0])
    )
    # Target: loyal = bought >= 3 phones, all from one brand
    out["loyal"] = ((out["n_purchases"] >= 3) & (out["n_distinct_brands"] == 1)).astype(int)
    return out.reset_index()


def train(df: pd.DataFrame, seed: int = 42) -> tuple[xgb.XGBClassifier, dict]:
    feats = build_features(df)
    y = feats["loyal"]
    X = feats.drop(columns=["customer_id", "loyal"])

    X_tr, X_te, y_tr, y_te = train_test_split(
        X, y, test_size=0.2, random_state=seed, stratify=y
    )

    clf = xgb.XGBClassifier(
        objective="binary:logistic",
        eval_metric="auc",
        enable_categorical=True,
        max_depth=4,
        n_estimators=200,
        learning_rate=0.05,
        scale_pos_weight=(y_tr == 0).sum() / max(1, (y_tr == 1).sum()),
        random_state=seed,
    )
    clf.fit(X_tr, y_tr, eval_set=[(X_te, y_te)], verbose=False)

    proba = clf.predict_proba(X_te)[:, 1]
    auc = roc_auc_score(y_te, proba)
    report = classification_report(y_te, (proba > 0.5).astype(int), output_dict=True)

    return clf, {"auc": float(auc), "report": report, "n_train": int(len(X_tr))}


def explain(clf: xgb.XGBClassifier, X: pd.DataFrame, out_path: Path) -> None:
    explainer = shap.TreeExplainer(clf)
    shap_values = explainer.shap_values(X)
    shap.summary_plot(shap_values, X, show=False)
    import matplotlib.pyplot as plt

    plt.tight_layout()
    plt.savefig(out_path, dpi=120, bbox_inches="tight")
    plt.close()


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--train-csv", required=True, type=Path)
    p.add_argument("--model-out", required=True, type=Path)
    p.add_argument("--shap-out", type=Path, default=None)
    args = p.parse_args()

    df = pd.read_csv(args.train_csv)
    clf, metrics = train(df)
    args.model_out.parent.mkdir(parents=True, exist_ok=True)
    clf.save_model(args.model_out)
    metrics_path = args.model_out.with_suffix(".metrics.json")
    metrics_path.write_text(json.dumps(metrics, indent=2))
    print(f"AUC = {metrics['auc']:.3f}; saved -> {args.model_out}")

    if args.shap_out:
        explain(clf, df, args.shap_out)


if __name__ == "__main__":
    main()