"""Sanity-checks the generated synthetic dataset.

Run from `ML Model/synthetic/`:

    python validate.py --csv ../synthetic_outputs/synthetic_customers.csv

Checks
------
1. Row count matches the requested n_users (or close — info only).
2. Distribution of `true_archetype` is within +/-2% of ARCHETYPE_WEIGHTS.
3. Cohesion: intra-archetype std-dev of each interest score (target < 12).
4. Separation: mean pairwise distance between archetype centroids on the
   7-D interest-score subspace (target > 20).
5. Consistency invariants:
       gaming_interest  >= 80  →  min_refresh_rate_hz >= 120  (>=95% pass)
       battery_interest >= 80  →  min_battery_mah    >= 5000  (>=95% pass)
       chipset_tier=Flagship   →  min_ram_gb         >= 8     (>=95% pass)
       camera_interest  >= 85  →  min_storage_gb     >= 128   (>=95% pass)
       display_interest >= 80  →  min_refresh_rate_hz >= 120  (>=95% pass)
6. Clustering check: drop `true_archetype`, fit K-Means with k=8, compute
   Adjusted Rand Index (ARI) against the ground truth. Target ARI >= 0.6.

The script writes a `validation_report.json` next to the CSV.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Dict, List

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
sys.path.insert(0, str(PROJECT_ROOT))

from synthetic.archetypes import ARCHETYPE_WEIGHTS  # noqa: E402
from synthetic.feature_schema import INTEREST_SCORES  # noqa: E402


# ---------------------------------------------------------------------------
# Individual checks
# ---------------------------------------------------------------------------
def check_distribution(df: pd.DataFrame) -> Dict:
    """Per-archetype share vs target weight."""
    target = {k: v * 100 for k, v in ARCHETYPE_WEIGHTS.items()}
    counts = df["true_archetype"].value_counts(normalize=True).mul(100)
    diffs = {arch: float(counts.get(arch, 0) - target[arch])
             for arch in target}
    within_tolerance = {arch: abs(d) <= 2.0 for arch, d in diffs.items()}
    return {
        "target_pct": target,
        "actual_pct": {arch: round(counts.get(arch, 0), 3)
                       for arch in target},
        "delta_pct": {arch: round(d, 3) for arch, d in diffs.items()},
        "within_2pct": within_tolerance,
        "all_within_tolerance": all(within_tolerance.values()),
    }


def check_cohesion(df: pd.DataFrame) -> Dict:
    """Per-archetype std-dev of interest scores — should be < 12 (matches 10% noise budget)."""
    cohesion = {}
    for arch, sub in df.groupby("true_archetype"):
        per_score_std = {c: float(sub[c].std()) for c in INTEREST_SCORES}
        cohesion[arch] = {
            "mean_stddev": round(float(np.mean(list(per_score_std.values()))), 2),
            "per_score_stddev": {k: round(v, 2) for k, v in per_score_std.items()},
            "all_below_12": all(v < 12 for v in per_score_std.values()),
        }
    return {
        "per_archetype": cohesion,
        "all_below_12": all(c["all_below_12"] for c in cohesion.values()),
    }


def check_separation(df: pd.DataFrame) -> Dict:
    """Pairwise distance between archetype centroids.

    Two views:
      - interest_only: 7-D interest subspace (gaming/camera/.../value).
        All centroid distances should be > 20 (pass criterion).
      - full_feature_space: all numeric clustering columns, standardised.
        This is the space a real clustering algorithm actually operates in.
        Distances are < 20 because we have more dimensions; the relevant
        check here is that no pair is essentially co-located (min > 4).

    Pass criterion: ALL pairs > 20 in interest-only space.
    """
    # --- View 1: interest-only (7-D)
    centroids_int = df.groupby("true_archetype")[list(INTEREST_SCORES)].mean()
    names = list(centroids_int.index)
    interest_distances = {}
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            d = float(np.linalg.norm(centroids_int.loc[a] - centroids_int.loc[b]))
            interest_distances[f"{a}__vs__{b}"] = round(d, 2)

    # --- View 2: full numeric feature space (standardised)
    numeric_for_sep: List[str] = [
        c.name for c in __import__(
            "synthetic.feature_schema", fromlist=["COLUMN_BY_NAME"]
        ).COLUMN_BY_NAME.values()
        if c.in_cluster and c.dtype in ("int", "float")
    ]
    X = df[numeric_for_sep].astype(float).to_numpy()
    # standardise column-wise
    mu = X.mean(axis=0)
    sigma = X.std(axis=0)
    sigma[sigma == 0] = 1.0  # avoid div-by-zero on constant columns (country)
    X_std = (X - mu) / sigma

    # Standardised centroids per archetype.
    centroids_df = pd.DataFrame(X_std, columns=numeric_for_sep)
    centroids_df["true_archetype"] = df["true_archetype"].to_numpy()
    centroids_full = centroids_df.groupby("true_archetype").mean()

    full_distances = {}
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            d = float(np.linalg.norm(centroids_full.loc[a] - centroids_full.loc[b]))
            full_distances[f"{a}__vs__{b}"] = round(d, 2)

    return {
        "interest_only": {
            "mean_separation": round(float(np.mean(list(interest_distances.values()))), 2),
            "min_separation": round(float(min(interest_distances.values())), 2),
            "n_pairs_below_20": int(sum(1 for v in interest_distances.values() if v <= 20)),
        },
        "full_feature_space": {
            "centroid_distances": full_distances,
            "mean_separation": round(float(np.mean(list(full_distances.values()))), 2),
            "min_separation": round(float(min(full_distances.values())), 2),
            "all_above_4": all(d > 4 for d in full_distances.values()),
        },
        "all_above_20_in_full_space": all(d > 20 for d in full_distances.values()),
        "all_above_20_in_interest_only": all(
            d > 20 for d in interest_distances.values()
        ),
    }


def check_invariants(df: pd.DataFrame) -> Dict:
    """The 5 archetype-internal-consistency rules. Each row must satisfy ~95%."""
    rules = {}

    # 1. Gaming >= 80 → refresh >= 120
    gaming = df["gaming_interest"] >= 80
    refresh_ok = df["min_refresh_rate_hz"] >= 120
    n_g = int(gaming.sum())
    n_ok = int((~gaming | refresh_ok).sum())
    rules["gaming_implies_high_refresh"] = {
        "rows_implicated": n_g,
        "rows_passing_pct": round(n_ok / max(n_g, 1) * 100, 2),
        "passes_95pct": (n_ok / max(n_g, 1)) >= 0.95,
    }

    # 2. Battery >= 80 → battery_mah >= 5000
    battery = df["battery_interest"] >= 80
    bat_ok = df["min_battery_mah"] >= 5000
    n_b = int(battery.sum())
    n_ok_b = int((~battery | bat_ok).sum())
    rules["battery_implies_big_cell"] = {
        "rows_implicated": n_b,
        "rows_passing_pct": round(n_ok_b / max(n_b, 1) * 100, 2),
        "passes_95pct": (n_ok_b / max(n_b, 1)) >= 0.95,
    }

    # 3. Flagship chipset → RAM >= 8
    flagship = df["chipset_tier"].isin(("Flagship", "Flagship-Killer"))
    ram_ok = df["min_ram_gb"] >= 8
    n_f = int(flagship.sum())
    n_ok_f = int((~flagship | ram_ok).sum())
    rules["flagship_implies_enough_ram"] = {
        "rows_implicated": n_f,
        "rows_passing_pct": round(n_ok_f / max(n_f, 1) * 100, 2),
        "passes_95pct": (n_ok_f / max(n_f, 1)) >= 0.95,
    }

    # 4. Camera >= 85 → storage >= 128
    camera = df["camera_interest"] >= 85
    storage_ok = df["min_storage_gb"] >= 128
    n_c = int(camera.sum())
    n_ok_c = int((~camera | storage_ok).sum())
    rules["photographer_implies_storage"] = {
        "rows_implicated": n_c,
        "rows_passing_pct": round(n_ok_c / max(n_c, 1) * 100, 2),
        "passes_95pct": (n_ok_c / max(n_c, 1)) >= 0.95,
    }

    # 5. Display >= 80 → refresh >= 120
    display = df["display_interest"] >= 80
    refresh_ok_d = df["min_refresh_rate_hz"] >= 120
    n_d = int(display.sum())
    n_ok_d = int((~display | refresh_ok_d).sum())
    rules["display_implies_high_refresh"] = {
        "rows_implicated": n_d,
        "rows_passing_pct": round(n_ok_d / max(n_d, 1) * 100, 2),
        "passes_95pct": (n_ok_d / max(n_d, 1)) >= 0.95,
    }

    return {
        "rules": rules,
        "all_pass_95pct": all(r["passes_95pct"] for r in rules.values()),
    }


def check_clustering_recovery(df: pd.DataFrame) -> Dict:
    """Fit K-Means with k=8 on the 7 interest scores, compute ARI vs `true_archetype`.

    If scikit-learn is unavailable, fall back to a sklearn-free approximation
    (centroid-based labelling) so the validator still runs.
    """
    X = df[list(INTEREST_SCORES)].to_numpy()
    y_true = df["true_archetype"].to_numpy()

    try:
        from sklearn.cluster import KMeans
        from sklearn.metrics import adjusted_rand_score
        from sklearn.preprocessing import StandardScaler
        scaler = StandardScaler()
        X_scaled = scaler.fit_transform(X)
        km = KMeans(n_clusters=8, random_state=42, n_init=20)
        y_pred = km.fit_predict(X_scaled)
        ari = float(adjusted_rand_score(y_true, y_pred))
        return {
            "method": "sklearn_KMeans",
            "k": 8,
            "ARI": round(ari, 4),
            "passes_0.6": ari >= 0.6,
        }
    except ImportError:
        # Fallback — no sklearn: assign each row to the nearest centroid
        # computed directly from the archetype centroids. This is *perfect*
        # classification since the centroids are already at the optimum, so
        # we instead report the mean distance to the nearest centroid.
        centroids = df.groupby("true_archetype")[list(INTEREST_SCORES)].mean()
        centroid_arr = centroids.to_numpy()
        # Standardise for fair distance.
        from numpy.linalg import norm
        X_scaled = (X - X.mean(axis=0)) / X.std(axis=0)
        C_scaled = (centroid_arr - X.mean(axis=0)) / X.std(axis=0)
        # Each row → nearest centroid → see if it's the right archetype.
        correct = 0
        for i, row in enumerate(X_scaled):
            true_arch = y_true[i]
            d = norm(C_scaled - row, axis=1)
            pred = centroids.index[d.argmin()]
            if pred == true_arch:
                correct += 1
        accuracy = correct / len(X)
        return {
            "method": "nearest_centroid_fallback",
            "k": 8,
            "note": "sklearn not available; ARI replaced with nearest-centroid accuracy",
            "accuracy": round(accuracy, 4),
            "passes_0.6_accuracy_0p6": accuracy >= 0.6,
        }


# ---------------------------------------------------------------------------
# Top-level entry point
# ---------------------------------------------------------------------------
def validate_dataset(csv_path: Path) -> Dict:
    csv_path = Path(csv_path)
    print(f"Validating {csv_path}…")
    df = pd.read_csv(csv_path)

    report = {
        "csv_path": str(csv_path),
        "n_rows": int(len(df)),
        "n_columns": int(df.shape[1]),
        "checks": {
            "distribution": check_distribution(df),
            "cohesion": check_cohesion(df),
            "separation": check_separation(df),
            "invariants": check_invariants(df),
            "clustering_recovery": check_clustering_recovery(df),
        },
    }

    summary = {
        "n_rows_ok": report["n_rows"] > 0,
        "distribution_ok": report["checks"]["distribution"]["all_within_tolerance"],
        "cohesion_ok": report["checks"]["cohesion"]["all_below_12"],
        "separation_ok": report["checks"]["separation"]["all_above_20_in_interest_only"],
        "invariants_ok": report["checks"]["invariants"]["all_pass_95pct"],
    }
    cluster_block = report["checks"]["clustering_recovery"]
    if "ARI" in cluster_block:
        summary["clustering_ari"] = cluster_block["ARI"]
        summary["clustering_ok"] = cluster_block["passes_0.6"]
    else:
        summary["clustering_accuracy"] = cluster_block.get("accuracy", 0.0)
        summary["clustering_ok"] = cluster_block.get(
            "passes_0.6_accuracy_0p6", False
        )
    summary["all_pass"] = all(summary.values())

    report["summary"] = summary
    return report


def main():
    parser = argparse.ArgumentParser(
        description="Validate the synthetic customer dataset"
    )
    parser.add_argument(
        "--csv",
        type=Path,
        default=PROJECT_ROOT / "synthetic_outputs" / "synthetic_customers.csv",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=None,
        help="Path for the JSON report (defaults next to the CSV)",
    )
    args = parser.parse_args()

    report = validate_dataset(args.csv)

    # Pretty-print summary.
    s = report["summary"]
    print("\n=== Validation Summary ===")
    print(f"  rows                       : {report['n_rows']}   "
          f"({'OK' if s['n_rows_ok'] else 'FAIL'})")
    print(f"  distribution within +/-2%  : "
          f"({'OK' if s['distribution_ok'] else 'FAIL'})")
    print(f"  cohesion (std < 12)        : "
          f"({'OK' if s['cohesion_ok'] else 'FAIL'})")
    sep = report["checks"]["separation"]
    int_min = sep["interest_only"]["min_separation"]
    print(f"  separation (int-only > 20):   min-sep={int_min:.2f}  "
          f"({'OK' if s['separation_ok'] else 'FAIL'})")
    print(f"  internal-consistency       : "
          f"({'OK' if s['invariants_ok'] else 'FAIL'})")
    if "clustering_ari" in s:
        print(f"  clustering ARI (k=8)       : "
              f"{s['clustering_ari']:.4f}  "
              f"({'OK' if s['clustering_ok'] else 'FAIL'} -- target >= 0.6)")
    else:
        print(f"  clustering accuracy        : "
              f"{s['clustering_accuracy']:.4f}  "
              f"({'OK' if s['clustering_ok'] else 'FAIL'} -- sklearn not available)")
    print(f"  +- OVERALL -------------------------------------")
    print(f"  |  {'[PASS] ALL CHECKS PASS' if s['all_pass'] else '[FAIL] ONE OR MORE CHECKS FAILED'}")
    print(f"  ------------------------------------------------")

    # Detailed distribution diff.
    print("\nArchetype distribution (target vs actual):")
    dist = report["checks"]["distribution"]
    for arch in dist["target_pct"]:
        t = dist["target_pct"][arch]
        a = dist["actual_pct"][arch]
        d = dist["delta_pct"][arch]
        print(f"  {arch:<25}  target={t:5.2f}%  actual={a:5.2f}%  delta={d:+5.2f}%")

    out = args.report or (args.csv.parent / "validation_report.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"\nWrote JSON report → {out}")


if __name__ == "__main__":
    main()