"""
xgb_camera_tier.py
Reference implementation for xgboost_ideas/02_camera_tier_classifier.md.

Classifies a phone into one of {Entry, Mid, Flagship, Ultra} based on
its camera specs. Multi-class with softprob.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import classification_report, top_k_accuracy_score
from sklearn.model_selection import train_test_split

TIERS = ["Entry", "Mid", "Flagship", "Ultra"]


def build_features(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    """Assumes df has columns:
       rear_mp, front_mp, sensor_size_in, has_ois, aperture_f,
       video_max_fps, tier (target)."""
    X = df[
        ["rear_mp", "front_mp", "sensor_size_in", "has_ois",
         "aperture_f", "video_max_fps"]
    ].copy()
    y = df["tier"].astype("category").cat.codes
    return X, y


def train(df: pd.DataFrame, seed: int = 42) -> tuple[xgb.XGBClassifier, dict]:
    X, y = build_features(df)
    X_tr, X_te, y_tr, y_te = train_test_split(
        X, y, test_size=0.2, random_state=seed, stratify=y
    )

    clf = xgb.XGBClassifier(
        objective="multi:softprob",
        num_class=len(TIERS),
        eval_metric="mlogloss",
        max_depth=5,
        n_estimators=300,
        learning_rate=0.05,
        random_state=seed,
    )
    clf.fit(X_tr, y_tr, eval_set=[(X_te, y_te)], verbose=False)
    proba = clf.predict_proba(X_te)
    pred = np.argmax(proba, axis=1)

    return clf, {
        "top1_acc": float((pred == y_te).mean()),
        "top2_acc": float(top_k_accuracy_score(y_te, proba, k=2)),
        "report": classification_report(y_te, pred, target_names=TIERS, output_dict=True),
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
    print(f"Top-1 = {metrics['top1_acc']:.3f}; Top-2 = {metrics['top2_acc']:.3f}")


if __name__ == "__main__":
    main()