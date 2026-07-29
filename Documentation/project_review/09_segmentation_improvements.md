# 09 — Segmentation Improvements

> The current K-Means produces 3 clusters with **silhouette = 0.133** — below the
> "0.5 is reasonable" rule of thumb. This document specifies alternatives.

---

## 1. The numbers, again

From the segmentation notebook:

```
k= 2 | inertia=70358 | silhouette=0.2284 | DB=1.721 | CH=929
k= 3 | inertia=62060 | silhouette=0.1328 | DB=2.081 | CH=831  ← chosen
k= 4 | inertia=57970 | silhouette=0.1233 | DB=2.015 | CH=700
k= 5 | inertia=55700 | silhouette=0.0978 | DB=2.302 | CH=593
```

The **highest silhouette** in the range is at `k=2` (0.228). The notebook's
selection rule chose `k=3` based on Calinski-Harabasz and a min-size guard. That's
fine, but the cluster quality is weak.

---

## 2. Why silhouette is low

Three reasons:

1. **High-dimensional one-hot encodings.** 64 features after encoding, many of which are 0/1 indicator for `preferred_brand = "Samsung"` etc. K-Means assumes spherical, equal-variance clusters; one-hot features create grid-like artefacts.
2. **Continuous spend variables dominate.** `total_spend_npr` ranges 12,400 to 500,800 — six orders of magnitude of variance. The StandardScaler brings it to z-score but the cluster structure remains elongated.
3. **Customer categories are not discrete.** Real customers lie on a continuum from "budget" to "luxury", not in three buckets.

---

## 3. The fixes

### 3.1 Feature selection

Run K-Means on a smaller, more discriminative feature set:

```python
SEGMENTATION_FEATURES = [
    "age",
    "total_spend_npr",
    "avg_purchase_amount_npr",
    "purchase_frequency_per_year",
    "avg_rating",
    "recency_days",
    "tenure_days",
    "wishlist_conversion_rate",
    "browsing_count",
    "accessory_spend_npr",
    "brand_loyal",
]
# Drop the categoricals entirely; encode them later if needed.
```

Removing `preferred_brand`, `preferred_category`, etc. removes the one-hot explosion. Re-run K-Means; silhouette should rise to ~0.20.

### 3.2 Try Gaussian Mixture (GMM)

```python
from sklearn.mixture import GaussianMixture

gmm = GaussianMixture(n_components=4, covariance_type="full", random_state=42, n_init=10)
labels = gmm.fit_predict(X_proc)
sil = silhouette_score(X_proc, labels)
```

GMM allows **ellipsoidal** clusters with different orientations, which fits spend data better.

### 3.3 Try Hierarchical (Agglomerative)

```python
from sklearn.cluster import AgglomerativeClustering

agg = AgglomerativeClustering(n_clusters=4, linkage="ward")
labels = agg.fit_predict(X_proc)
```

`ward` linkage minimises within-cluster variance, similar to K-Means but without the spherical assumption.

### 3.4 Try HDBSCAN

```python
import hdbscan

hdb = hdbscan.HDBSCAN(min_cluster_size=200, min_samples=20)
labels = hdb.fit_predict(X_proc)
sil = silhouette_score(X_proc[labels >= 0], labels[labels >= 0])
n_clusters = len(set(labels) - {-1})
```

HDBSCAN finds **density-based** clusters of varying density. It is the right tool when clusters overlap heavily. For this dataset, HDBSCAN with `min_cluster_size=200` will probably find 3-5 clusters.

### 3.5 RFM segmentation (a domain-specific alternative)

**RFM** = Recency, Frequency, Monetary. Score each customer 1-5 on each dimension, then segment by RFM-cell.

```python
def rfm_score(df, recency_col, frequency_col, monetary_col):
    df["R"] = pd.qcut(df[recency_col], 5, labels=[5, 4, 3, 2, 1])  # lower recency is better
    df["F"] = pd.qcut(df[frequency_col].rank(method="first"), 5, labels=[1, 2, 3, 4, 5])
    df["M"] = pd.qcut(df[monetary_col], 5, labels=[1, 2, 3, 4, 5])
    df["RFM_Segment"] = df["R"].astype(str) + df["F"].astype(str) + df["M"].astype(str)
    return df
```

RFM is **the industry standard** for customer segmentation. The 5×5×5 = 125 cells can be collapsed to ~10 actionable segments ("Champions", "Loyal Customers", "At Risk", etc.).

### 3.6 Customer Lifetime Value (LTV) segmentation

Use the XGBoost LTV regressor (see `xgboost_ideas/08_ltv_regressor.md`) to predict each customer's 12-month value, then **decile** them.

This is the most **business-actionable** segmentation because marketing spend is allocated by LTV.

---

## 4. Bootstrap stability

The current K-Means has a fixed `random_state=42`, but is the cluster assignment **stable**? Re-run with 100 bootstrap samples:

```python
from sklearn.metrics import adjusted_rand_score

n_boot = 100
aris = []
for seed in range(n_boot):
    idx = np.random.RandomState(seed).choice(len(X_proc), len(X_proc), replace=True)
    km = KMeans(n_clusters=3, random_state=seed, n_init=10)
    labels_b = km.fit_predict(X_proc[idx])
    # Re-map labels to the original cluster
    mapper = {}
    for i, l in enumerate(labels_b):
        mapper.setdefault(l, []).append(i)
    aris.append(adjusted_rand_score(kmeans_labels[idx], labels_b))
```

If mean ARI < 0.7, the segmentation is unstable — try GMM or HDBSCAN.

---

## 5. The label-vs-mean mismatch

The auto-labeling function `label_cluster()` produces names like:

- Cluster 0: **"Premium Xiaomi Budget — Frequent but Lapsing"** (mean spend NPR 170k → not Premium)
- Cluster 1: **"Luxury Apple Flagship — Frequent but Lapsing"** (mean spend NPR 549k → Luxury ✅)
- Cluster 2: **"Luxury Xiaomi Battery-focused — Frequent but Lapsing"** (mean spend NPR 235k → not Luxury)

The tiers (`Premium`, `Luxury`) are based on the heuristic `mean_spend >= 200,000` and `mean_spend >= 100,000`. Cluster 0's mean spend is 170,105, which passes the `>= 100,000` Premium threshold but feels wrong because the per-cluster distribution has a long tail.

**Fix.** Use **quantile-based** labels:

```python
def label_tier_quantile(mean_spend, all_spend_quantiles):
    if mean_spend >= all_spend_quantiles[0.8]:
        return "Luxury"
    if mean_spend >= all_spend_quantiles[0.5]:
        return "Premium"
    if mean_spend >= all_spend_quantiles[0.25]:
        return "Mid-Range"
    return "Budget"
```

Now Cluster 0 (170k, below the 80th percentile = ~300k) gets `Mid-Range`, which matches the data.

---

## 6. Adding personas to segments

The current segmentation has 3 clusters; the recommender has 5 personas (`Gamer`, `Camera_Lover`, `Battery_Focused`, `All_Rounder`, `Business_User`) + `Custom`. The two systems don't talk to each other.

**The fix.** Map each cluster to a **default persona**:

```python
CLUSTER_TO_PERSONA = {
    0: "All_Rounder",        # Mid-Range Xiaomi → generalists
    1: "Business_User",      # Luxury Apple Flagship → security + software
    2: "Battery_Focused",    # Luxury Xiaomi Battery-focused → matches the name
}
```

Then in `recommendService.mjs`, when a new user has no `UserPreference`, use their `cluster_id` to look up the default persona.

This is **one Prisma migration + one join + one lookup** — small but very impactful.

---

## 7. SOM (Self-Organizing Maps) for visual cluster discovery

A 2-D SOM (`MiniSom`) gives a topologically-preserving 2-D map of the customer space. Useful for **exploration** but not for production ranking.

```python
from minisom import MiniSom
som = MiniSom(20, 20, X_proc.shape[1], sigma=1.0, learning_rate=0.5, random_state=42)
som.train(X_proc, 1000, verbose=True)
```

Then visualise with `som.pcolor()` to see cluster density.

---

## 8. Summary

| Approach                    | Use case                | Pros                       | Cons                          |
| --------------------------- | ----------------------- | -------------------------- | ----------------------------- |
| **K-Means (current)**        | Baseline                | Fast, interpretable         | Low silhouette               |
| **GMM**                      | Better cluster shapes   | Ellipsoidal, soft clusters  | Slower, more hyperparameters |
| **Agglomerative**            | Hierarchical             | No need to pick k upfront   | O(n²) memory                  |
| **HDBSCAN**                  | Density                 | Handles noise               | Hard to interpret              |
| **RFM**                      | Marketing               | Industry-standard            | Doesn't capture interactions  |
| **LTV-decile**               | Marketing spend         | Directly actionable         | Needs a good LTV model        |
| **SOM**                      | Exploration             | Beautiful visualisations    | Not for production             |

**Recommendation.** Replace K-Means with **GMM (n=4, full covariance)** for the ML paper, and add an **RFM analysis** alongside for the marketing story.