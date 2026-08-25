"""train_fusion_weights.py — Fix #3.

Weekly job that refits FUSION_WEIGHTS from the last N days of
labelled impressions. Writes a JSON artifact that the BE reads on
cold start (and on file-watch hot-reload).

Writes: ML Model/artifacts/fusion_weights.json

Shape:
{
  "version": "2026-08-13",
  "weights": {
    "compatibility":       0.30,
    "customer_preference": 0.31,
    "content_similarity":  0.18,
    "search_history":      0.08,
    "value":               0.10,
    "freshness_trending":  0.03
  },
  "training_rows": 12453,
  "ctr": 0.012,
  "feature_cols": [...]
}

Filters:
  - is_training_eligible = true
  - label_clicked is not NULL (we wait the observation window)
  - user has at least MIN_USER_IMPRESSIONS impressions
  - exploration_arm IS NULL (Fix #6 conflict)
  - source = 'click' OR (source = 'auto' AND is_training_eligible = true)
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold

HERE = Path(__file__).resolve().parent
ARTIFACT = HERE.parent / "artifacts" / "fusion_weights.json"

FEATURE_COLS: List[str] = [
    "s_compatibility",
    "s_customer_pref",
    "s_content_sim",
    "s_search_history",
    "s_value",
    # 6th slot — Fix #9. Include only if the column exists in the
    # training frame (pre-fix impressions don't have it).
    "s_freshness",
]
MIN_USER_IMPRESSIONS = 3
DEFAULT_LOOKBACK_DAYS = 30
MIN_TRAINING_ROWS = 5_000


def fetch_training_set(db_url: str, lookback_days: int) -> pd.DataFrame:
    """Read labelled, eligible impressions from the training_impressions
    table (Fix #3 schema).

    The table is populated by a separate nightly ETL job (see
    docs/training-etl.md, not yet written) that materialises one row
    per (user, phone, requestId) with its label resolved after the
    7-day observation window. We don't read recommendation_logs
    directly here because:
      - it doesn't carry the (s_*) sub-score columns
      - it's still being written to (live traffic)
    """
    import sqlalchemy as sa

    eng = sa.create_engine(db_url)
    cutoff = dt.datetime.utcnow() - dt.timedelta(days=lookback_days)
    sql = """
      SELECT *
      FROM training_impressions
      WHERE observed_at >= %(cutoff)s
        AND is_training_eligible = true
        AND label_clicked IS NOT NULL
        AND exploration_arm IS NULL
        AND (source = 'auto' OR source IS NULL)
    """
    df = pd.read_sql(sql, eng, params={"cutoff": cutoff})
    user_counts = df.groupby("user_id").size()
    keep_users = user_counts[user_counts >= MIN_USER_IMPRESSIONS].index
    return df[df.user_id.isin(keep_users)].copy()


def fit_logreg(df: pd.DataFrame) -> Dict[str, float]:
    """Group K-fold by user_id so we don't leak user-level signal
    into the validation fold. Returns the *average* coefficients
    across folds, normalised so they sum to 1.0 (the rank order is
    what matters, not the absolute magnitudes — and the BE expects
    weights that sum to 1.0).
    """
    cols = [c for c in FEATURE_COLS if c in df.columns]
    X = df[cols].fillna(0).to_numpy(dtype=np.float64)
    pos = df["position"].clip(lower=0).to_numpy(dtype=np.float64)
    sample_weight = 1.0 / np.log2(pos + 2)  # rank-dampened
    y = df["label_clicked"].astype(int).to_numpy(dtype=np.int64)

    gkf = GroupKFold(n_splits=5)
    coef_sum = np.zeros(len(cols), dtype=np.float64)
    fold_count = 0
    for train_idx, _ in gkf.split(X, y, groups=df["user_id"].to_numpy()):
        m = LogisticRegression(max_iter=200, C=1.0, solver="lbfgs")
        m.fit(
            X[train_idx], y[train_idx],
            sample_weight=sample_weight[train_idx],
        )
        coef_sum += m.coef_[0]
        fold_count += 1
    avg = coef_sum / max(1, fold_count)

    weights = {c: float(v) for c, v in zip(cols, avg)}
    s = sum(max(0, v) for v in weights.values()) or 1.0
    return {k: max(0.0, v) / s for k, v in weights.items()}


def write_artifact(weights: Dict[str, float], df: pd.DataFrame) -> None:
    payload = {
        "version": dt.date.today().isoformat(),
        "weights": weights,
        "training_rows": int(len(df)),
        "ctr": float(df["label_clicked"].mean()),
        "feature_cols": list(weights.keys()),
    }
    ARTIFACT.parent.mkdir(parents=True, exist_ok=True)
    ARTIFACT.write_text(json.dumps(payload, indent=2))
    print(f"wrote {ARTIFACT}: {payload}", flush=True)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--db-url", required=True, help="postgresql://...")
    p.add_argument("--lookback-days", type=int, default=DEFAULT_LOOKBACK_DAYS)
    p.add_argument("--min-rows", type=int, default=MIN_TRAINING_ROWS)
    args = p.parse_args()

    print(f"[train] loading training set (lookback={args.lookback_days}d)…", flush=True)
    df = fetch_training_set(args.db_url, args.lookback_days)
    print(f"[train] {len(df)} rows eligible", flush=True)

    if len(df) < args.min_rows:
        # Don't refit on a tiny sample. Stale weights are better
        # than overfit weights.
        print(
            f"[train] only {len(df)} rows (< {args.min_rows}); "
            "skipping refit",
            flush=True,
        )
        return 0

    weights = fit_logreg(df)
    write_artifact(weights, df)
    return 0


if __name__ == "__main__":
    sys.exit(main())
