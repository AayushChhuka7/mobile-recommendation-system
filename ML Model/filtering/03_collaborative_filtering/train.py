"""Train, evaluate, compare, and save the CF recommender.

Run:
    python train.py
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cf_model import (
    EVENT_WEIGHT,
    HOLDOUT_CSV,
    evaluate_ranking,
    evaluate_rating,
    fit_item_cosine,
    fit_svd,
    score_item_cosine,
    score_svd,
    time_split,
    load_interactions,
    build_matrices,
    HAS_IMPLICIT,
)

if HAS_IMPLICIT:
    from cf_model import fit_als, score_als

OUT_DIR = Path(__file__).resolve().parent / "output"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    interactions = load_interactions()
    holdout = pd.read_csv(HOLDOUT_CSV)
    cold_users = set(holdout[holdout["holdout_kind"] == "cold_user"]["customer_id"])
    cold_items = set(holdout[holdout["holdout_kind"] == "cold_phone"]["model_name"])
    print(f"Cold-start users: {len(cold_users)}, cold-start phones: {len(cold_items)}")

    train_df, test_df, cutoff = time_split(interactions)
    print(f"Train: {len(train_df)}, test: {len(test_df)}, cutoff: {cutoff.date()}")

    data = build_matrices(train_df, test_df, cold_users, cold_items)
    sparsity = 1.0 - data.train_csr.nnz / (data.n_users * data.n_items)
    print(f"Matrix: ({data.n_users}, {data.n_items}); nnz={data.train_csr.nnz}; "
          f"sparsity={sparsity * 100:.2f}%")

    # Build test truth — only PURCHASE events count as ground-truth hits.
    # A "view" or "search" in the test window is just browsing noise; we
    # only count items the user actually bought.
    test_users = []
    test_truth: dict[int, set[int]] = {}
    purchase_test = test_df[test_df["interaction_type"] == "purchase"]
    for _, row in purchase_test.iterrows():
        if row["customer_id"] not in data.user_index:
            continue
        if row["model_name"] not in data.item_index:
            continue
        u = data.user_index[row["customer_id"]]
        i = data.item_index[row["model_name"]]
        if u not in test_truth:
            test_truth[u] = set()
            test_users.append(u)
        test_truth[u].add(i)
    print(f"Test users with at least one purchase: {len(test_users)}")

    # Train the three models we want to compare
    print("\n=== Training item-item cosine ===")
    item_sim = fit_item_cosine(data.train_csr)
    print("\n=== Training SVD ===")
    user_factors, item_factors, svd = fit_svd(data.train_csr, n_factors=64)
    print("\n=== Training implicit ALS ===")
    als = fit_als(data.train_csr) if HAS_IMPLICIT else None

    # Per-model evaluation
    K_LIST = [5, 10]
    print("\n=== Generating per-user top-N rankings ===")
    t0 = time.time()
    cosine_top: dict[int, np.ndarray] = {}
    cosine_scores: dict[int, np.ndarray] = {}
    for uid in test_users:
        idx, sc = score_item_cosine(uid, item_sim, data.train_csr, top_n=200)
        cosine_top[uid] = idx
        cosine_scores[uid] = sc
    print(f"  cosine: {time.time() - t0:.1f}s")

    t0 = time.time()
    svd_top: dict[int, np.ndarray] = {}
    svd_scores: dict[int, np.ndarray] = {}
    for uid in test_users:
        idx, sc = score_svd(uid, user_factors, item_factors, data.train_csr, top_n=200)
        svd_top[uid] = idx
        svd_scores[uid] = sc
    print(f"  svd:    {time.time() - t0:.1f}s")

    als_top: dict[int, np.ndarray] = {}
    als_scores: dict[int, np.ndarray] = {}
    if als is not None:
        t0 = time.time()
        for uid in test_users:
            idx, sc = score_als(uid, als, data.train_csr, top_n=200)
            als_top[uid] = idx
            als_scores[uid] = sc
        print(f"  als:    {time.time() - t0:.1f}s")

    # Hybrid: SVD + cosine (average z-scores per-user)
    print("  building hybrid (SVD + cosine) …")
    hybrid_top: dict[int, np.ndarray] = {}
    for uid in test_users:
        # We need full per-user scores, not just top-200
        a = svd_scores[uid]  # top-200 scores for SVD
        b = cosine_scores[uid]  # top-200 scores for cosine
        # Pad to full n_items using seen-vs-unseen logic
        # For simplicity in the eval table, we'll combine the top-200
        # candidates from SVD with cosine-based re-ranking
        svd_candidates = set(svd_top[uid].tolist())
        cosine_candidates = set(cosine_top[uid].tolist())
        all_cands = list(svd_candidates | cosine_candidates)

        # Build per-user score map for both
        svd_score_map = {i: s for i, s in zip(svd_top[uid], svd_scores[uid])}
        cos_score_map = {i: s for i, s in zip(cosine_top[uid], cosine_scores[uid])}

        def zscore_dict(score_map, candidates):
            vals = np.array([score_map.get(c, 0.0) for c in candidates])
            sd = np.std(vals)
            if sd < 1e-9:
                return {c: 0.0 for c in candidates}
            mean = np.mean(vals)
            return {c: (score_map.get(c, mean) - mean) / sd for c in candidates}

        z_svd = zscore_dict(svd_score_map, all_cands)
        z_cos = zscore_dict(cos_score_map, all_cands)

        combined_scores = []
        for c in all_cands:
            combined_scores.append((c, 0.7 * z_svd[c] + 0.3 * z_cos[c]))
        combined_scores.sort(key=lambda kv: -kv[1])
        hybrid_top[uid] = np.array([c for c, _ in combined_scores[:200]], dtype=np.int64)

    results = {}
    print("\n=== Evaluation table ===")
    for name, preds in [("item-item cosine", cosine_top), ("SVD", svd_top)] + (
        [("implicit ALS", als_top)] if als_top else []
    ) + [("SVD+Cosine hybrid", hybrid_top)]:
        m = {}
        for k in K_LIST:
            m.update(evaluate_ranking(preds, test_users, test_truth, k))
        # RMSE/MAE: only meaningful for SVD (which produces ratings)
        if name == "SVD":
            # Build a predicted-rating sparse matrix from SVD factors
            pred_full = user_factors.dot(item_factors.T)
            from scipy.sparse import csr_matrix
            pred_csr = csr_matrix(pred_full)
            m.update(evaluate_rating(pred_csr, test_df, data.user_index, data.item_index))
        results[name] = m
        print(f"  {name}: {m}")

    # Pick the winner (highest NDCG@10) for the final hybrid
    winner = max(results, key=lambda k: results[k].get("ndcg@10", 0))
    print(f"\nWinner by NDCG@10: {winner}")

    # Save the eval table
    eval_df = pd.DataFrame(results).T
    eval_df.to_csv(OUT_DIR / "model_comparison.csv")
    with open(OUT_DIR / "model_comparison.json", "w") as f:
        json.dump(results, f, indent=2, default=float)
    print(f"Saved {OUT_DIR / 'model_comparison.csv'} and .json")


if __name__ == "__main__":
    main()