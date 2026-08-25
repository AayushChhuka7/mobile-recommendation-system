"""Customer segmentation for collaborative filtering.

Input (read-only):  ML model/filtering/01_data_preparation/output/customer_profiles_clean.csv
Output (written):   ML model/filtering/02_segmentation/output/
                    - customer_profiles_with_clusters.csv
                    - kmeans_model.joblib
                    - cluster_profiles.csv
                    - cluster_profiles.png  (bar chart per cluster)
                    - pca_scatter.png       (2D PCA scatter)
                    - contingency_heatmap.png (true_archetype vs cluster, ARI sanity check)

Approach: simple KMeans on scaled numeric + one-hot encoded categorical features.
true_archetype is held out as ground-truth for the ARI sanity check only.
"""

from __future__ import annotations

from pathlib import Path

import joblib
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.metrics import (
    adjusted_rand_score,
    silhouette_score,
)
from sklearn.preprocessing import StandardScaler

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parents[3]
INPUT_CSV = PROJECT_ROOT / "ML model" / "filtering" / "01_data_preparation" / "output" / "customer_profiles_clean.csv"
OUT_DIR = PROJECT_ROOT / "ML model" / "filtering" / "02_segmentation" / "output"
OUT_DIR.mkdir(parents=True, exist_ok=True)

SEED = 42
K_RANGE = range(4, 11)  # candidate cluster counts to evaluate


# ---------------------------------------------------------------------------
# 1. Preprocess
# ---------------------------------------------------------------------------
# Columns dropped from features:
#   - customer_id, customer_name   (identifiers)
#   - district, location           (very high cardinality, no useful signal)
#   - true_archetype               (held out for evaluation only)
DROP_COLS = ["customer_id", "customer_name", "district", "location", "true_archetype"]

# Categorical columns to one-hot encode (low cardinality)
CATEGORICAL_COLS = ["province", "gender", "chipset_tier", "interaction_channel",
                    "preferred_brand"]

# Numeric columns to scale
NUMERIC_COLS = [
    "age",
    "budget_min_npr", "budget_max_npr",
    "brand_loyalty_score",
    "gaming_interest", "camera_interest", "battery_interest", "display_interest",
    "performance_interest", "software_interest", "value_interest",
    "min_ram_gb", "min_storage_gb",
    "min_refresh_rate_hz", "min_battery_mah",
    "purchase_frequency_per_year", "n_past_purchases", "avg_session_minutes",
    "search_freq_per_week", "compare_freq_per_week",
    "click_through_rate", "recency_days", "avg_rating_given",
    "wishlist_conversion_rate", "accessory_affinity",
]


def preprocess(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    """Return (X, true_archetype).

    X is a fully numeric matrix with one-hot-encoded categoricals and
    z-score-scaled numeric features. true_archetype is untouched for use
    only in the ARI sanity check.
    """
    y = df["true_archetype"].copy()

    feat = df.drop(columns=DROP_COLS, errors="ignore")

    # One-hot encode low-cardinality categoricals
    feat = pd.get_dummies(feat, columns=CATEGORICAL_COLS, drop_first=False)

    # Scale numeric columns
    scaler = StandardScaler()
    feat[NUMERIC_COLS] = scaler.fit_transform(feat[NUMERIC_COLS])

    return feat, y


# ---------------------------------------------------------------------------
# 2. Pick the number of clusters
# ---------------------------------------------------------------------------
def pick_k(X: pd.DataFrame) -> tuple[int, dict[int, float], dict[int, float]]:
    """Compute inertia and silhouette for k in K_RANGE.

    Returns (chosen_k, inertias, silhouettes). The chosen k is the one with
    the highest silhouette score in the range — silhouette is bounded in
    [-1, 1] and is the standard data-driven signal for k-selection.
    """
    inertias: dict[int, float] = {}
    silhouettes: dict[int, float] = {}

    for k in K_RANGE:
        km = KMeans(n_clusters=k, random_state=SEED, n_init=10)
        labels = km.fit_predict(X)
        inertias[k] = km.inertia_
        silhouettes[k] = silhouette_score(X, labels, sample_size=min(2000, len(X)),
                                          random_state=SEED)
        print(f"  k={k:>2d}  inertia={inertias[k]:>12.0f}  silhouette={silhouettes[k]:.4f}")

    chosen_k = max(silhouettes, key=silhouettes.get)
    return chosen_k, inertias, silhouettes


# ---------------------------------------------------------------------------
# 3. Fit KMeans + assign human-readable names
# ---------------------------------------------------------------------------
def fit_kmeans(X: pd.DataFrame, k: int) -> KMeans:
    km = KMeans(n_clusters=k, random_state=SEED, n_init=10)
    km.fit(X)
    return km


def cluster_feature_means(df_with_clusters: pd.DataFrame, k: int) -> pd.DataFrame:
    """Mean of every numeric feature per cluster, sorted by cluster_id."""
    means = df_with_clusters.groupby("cluster_id")[NUMERIC_COLS].mean()
    return means


def label_clusters(profile_means: pd.DataFrame, df: pd.DataFrame) -> dict[int, str]:
    """Give each cluster a human-readable name based on its dominant traits.

    Strategy: take the majority chipset_tier of each cluster as the price
    bracket, then layer an interest-based qualifier on top.

    Tier brackets (using majority chipset_tier per cluster):
      - Budget  → "Budget Buyer"
      - Mid     → interest qualifier + "Mid-Range Shopper"
      - Flagship → interest qualifier + "Flagship Shopper"
        (with "Hardcore Gamer (Flagship)" for very high gaming_interest)
    """
    names: dict[int, str] = {}

    # Dominant tier per cluster from the actual customers (mode of chipset_tier)
    dominant_tier = (
        df.groupby("cluster_id")["chipset_tier"]
        .agg(lambda s: s.value_counts().idxmax())
        .to_dict()
    )

    for cid, row in profile_means.iterrows():
        tier = dominant_tier[cid]
        gaming = row["gaming_interest"]
        camera = row["camera_interest"]
        battery = row["battery_interest"]
        display = row["display_interest"]
        performance = row["performance_interest"]
        software = row["software_interest"]
        value = row["value_interest"]

        # Pick dominant interest above 60 (else fall back to All-Round)
        interests = {
            "gaming": gaming,
            "camera": camera,
            "battery": battery,
            "display": display,
            "performance": performance,
            "software": software,
            "value": value,
        }
        top_int, top_val = max(interests.items(), key=lambda kv: kv[1])

        if tier == "Budget":
            name = "Budget Buyer"
        elif tier == "Flagship":
            if gaming >= 75:
                name = "Hardcore Gamer (Flagship)"
            elif software >= 60 or value < 55:
                name = "Premium Flagship Shopper"
            else:
                name = "Premium Flagship Shopper"
        else:  # Mid
            if gaming >= 70:
                name = "Mid-Range Gamer"
            elif camera >= 60:
                name = "Mid-Range Photographer"
            elif battery >= 60:
                name = "Mid-Range Battery Hunter"
            elif display >= 60:
                name = "Mid-Range Display Lover"
            elif performance >= 60:
                name = "Mid-Range Power User"
            else:
                name = "Mainstream Mid-Range Shopper"

        names[cid] = name

    return names


# ---------------------------------------------------------------------------
# 4. Sanity check vs true_archetype (ARI + contingency)
# ---------------------------------------------------------------------------
def evaluate_against_true_archetype(
    pred_labels: np.ndarray,
    true_labels: pd.Series,
) -> tuple[float, pd.DataFrame]:
    """Compute ARI and a contingency table of cluster vs true_archetype."""
    ari = adjusted_rand_score(true_labels, pred_labels)
    df = pd.DataFrame({"cluster": pred_labels, "true_archetype": true_labels.values})
    table = pd.crosstab(df["cluster"], df["true_archetype"])
    return ari, table


# ---------------------------------------------------------------------------
# 5. Visualisations
# ---------------------------------------------------------------------------
def plot_cluster_profiles(profile_means: pd.DataFrame, out_path: Path) -> None:
    """Bar chart: each cluster's mean interest + budget + key spec feature."""
    plot_cols = [
        "gaming_interest", "camera_interest", "battery_interest",
        "display_interest", "performance_interest", "software_interest",
        "value_interest",
        "brand_loyalty_score",
        "budget_max_npr",
    ]
    units = {
        "budget_max_npr": "NPR",
        "brand_loyalty_score": "[0-1]",
    }
    plot_df = profile_means[plot_cols].copy()
    fig, ax = plt.subplots(figsize=(14, 6))
    x = np.arange(len(plot_df))
    n_bars = len(plot_cols)
    width = 0.85 / n_bars
    for i, col in enumerate(plot_cols):
        ax.bar(x + (i - n_bars / 2) * width, plot_df[col], width, label=col)
    ax.set_xticks(x)
    ax.set_xticklabels([f"c{cid}" for cid in plot_df.index])
    ax.set_title("Cluster profiles (mean of selected features)")
    ax.set_ylabel("feature value (interests & loyalty on 0-100 / brand loyalty 0-1)")
    ax.legend(fontsize=7, ncol=3, loc="upper right")
    fig.tight_layout()
    fig.savefig(out_path, dpi=140)
    plt.close(fig)


def plot_pca_scatter(X: pd.DataFrame, labels: np.ndarray, out_path: Path) -> None:
    """2D PCA scatter, coloured by cluster."""
    pca = PCA(n_components=2, random_state=SEED)
    coords = pca.fit_transform(X)
    fig, ax = plt.subplots(figsize=(8, 6))
    scatter = ax.scatter(coords[:, 0], coords[:, 1], c=labels, cmap="tab10",
                         s=6, alpha=0.6)
    ax.set_xlabel(f"PC1 ({pca.explained_variance_ratio_[0] * 100:.1f}% var)")
    ax.set_ylabel(f"PC2 ({pca.explained_variance_ratio_[1] * 100:.1f}% var)")
    ax.set_title("Customer profiles projected to 2D (PCA)")
    plt.colorbar(scatter, ax=ax, label="cluster_id")
    fig.tight_layout()
    fig.savefig(out_path, dpi=140)
    plt.close(fig)


def plot_contingency_heatmap(table: pd.DataFrame, out_path: Path) -> None:
    """Heatmap of cluster x true_archetype counts."""
    fig, ax = plt.subplots(figsize=(10, 6))
    im = ax.imshow(table.values, aspect="auto", cmap="Blues")
    ax.set_xticks(range(len(table.columns)))
    ax.set_xticklabels(table.columns, rotation=35, ha="right", fontsize=8)
    ax.set_yticks(range(len(table.index)))
    ax.set_yticklabels([f"c{i}" for i in table.index])
    ax.set_xlabel("true_archetype")
    ax.set_ylabel("cluster_id")
    ax.set_title("Contingency table: cluster vs true_archetype (sanity check)")
    for i in range(len(table.index)):
        for j in range(len(table.columns)):
            v = table.values[i, j]
            if v > 0:
                ax.text(j, i, str(v), ha="center", va="center",
                        fontsize=7, color="white" if v > table.values.max() * 0.5 else "black")
    fig.colorbar(im, ax=ax, label="count")
    fig.tight_layout()
    fig.savefig(out_path, dpi=140)
    plt.close(fig)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    print("=" * 72)
    print("STEP 1 — Loading + preprocessing")
    print("=" * 72)
    df = pd.read_csv(INPUT_CSV)
    print(f"  loaded {len(df)} customers, {len(df.columns)} columns")

    X, y_arch = preprocess(df)
    print(f"  feature matrix: {X.shape}")
    print(f"  num numeric (scaled):   {len(NUMERIC_COLS)}")
    print(f"  num one-hot categorical: {len([c for c in X.columns if c not in NUMERIC_COLS])}")

    print("\n" + "=" * 72)
    print("STEP 2 — Picking cluster count (k)")
    print("=" * 72)
    chosen_k, inertias, silhouettes = pick_k(X)
    print(f"\n  Chosen k = {chosen_k} (highest silhouette = {silhouettes[chosen_k]:.4f})")

    print("\n" + "=" * 72)
    print("STEP 3 — Fitting KMeans")
    print("=" * 72)
    km = fit_kmeans(X, chosen_k)
    labels = km.labels_
    df["cluster_id"] = labels.astype(int)

    # Cluster feature means + human-readable names
    means = cluster_feature_means(df, chosen_k)
    names = label_clusters(means, df)
    df["cluster_name"] = df["cluster_id"].map(names)
    print(f"  cluster sizes: {dict(df['cluster_id'].value_counts().sort_index())}")
    print(f"  cluster names:")
    for cid, name in sorted(names.items()):
        n = (df["cluster_id"] == cid).sum()
        print(f"    c{cid} ({n:>4d} customers): {name}")

    print("\n" + "=" * 72)
    print("STEP 4 — ARI sanity check vs true_archetype")
    print("=" * 72)
    ari, contingency = evaluate_against_true_archetype(labels, y_arch)
    print(f"  Adjusted Rand Index = {ari:.4f}")
    print(f"\n  Contingency table:")
    print(contingency.to_string())

    print("\n" + "=" * 72)
    print("STEP 5 — Plotting")
    print("=" * 72)
    plot_cluster_profiles(means, OUT_DIR / "cluster_profiles.png")
    plot_pca_scatter(X, labels, OUT_DIR / "pca_scatter.png")
    plot_contingency_heatmap(contingency, OUT_DIR / "contingency_heatmap.png")
    print(f"  wrote cluster_profiles.png")
    print(f"  wrote pca_scatter.png")
    print(f"  wrote contingency_heatmap.png")

    print("\n" + "=" * 72)
    print("STEP 6 — Saving outputs")
    print("=" * 72)
    # 1. CSV with cluster columns appended
    out_csv = df.copy()
    out_csv.to_csv(OUT_DIR / "customer_profiles_with_clusters.csv", index=False)
    print(f"  wrote customer_profiles_with_clusters.csv ({len(out_csv)} rows, "
          f"{len(out_csv.columns)} cols)")

    # 2. Joblib model
    joblib.dump(km, OUT_DIR / "kmeans_model.joblib")
    print(f"  wrote kmeans_model.joblib")

    # 3. Cluster profile summary (CSV for reference)
    means_out = means.copy()
    means_out["cluster_name"] = means_out.index.map(names)
    means_out["size"] = df["cluster_id"].value_counts().sort_index()
    means_out.to_csv(OUT_DIR / "cluster_profiles.csv")
    print(f"  wrote cluster_profiles.csv")

    print("\n" + "=" * 72)
    print("DONE")
    print("=" * 72)
    print(f"  k          = {chosen_k}")
    print(f"  silhouette = {silhouettes[chosen_k]:.4f}")
    print(f"  ARI        = {ari:.4f}")
    print(f"  outputs    = {OUT_DIR}")


if __name__ == "__main__":
    main()
