"""Train the final CF recommender and save the artifact.

Run:
    python fit.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cf_model import (
    CFRecommender,
    HOLDOUT_CSV,
    train,
)
import pandas as pd

OUT_DIR = Path(__file__).resolve().parent / "output"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    holdout = pd.read_csv(HOLDOUT_CSV)
    cold_users = set(holdout[holdout["holdout_kind"] == "cold_user"]["customer_id"])
    cold_items = set(holdout[holdout["holdout_kind"] == "cold_phone"]["model_name"])
    print(f"Cold-start users: {len(cold_users)}, cold-start phones: {len(cold_items)}")

    rec = train(cold_users, cold_items)
    rec.save(OUT_DIR)
    print(f"Saved artefact to {OUT_DIR}")

    # Smoke test the public API
    print("\n=== Smoke test: get_recommendations for 3 users ===")
    test_users = ["CUST-000EFD69", "CUST-00415B2B"]
    for cid in test_users:
        out = rec.get_recommendations(cid, top_n=5)
        print(f"\n{cid}:")
        for r in out:
            print(f"  {r['model_name']:35s}  score={r['score']:.3f}  reason={r['reason']}")

    # And one cold-start user
    if cold_users:
        cs_user = list(cold_users)[0]
        print(f"\nCold-start user {cs_user}:")
        out = rec.get_recommendations(cs_user, top_n=5)
        for r in out:
            print(f"  {r['model_name']:35s}  score={r['score']:.3f}  reason={r['reason']}")


if __name__ == "__main__":
    main()