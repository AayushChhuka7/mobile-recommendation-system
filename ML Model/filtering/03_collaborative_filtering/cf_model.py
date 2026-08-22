"""Collaborative filtering module for mobile recommendation.

Self-contained: reads pre-prepared CSVs from phases 1 & 2, trains and
evaluates multiple CF approaches, and exposes a single
`get_recommendations(customer_id, top_n=5)` entrypoint suitable for later
integration with the Django backend.

This module is INTENTIONALLY independent from the existing content-based
recommender (which lives in `ML Model/pipeline/`). The hybrid scorer here
combines the trained CF score with a lightweight content score computed
from the same `phone_catalog.csv` the CF system uses.

Public surface:

    from cf_model import CFRecommender
    rec = CFRecommender.load("output/")
    out = rec.get_recommendations("CUST-000EFD69", top_n=5)
    #   out is a list of {"model_name", "score", "reason"} dicts
"""

from __future__ import annotations

import hashlib
import json
import pickle
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
import scipy.sparse as sp
from sklearn.decomposition import TruncatedSVD
from sklearn.metrics.pairwise import cosine_similarity

# Optional: implicit ALS (only used if available)
try:
    from implicit.als import AlternatingLeastSquares
    HAS_IMPLICIT = True
except ImportError:
    HAS_IMPLICIT = False


# ---------------------------------------------------------------------------
# Constants — explicit here so phase-3 trainers can import & override
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parents[3]

INTERACTIONS_CSV = PROJECT_ROOT / "ML model" / "filtering" / "01_data_preparation" / "output" / "interactions.csv"
PHONE_CATALOG_CSV = PROJECT_ROOT / "ML model" / "filtering" / "01_data_preparation" / "output" / "phone_catalog.csv"
HOLDOUT_CSV = PROJECT_ROOT / "ML model" / "filtering" / "01_data_preparation" / "output" / "cold_start_holdout.csv"
PROFILES_CSV = PROJECT_ROOT / "ML model" / "filtering" / "02_segmentation" / "output" / "customer_profiles_with_clusters.csv"

# Implicit feedback weights. Tuned so that a purchase (5.0) outweighs a
# typical fan-out of weak signals from the same user. A user with ~30
# view + 15 search + 12 wishlist + 9 compare ≈ 7.6 implicit-weighted
# units vs 5.0 from one purchase — comparable, but a single purchase
# already outranks the noise.
EVENT_WEIGHT = {
    "purchase": 5.0,
    "rate":     4.0,
    "wishlist": 0.5,
    "compare":  0.2,
    "search":   0.1,
    "view":     0.05,
}

# Time-based split: last 90 days of the year-long horizon are test.
TEST_FRAC_DAYS = 90
SEED = 42


# ---------------------------------------------------------------------------
# Data loading & matrix construction
# ---------------------------------------------------------------------------
@dataclass
class InteractionData:
    """Holds the user-item interaction matrix and the auxiliary tables."""

    train_csr: sp.csr_matrix                       # user × item, training only
    test_df: pd.DataFrame                          # test events for evaluation
    user_index: dict[str, int] = field(default_factory=dict)
    item_index: dict[str, int] = field(default_factory=dict)
    index_user: list[str] = field(default_factory=list)
    index_item: list[str] = field(default_factory=list)
    ratings_csr: sp.csr_matrix | None = None       # user × item, rating values (where explicit)

    @property
    def n_users(self) -> int:
        return len(self.index_user)

    @property
    def n_items(self) -> int:
        return len(self.index_item)


def load_interactions() -> pd.DataFrame:
    df = pd.read_csv(INTERACTIONS_CSV)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    return df


def build_index(items: list[str]) -> tuple[dict[str, int], list[str]]:
    uniq = sorted(set(items))
    fwd = {s: i for i, s in enumerate(uniq)}
    rev = uniq
    return fwd, rev


def time_split(df: pd.DataFrame, test_frac_days: int = TEST_FRAC_DAYS):
    """Last `test_frac_days` days go to test, the rest to train."""
    cutoff = df["timestamp"].max() - pd.Timedelta(days=test_frac_days)
    train = df[df["timestamp"] <= cutoff].copy()
    test = df[df["timestamp"] > cutoff].copy()
    return train, test, cutoff


def build_matrices(
    train_df: pd.DataFrame,
    test_df: pd.DataFrame,
    cold_users: set[str],
    cold_items: set[str],
) -> InteractionData:
    """Build a CSR user×item matrix for the training set.

    Cold-start users and cold-start items are excluded from the training
    rows (so the model never sees them). Their test events, if any, are
    still tracked in test_df for evaluation.
    """
    train = train_df[~train_df["customer_id"].isin(cold_users)].copy()
    train = train[~train_df["model_name"].isin(cold_items)].copy()

    # Compute weight per row: event weight + a small bonus for a rating on
    # the same (user, item) — ensures purchase+rate pairs outrank views.
    train["weight"] = train["interaction_type"].map(EVENT_WEIGHT).fillna(0.1)
    # If multiple events for same (user, item), collapse to a single weight
    # by taking the max weight (highest signal wins).
    agg = (
        train.groupby(["customer_id", "model_name"], as_index=False)
        ["weight"].max()
    )

    user_index, index_user = build_index(agg["customer_id"].tolist())
    item_index, index_item = build_index(agg["model_name"].tolist())

    rows = agg["customer_id"].map(user_index).values
    cols = agg["model_name"].map(item_index).values
    weights = agg["weight"].values

    n_users = len(user_index)
    n_items = len(item_index)
    train_csr = sp.csr_matrix(
        (weights, (rows, cols)), shape=(n_users, n_items), dtype=np.float32
    )

    # Ratings matrix: explicit ratings only, used by SVD on explicit feedback.
    rated = train_df[~train_df["customer_id"].isin(cold_users)]
    rated = rated[~rated["model_name"].isin(cold_items)]
    rated = rated[rated["rating"].notna()]
    # Collapse: take mean rating per (user, item) — a user can purchase and
    # rate the same phone on different days.
    r_agg = rated.groupby(["customer_id", "model_name"], as_index=False)["rating"].mean()
    r_rows = r_agg["customer_id"].map(user_index).values
    r_cols = r_agg["model_name"].map(item_index).values
    r_vals = r_agg["rating"].values.astype(np.float32)
    ratings_csr = sp.csr_matrix(
        (r_vals, (r_rows, r_cols)), shape=(n_users, n_items), dtype=np.float32
    )

    return InteractionData(
        train_csr=train_csr,
        test_df=test_df,
        user_index=user_index,
        item_index=item_index,
        index_user=index_user,
        index_item=index_item,
        ratings_csr=ratings_csr,
    )


# ---------------------------------------------------------------------------
# Memory-based CF: item-item cosine similarity
# ---------------------------------------------------------------------------
def fit_item_cosine(train_csr: sp.csr_matrix) -> np.ndarray:
    """Item-item cosine similarity matrix (n_items × n_items).

    Built from the user×item matrix (cosine over item column vectors).
    Returns a dense ndarray; we only have ~1800 items so this is ~26 MB.
    """
    # Row-normalise so cosine = item co-occurrence pattern
    item_user = train_csr.T.tocsr()
    sim = cosine_similarity(item_user, dense_output=True)
    # Zero the diagonal so we don't recommend an item to itself
    np.fill_diagonal(sim, 0.0)
    # Clip negative similarities to 0 — negative co-occurrence is noise
    sim = np.clip(sim, 0.0, 1.0)
    return sim.astype(np.float32)


def score_item_cosine(
    user_idx: int,
    item_sim: np.ndarray,
    train_csr: sp.csr_matrix,
    top_n: int = 200,
) -> np.ndarray:
    """Score every item for a given user using item-item cosine.

    Returns an array of (item_idx, score) pairs sorted by descending score.
    Items the user has already interacted with are excluded.
    """
    user_items = train_csr[user_idx].toarray().ravel()
    seen = np.where(user_items > 0)[0]
    if len(seen) == 0:
        return np.array([], dtype=np.int64), np.array([], dtype=np.float32)
    # Score = sum over items the user has interacted with of (weight * similarity)
    scores = item_sim[:, seen].dot(user_items[seen])
    scores[seen] = -np.inf  # exclude already-seen items
    # Return the top N
    if top_n >= len(scores):
        idx = np.argsort(-scores)
    else:
        idx = np.argpartition(-scores, top_n)[:top_n]
        idx = idx[np.argsort(-scores[idx])]
    return idx, scores[idx].astype(np.float32)


# ---------------------------------------------------------------------------
# Model-based CF: truncated SVD on the user×item weighted matrix
# ---------------------------------------------------------------------------
def fit_svd(
    train_csr: sp.csr_matrix,
    n_factors: int = 64,
    n_iter: int = 10,
) -> tuple[np.ndarray, np.ndarray, TruncatedSVD]:
    """Truncated SVD on the weighted interaction matrix.

    Returns (user_factors, item_factors, model). user_factors is (n_users, k)
    only populated for users that the SVD saw; for cold-start users we fall
    back to a content-based score (see ContentScorer).
    """
    svd = TruncatedSVD(n_components=n_factors, n_iter=n_iter, random_state=SEED)
    user_factors = svd.fit_transform(train_csr).astype(np.float32)
    item_factors = svd.components_.T.astype(np.float32)
    return user_factors, item_factors, svd


def score_svd(
    user_idx: int,
    user_factors: np.ndarray,
    item_factors: np.ndarray,
    train_csr: sp.csr_matrix,
    top_n: int = 200,
) -> tuple[np.ndarray, np.ndarray]:
    scores = item_factors.dot(user_factors[user_idx])
    seen = np.where(train_csr[user_idx].toarray().ravel() > 0)[0]
    scores[seen] = -np.inf
    if top_n >= len(scores):
        idx = np.argsort(-scores)
    else:
        idx = np.argpartition(-scores, top_n)[:top_n]
        idx = idx[np.argsort(-scores[idx])]
    return idx, scores[idx].astype(np.float32)


# ---------------------------------------------------------------------------
# Model-based CF: implicit ALS
# ---------------------------------------------------------------------------
def fit_als(
    train_csr: sp.csr_matrix,
    factors: int = 64,
    regularization: float = 0.05,
    iterations: int = 20,
    alpha: float = 40,
) -> "AlternatingLeastSquares | None":
    if not HAS_IMPLICIT:
        return None
    # implicit expects (item × user) — but we feed the user×item and let the
    # library transpose internally via the user_items / item_users args.
    model = AlternatingLeastSquares(
        factors=factors,
        regularization=regularization,
        iterations=iterations,
        random_state=SEED,
        use_gpu=False,
    )
    # Convert to float32 and apply alpha (confidence = 1 + alpha*weight)
    weighted = train_csr.copy().astype(np.float32)
    weighted.data *= alpha
    weighted.data += 1.0
    model.fit(weighted, show_progress=False)
    return model


def score_als(
    user_idx: int,
    model,
    train_csr: sp.csr_matrix,
    top_n: int = 200,
) -> tuple[np.ndarray, np.ndarray]:
    # model.recommend() returns (ids, scores)
    ids, scores = model.recommend(
        user_idx,
        train_csr[user_idx],
        N=top_n,
        filter_already_liked_items=True,
    )
    return np.asarray(ids), np.asarray(scores, dtype=np.float32)


# ---------------------------------------------------------------------------
# Content-based scorer (used by hybrid + cold-start fallback)
# ---------------------------------------------------------------------------
@dataclass
class ContentScorer:
    """Maps (customer profile) → (phone spec vector) and computes cosine
    similarity between them. Used as the content half of the hybrid and as
    the cold-start fallback."""

    catalog: pd.DataFrame
    item_spec: np.ndarray               # (n_items, n_features) L2-normalised
    feature_columns: list[str]
    feature_index: dict[str, int]
    user_profiles: pd.DataFrame         # customers + cluster_id + cluster_name
    # Pre-indexed lookups — built once at load time so per-request calls
    # avoid DataFrame boolean masks (which are O(n) scans). With ~10k
    # profiles and ~1800 catalog rows, those scans dominated request
    # latency on the warm CF path (~30-60 ms each).
    profile_by_cid: dict[str, pd.Series] = field(default_factory=dict)
    catalog_by_model: dict[str, pd.Series] = field(default_factory=dict)

    def score_user(self, customer_id: str) -> np.ndarray:
        """Return a content-similarity score for every catalog item, for this user."""
        row = self.profile_by_cid.get(customer_id)
        if row is None:
            return np.zeros(len(self.catalog), dtype=np.float32)

        # Build a synthetic "spec vector" from the customer's interests & budget.
        # We do this in the same feature space as the catalog spec vectors.
        spec = self._user_to_spec(row)
        # Cosine similarity to each item's spec
        sims = self.item_spec.dot(spec)
        return sims.astype(np.float32)

    def score_user_items(self, customer_id: str, candidate_models: list[str]) -> np.ndarray:
        sims = self.score_user(customer_id)
        idx_map = {m: i for i, m in enumerate(self.catalog["Model_Name"].values)}
        return np.array([sims[idx_map[m]] if m in idx_map else 0.0 for m in candidate_models],
                        dtype=np.float32)

    def _user_to_spec(self, row) -> np.ndarray:
        """Translate a user profile into the same feature space as item_spec.

        We project interest scores onto the spec dimensions by mapping:
          - gaming_interest → gaming_score side
          - camera_interest → camera_score
          - ...
          - budget → price-side via a budget-mask on tier
        """
        v = np.zeros(len(self.feature_columns), dtype=np.float32)
        for dim, col in [
            ("gaming", "gaming_interest"),
            ("camera", "camera_interest"),
            ("battery", "battery_interest"),
            ("display", "display_interest"),
            ("performance", "performance_interest"),
            ("software", "software_interest"),
            ("value", "value_interest"),
        ]:
            if dim in self.feature_index:
                v[self.feature_index[dim]] = float(row[col]) / 100.0
        # Brand preference
        pb = normalize_brand(row.get("preferred_brand", ""))
        bk = f"brand_{pb}"
        if bk in self.feature_index:
            v[self.feature_index[bk]] = 1.0 * float(row.get("brand_loyalty_score", 0.5))
        # Tier preference
        tier = row.get("chipset_tier", "Mid")
        tk = f"tier_{tier}"
        if tk in self.feature_index:
            v[self.feature_index[tk]] = 1.0
        # L2 normalise
        n = np.linalg.norm(v)
        if n > 0:
            v = v / n
        return v


def build_content_scorer(catalog: pd.DataFrame, profiles: pd.DataFrame) -> ContentScorer:
    """Build a ContentScorer from the phone catalog and customer profiles.

    Item spec vector = stack of per-spec scores (gaming/camera/...) plus
    one-hot brand. We do NOT one-hot encode `tier` because most users
    have `tier=Flagship` set in their profile which would push every
    flagship phone to the top — the price column already encodes tier
    implicitly.

    Specs are z-scored across the catalog so the cosine similarity is
    contrastive (relative to other phones), not absolute.
    """
    df = catalog.copy()

    # Per-dimension score
    df["gaming_score"] = df["RAM_GB"] * 2.0 + df["Refresh_Rate_Hz"] / 30.0 + df["Chipset_Is_Flagship"] * 8.0
    df["camera_score"] = df["Main_Camera_MP"] * 1.5 + df["Lens_Count"].fillna(0)
    df["battery_score"] = df["Battery_mAh"] / 100.0
    df["display_score"] = df["Refresh_Rate_Hz"]
    df["performance_score"] = df["Chipset_Is_Flagship"] * 10.0 + df["RAM_GB"] * 0.8 + df["AnTuTu_Score"].fillna(0) / 100000.0
    df["software_score"] = (df["NFC"].apply(lambda x: 5 if x == "Yes" else 0)) + df["Chipset_Is_Flagship"] * 3
    df["value_score"] = (df["Battery_mAh"] / 1000.0 + df["RAM_GB"] + df["Storage_GB"] / 64.0) / (df["npr_price"] / 30000.0).clip(lower=1.0)

    feature_columns = [
        "gaming_score", "camera_score", "battery_score", "display_score",
        "performance_score", "software_score", "value_score",
        "npr_price",
    ]
    # Add one-hot brand
    for b in sorted(df["Brand_norm"].unique()):
        feature_columns.append(f"brand_{b}")

    feature_index = {c: i for i, c in enumerate(feature_columns)}

    # Build the (n_items, n_features) matrix, then z-score each column
    mat = np.zeros((len(df), len(feature_columns)), dtype=np.float32)
    spec_cols = ["gaming_score", "camera_score", "battery_score",
                 "display_score", "performance_score", "software_score",
                 "value_score", "npr_price"]
    for i, col in enumerate(spec_cols):
        col_vals = df[col].fillna(0).values.astype(np.float32)
        mean = col_vals.mean()
        std = col_vals.std()
        if std < 1e-9:
            std = 1.0
        mat[:, i] = (col_vals - mean) / std
    # one-hot brand (already 0/1 — leave as is)
    for b in df["Brand_norm"].unique():
        mask = (df["Brand_norm"] == b).values
        mat[mask, feature_index[f"brand_{b}"]] = 1.0
    # L2-normalise rows so cosine is meaningful
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    item_spec = mat / norms

    return ContentScorer(
        catalog=df.reset_index(drop=True),
        item_spec=item_spec,
        feature_columns=feature_columns,
        feature_index=feature_index,
        user_profiles=profiles,
        # Pre-index the catalogs once. Per-request code uses these
        # instead of DataFrame boolean masks.
        profile_by_cid=(
            dict(zip(
                profiles["customer_id"].astype(str).values,
                [row for _, row in profiles.iterrows()],
            ))
            if "customer_id" in profiles.columns
            else {}
        ),
        catalog_by_model=dict(zip(
            df["Model_Name"].astype(str).values,
            [row for _, row in df.iterrows()],
        )),
    )


def normalize_brand(brand):
    aliases = {
        "Redmi": "Xiaomi", "Poco": "Xiaomi",
        "ASUS": "Asus",
    }
    if not isinstance(brand, str):
        return ""
    return aliases.get(brand.strip(), brand.strip())


# ---------------------------------------------------------------------------
# Evaluation: Precision@K, Recall@K, NDCG@K, RMSE, MAE
# ---------------------------------------------------------------------------
def evaluate_ranking(
    predictions: dict[int, np.ndarray],
    test_users: list[str],
    test_truth: dict[int, set[int]],
    k: int,
) -> dict[str, float]:
    p_list, r_list, ndcg_list = [], [], []
    for uid in test_users:
        pred = predictions.get(uid)
        if pred is None or len(pred) == 0:
            continue
        truth = test_truth.get(uid, set())
        if not truth:
            continue
        top_k = pred[:k]
        hits = set(top_k.tolist()) & truth
        prec = len(hits) / max(1, k)
        rec = len(hits) / max(1, len(truth))
        # NDCG
        dcg = sum(1.0 / np.log2(i + 2) for i, it in enumerate(top_k) if it in truth)
        idcg = sum(1.0 / np.log2(i + 2) for i in range(min(k, len(truth))))
        ndcg = dcg / max(1e-9, idcg)
        p_list.append(prec)
        r_list.append(rec)
        ndcg_list.append(ndcg)
    return {
        f"precision@{k}": float(np.mean(p_list)) if p_list else 0.0,
        f"recall@{k}":    float(np.mean(r_list)) if r_list else 0.0,
        f"ndcg@{k}":      float(np.mean(ndcg_list)) if ndcg_list else 0.0,
        "n_users_evaluated": len(p_list),
    }


def evaluate_rating(
    pred: sp.csr_matrix,
    test_df: pd.DataFrame,
    user_index: dict[str, int],
    item_index: dict[str, int],
) -> dict[str, float]:
    """RMSE / MAE on rated test events."""
    rated = test_df[test_df["rating"].notna()]
    if rated.empty:
        return {"rmse": float("nan"), "mae": float("nan"), "n": 0}
    diffs, abs_diffs, n = [], [], 0
    for _, row in rated.iterrows():
        u = user_index.get(row["customer_id"])
        i = item_index.get(row["model_name"])
        if u is None or i is None:
            continue
        v = pred[u, i]
        if v == 0:
            continue  # no prediction — skip
        diffs.append((v - row["rating"]) ** 2)
        abs_diffs.append(abs(v - row["rating"]))
        n += 1
    if n == 0:
        return {"rmse": float("nan"), "mae": float("nan"), "n": 0}
    return {"rmse": float(np.sqrt(np.mean(diffs))),
            "mae":  float(np.mean(abs_diffs)),
            "n":    n}


# ---------------------------------------------------------------------------
# Final trained artefact
# ---------------------------------------------------------------------------
@dataclass
class CFRecommender:
    """Trained collaborative filtering recommender.

    A single object that holds the matrices, the three CF models, and the
    content scorer. The public entrypoint is `get_recommendations`.
    """

    data: InteractionData
    catalog: pd.DataFrame
    profiles: pd.DataFrame
    item_sim: np.ndarray
    user_factors: np.ndarray
    item_factors: np.ndarray
    svd: object
    als_model: object | None
    content: ContentScorer
    # Cold-start caches
    cluster_pops: dict[int, pd.DataFrame] = field(default_factory=dict)
    province_pops: dict[str, pd.DataFrame] = field(default_factory=dict)
    district_pops: dict[str, pd.DataFrame] = field(default_factory=dict)
    # Parameters
    cf_weight: float = 0.7
    content_weight: float = 0.3

    # ----- save/load -----
    def save(self, out_dir: str | Path) -> None:
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        job = {
            "item_sim": self.item_sim,
            "user_factors": self.user_factors,
            "item_factors": self.item_factors,
            "svd_components": self.svd.components_,
            "svd_explained_var": self.svd.explained_variance_ratio_,
            "als_model": self.als_model,
            "content_item_spec": self.content.item_spec,
            "content_feature_columns": self.content.feature_columns,
            "user_index": self.data.user_index,
            "item_index": self.data.item_index,
            "index_user": self.data.index_user,
            "index_item": self.data.index_item,
            "cluster_pops": {k: v.to_dict("records") for k, v in self.cluster_pops.items()},
            "province_pops": {k: v.to_dict("records") for k, v in self.province_pops.items()},
            "district_pops": {k: v.to_dict("records") for k, v in self.district_pops.items()},
            "cf_weight": self.cf_weight,
            "content_weight": self.content_weight,
            "model_meta": {
                "n_users": self.data.n_users,
                "n_items": self.data.n_items,
                "n_factors": self.user_factors.shape[1],
            },
        }
        with open(out_dir / "cf_recommender.pkl", "wb") as f:
            pickle.dump(job, f)
        # Also save the catalog and profiles for inference (CSV, easy to load)
        self.catalog.to_csv(out_dir / "phone_catalog_for_inference.csv", index=False)
        # Save a richer profile subset — the reason generator needs
        # interests, budget, brand, etc.
        keep_cols = [
            "customer_id", "province", "district", "cluster_id", "cluster_name",
            "age", "gender", "budget_min_npr", "budget_max_npr",
            "preferred_brand", "brand_loyalty_score",
            "gaming_interest", "camera_interest", "battery_interest", "display_interest",
            "performance_interest", "software_interest", "value_interest",
            "chipset_tier",
        ]
        keep_cols = [c for c in keep_cols if c in self.profiles.columns]
        self.profiles[keep_cols].to_csv(
            out_dir / "customer_profiles_for_inference.csv", index=False
        )

    @classmethod
    def load(cls, out_dir: str | Path) -> "CFRecommender":
        out_dir = Path(out_dir)
        with open(out_dir / "cf_recommender.pkl", "rb") as f:
            job = pickle.load(f)
        catalog = pd.read_csv(out_dir / "phone_catalog_for_inference.csv")
        profiles = pd.read_csv(out_dir / "customer_profiles_for_inference.csv")
        # Rebuild the matrices' meta
        n_users = len(job["index_user"])
        n_items = len(job["index_item"])
        train_csr = sp.csr_matrix(
            (np.ones(1, dtype=np.float32), (np.zeros(1, dtype=int), np.zeros(1, dtype=int))),
            shape=(n_users, n_items),
        )
        data = InteractionData(
            train_csr=train_csr,
            test_df=pd.DataFrame(),
            user_index=job["user_index"],
            item_index=job["item_index"],
            index_user=job["index_user"],
            index_item=job["index_item"],
        )
        # Reconstruct a minimal SVD object
        svd = TruncatedSVD(n_components=job["user_factors"].shape[1])
        svd.components_ = job["svd_components"]
        # Rebuild ContentScorer. The two pre-indexed dicts are built
        # here (instead of defaulted to {}) so the per-request hot
        # paths see O(1) lookups on the very first call after load.
        profile_by_cid = (
            dict(zip(
                profiles["customer_id"].astype(str).values,
                [row for _, row in profiles.iterrows()],
            ))
            if "customer_id" in profiles.columns
            else {}
        )
        catalog_by_model = dict(zip(
            catalog["Model_Name"].astype(str).values,
            [row for _, row in catalog.iterrows()],
        ))
        content = ContentScorer(
            catalog=catalog,
            item_spec=job["content_item_spec"],
            feature_columns=job["content_feature_columns"],
            feature_index={c: i for i, c in enumerate(job["content_feature_columns"])},
            user_profiles=profiles,
            profile_by_cid=profile_by_cid,
            catalog_by_model=catalog_by_model,
        )
        return cls(
            data=data,
            catalog=catalog,
            profiles=profiles,
            item_sim=job["item_sim"],
            user_factors=job["user_factors"],
            item_factors=job["item_factors"],
            svd=svd,
            als_model=job["als_model"],
            content=content,
            cluster_pops={int(k): pd.DataFrame(v) for k, v in job["cluster_pops"].items()},
            province_pops={k: pd.DataFrame(v) for k, v in job["province_pops"].items()},
            district_pops={k: pd.DataFrame(v) for k, v in job["district_pops"].items()},
            cf_weight=job["cf_weight"],
            content_weight=job["content_weight"],
        )

    # ----- prediction -----
    def get_recommendations(
        self,
        customer_id: str,
        top_n: int = 5,
        exclude_seen: bool = True,
        exclude_models: Optional[set[str]] = None,
    ) -> list[dict]:
        """Return up to `top_n` recommended phone models for `customer_id`.

        Returns a list of dicts:
            [{"model_name": "...", "score": float, "reason": "..."}]
        """
        exclude_models = exclude_models or set()

        if customer_id not in self.data.user_index:
            return self._cold_start_recommendations(
                customer_id, top_n, exclude_models
            )

        u = self.data.user_index[customer_id]

        # --- CF score (item-item cosine + SVD weighted) ---
        cf_scores = self._cf_score(u)

        # --- Content score (cached per customer_id) ---
        aligned_content = self._get_aligned_content(customer_id)

        # --- Hybrid score ---
        cf_norm = self._minmax(cf_scores)
        content_norm = self._minmax(aligned_content)
        hybrid = self.cf_weight * cf_norm + self.content_weight * content_norm

        # Already-seen items: dim unless the caller wants them.
        # Cache the dense row vector — it's used here and again inside _cf_score.
        seen_dense = self.data.train_csr[u].toarray().ravel()
        if exclude_seen:
            seen_mask = seen_dense > 0
            hybrid[seen_mask] = -np.inf
        # Caller-supplied excludes — bulk-indexed by the precomputed lookup
        if exclude_models:
            item_idx_lookup = self._item_idx_lookup()
            for m in exclude_models:
                i = item_idx_lookup.get(m)
                if i is not None:
                    hybrid[i] = -np.inf

        # Top-N
        n_pick = min(top_n, len(hybrid))
        if n_pick < len(hybrid):
            top_idx = np.argpartition(-hybrid, n_pick - 1)[:n_pick]
            top_idx = top_idx[np.argsort(-hybrid[top_idx])]
        else:
            top_idx = np.argsort(-hybrid)

        # Avoid re-running _make_reason for items that ended up excluded
        # (their hybrid[i] is -inf) — the top_idx slice may still include
        # them when there are fewer than top_n surviving candidates.
        out = []
        for i in top_idx:
            if hybrid[i] == -np.inf:
                continue
            model_name = self.data.index_item[i]
            reason = self._make_reason(customer_id, model_name, cf_scores[i], aligned_content[i])
            out.append({
                "model_name": model_name,
                "score": float(hybrid[i]),
                "reason": reason,
            })
        return out

    # ----- memoised lookups (per-process, built lazily) -----
    def _item_idx_lookup(self) -> dict[str, int]:
        """Lazily-built lookup from model_name → item_index. Used in two
        hot paths (exclude_models + the alignment cache)."""
        cache = getattr(self, "_item_idx_lookup_cache", None)
        if cache is None:
            cache = {m: i for i, m in enumerate(self.data.index_item)}
            self._item_idx_lookup_cache = cache
        return cache

    def _get_aligned_content(self, customer_id: str) -> np.ndarray:
        """Content score vector aligned to `data.index_item` order.

        The expensive bits — building the user spec vector and the
        catalog-order → item-index alignment — only need to run once
        per (customer_id, model-arity) pair. Subsequent calls on the
        same customer (same dashboard mount, same recommendation list)
        return a cached ndarray directly.
        """
        cache = getattr(self, "_content_cache", None)
        if cache is None:
            cache = {}
            self._content_cache = cache
        cached = cache.get(customer_id)
        if cached is not None:
            return cached
        content_scores = self.content.score_user(customer_id)
        catalog_model_order = self.content.catalog["Model_Name"].values
        item_idx_lookup = self._item_idx_lookup()
        n_items = len(self.data.index_item)
        aligned = np.zeros(n_items, dtype=np.float32)
        for j, m in enumerate(catalog_model_order):
            i = item_idx_lookup.get(m)
            if i is not None:
                aligned[i] = content_scores[j]
        cache[customer_id] = aligned
        return aligned

    # ----- helpers -----
    def _cf_score(self, u: int) -> np.ndarray:
        """Weighted CF score combining SVD and item-item cosine.

        We average SVD scores and cosine scores (after z-scoring each to
        comparable scales). Item-cosine alone is item×item → user; SVD is
        dot(user_factor, item_factor). Both should rank similar items.
        """
        # SVD
        svd_scores = self.item_factors.dot(self.user_factors[u])
        # Item-item cosine. The dense row already has the per-item
        # weights, so we don't need a second `.toarray()` against the
        # column slice.
        seen_dense = self.data.train_csr[u].toarray().ravel()
        seen = np.where(seen_dense > 0)[0]
        if len(seen) > 0:
            cosine_scores = self.item_sim[:, seen].dot(seen_dense[seen])
        else:
            cosine_scores = np.zeros(len(self.data.index_item), dtype=np.float32)
        # Z-score each
        def z(x):
            sd = np.std(x)
            if sd < 1e-9:
                return np.zeros_like(x)
            return (x - np.mean(x)) / sd
        return 0.6 * z(svd_scores) + 0.4 * z(cosine_scores)

    def _minmax(self, x: np.ndarray) -> np.ndarray:
        """Min-max normalise; constant arrays become zeros."""
        lo, hi = np.min(x), np.max(x)
        if hi <= lo:
            return np.zeros_like(x)
        return (x - lo) / (hi - lo)

    def _make_reason(
        self,
        customer_id: str,
        model_name: str,
        cf_score: float,
        content_score: float,
    ) -> str:
        """Human-readable reason for why this phone is recommended."""
        row = self.content.profile_by_cid.get(customer_id)
        if row is None:
            # Fall back to the raw profiles frame in case the caller
            # passed an id that wasn't in the load-time index (defensive).
            df_match = self.profiles[self.profiles["customer_id"] == customer_id]
            if df_match.empty:
                return "Popular in your area"
            row = df_match.iloc[0]
        cname = row.get("cluster_name", "")
        # Get the model's spec from the precomputed index
        m = self.content.catalog_by_model.get(model_name)
        if m is None:
            return f"Recommended for {cname} customers" if cname else "Popular in your area"
        # Pick the strongest feature for the reason
        profile = row
        reasons = []
        # Brand match
        pref_brand = normalize_brand(profile.get("preferred_brand", ""))
        if pref_brand and pref_brand == m.get("Brand_norm", ""):
            reasons.append(f"matches your preferred brand {m['Brand']}")
        # Budget match
        bmax = profile.get("budget_max_npr", 0) or 0
        price = m.get("npr_price", 0) or 0
        if bmax and (0.8 * bmax <= price <= 1.2 * bmax):
            reasons.append("fits your budget")
        # Cluster hint
        if cname:
            reasons.append(f"popular with {cname} customers")
        # Dominant interest — `.get` on a Series returns NaN for missing
        # values; coerce to float so `max()` doesn't trip on None.
        interests = {
            "gaming": float(profile.get("gaming_interest", 0) or 0),
            "camera": float(profile.get("camera_interest", 0) or 0),
            "battery": float(profile.get("battery_interest", 0) or 0),
            "display": float(profile.get("display_interest", 0) or 0),
        }
        top_int = max(interests, key=interests.get)
        # Use computed spec columns on the catalog row (added in
        # build_content_scorer) — they're stored on `self.content.catalog`.
        if top_int == "gaming" and m.get("gaming_score", 0) > 0:
            reasons.append("strong gaming performance")
        elif top_int == "camera" and m.get("Main_Camera_MP", 0) >= 50:
            reasons.append(f"{m['Main_Camera_MP']:.0f} MP main camera")
        elif top_int == "battery" and m.get("Battery_mAh", 0) >= 5000:
            reasons.append(f"{m['Battery_mAh']:.0f} mAh battery")
        elif top_int == "display" and m.get("Refresh_Rate_Hz", 0) >= 90:
            reasons.append(f"{m['Refresh_Rate_Hz']:.0f}Hz refresh display")
        if not reasons:
            reasons.append(f"recommended for {cname}" if cname else "popular overall")
        return "; ".join(reasons[:3])

    # ----- cold start -----
    def _cold_start_recommendations(
        self,
        customer_id: str,
        top_n: int,
        exclude_models: set[str],
    ) -> list[dict]:
        """Recommendation path for users with zero interaction history.

        Falls back to: cluster popularity → province popularity →
        district popularity → global popularity.
        """
        row = self.content.profile_by_cid.get(customer_id)
        if row is None:
            df_match = self.profiles[self.profiles["customer_id"] == customer_id]
            if df_match.empty:
                # Unknown user entirely — return global top by recent purchases
                return self._global_top(top_n, exclude_models, "Most popular in Nepal right now")
            row = df_match.iloc[0]

        cluster_id = row.get("cluster_id")
        province = row.get("province")
        district = row.get("district")

        # Score = how popular in cluster × how popular in province × content fit
        # We just stack ranked lists with decreasing weight.
        candidates: dict[str, float] = {}

        # 1. Cluster popularity
        cluster_pop = self.cluster_pops.get(int(cluster_id)) if cluster_id is not None else None
        if cluster_pop is not None:
            n_cluster = len(cluster_pop)
            cluster_models = cluster_pop["model_name"].tolist()
            for rank, m in enumerate(cluster_models):
                candidates[m] = candidates.get(m, 0) + (n_cluster - rank) * 1.0

        # 2. Province popularity
        if province in self.province_pops:
            n_prov = len(self.province_pops[province])
            prov_models = self.province_pops[province]["model_name"].tolist()
            for rank, m in enumerate(prov_models):
                candidates[m] = candidates.get(m, 0) + (n_prov - rank) * 0.5

        # 3. District popularity
        if district in self.district_pops:
            n_dist = len(self.district_pops[district])
            dist_models = self.district_pops[district]["model_name"].tolist()
            for rank, m in enumerate(dist_models):
                candidates[m] = candidates.get(m, 0) + (n_dist - rank) * 0.3

        # 4. Content-based reranking using the profile (cached)
        aligned = self._get_aligned_content(customer_id)
        for i in range(len(self.data.index_item)):
            sc = aligned[i]
            if sc == 0:
                continue
            m = self.data.index_item[i]
            candidates[m] = candidates.get(m, 0) + float(sc) * 0.4

        # Sort and exclude
        ranked = sorted(candidates.items(), key=lambda kv: -kv[1])
        out = []
        cname = row.get("cluster_name", "")
        prov = row.get("province", "")
        for m, sc in ranked:
            if m in exclude_models:
                continue
            if not self._in_budget(m, row):
                continue
            if len(out) >= top_n:
                break
            reason = self._cold_reason(m, cname, prov)
            out.append({"model_name": m, "score": float(sc), "reason": reason})
        if len(out) < top_n:
            # Fall back to global popularity for the rest
            extra = self._global_top(top_n - len(out),
                                     exclude_models | {x["model_name"] for x in out},
                                     "Most popular in Nepal right now")
            out.extend(extra)
        return out

    def _in_budget(self, model_name: str, row) -> bool:
        # O(1) catalog lookup instead of a boolean-mask scan.
        m = self.content.catalog_by_model.get(model_name)
        if m is None:
            return True
        bmin = float(row.get("budget_min_npr", 0) or 0)
        bmax = float(row.get("budget_max_npr", float("inf")) or float("inf"))
        price = float(m.get("npr_price", 0) or 0)
        return bmin * 0.6 <= price <= bmax * 1.3

    def _cold_reason(self, model_name: str, cluster_name: str, province: str) -> str:
        bits = []
        if cluster_name:
            bits.append(f"popular with {cluster_name}")
        if province:
            bits.append(f"trending in {province}")
        if not bits:
            bits.append("popular in Nepal right now")
        return "; ".join(bits)

    def _global_top(self, n: int, exclude: set[str], reason: str) -> list[dict]:
        if 0 in self.cluster_pops:
            top = self.cluster_pops[0]  # biggest cluster
        else:
            return []
        out = []
        for m in top["model_name"].tolist():
            if m in exclude:
                continue
            out.append({"model_name": m, "score": 0.0, "reason": reason})
            if len(out) >= n:
                break
        return out


# ---------------------------------------------------------------------------
# Cold-start popularity caches
# ---------------------------------------------------------------------------
def build_popularity_caches(
    interactions: pd.DataFrame,
    profiles: pd.DataFrame,
    catalog: pd.DataFrame,
) -> tuple[dict[int, pd.DataFrame], dict[str, pd.DataFrame], dict[str, pd.DataFrame]]:
    """Pre-compute per-cluster / per-province / per-district popularity lists
    (model, score) based on purchase events only."""
    purchases = interactions[interactions["interaction_type"] == "purchase"].copy()
    if purchases.empty:
        return {}, {}, {}
    # Merge cluster / province / district info onto purchases
    pcols = ["customer_id", "province", "district", "cluster_id", "cluster_name"]
    merged = purchases.merge(profiles[pcols], on="customer_id", how="left")

    cluster_pops = {}
    for cid, grp in merged.groupby("cluster_id"):
        ranking = (
            grp.groupby("model_name")
               .size()
               .reset_index(name="n_purchases")
               .sort_values("n_purchases", ascending=False)
               .head(20)
        )
        cluster_pops[int(cid)] = ranking

    province_pops = {}
    for prov, grp in merged.groupby("province"):
        ranking = (
            grp.groupby("model_name")
               .size()
               .reset_index(name="n_purchases")
               .sort_values("n_purchases", ascending=False)
               .head(20)
        )
        province_pops[prov] = ranking

    district_pops = {}
    for dist, grp in merged.groupby("district"):
        ranking = (
            grp.groupby("model_name")
               .size()
               .reset_index(name="n_purchases")
               .sort_values("n_purchases", ascending=False)
               .head(20)
        )
        district_pops[dist] = ranking

    return cluster_pops, province_pops, district_pops


# ---------------------------------------------------------------------------
# Top-level training entrypoint
# ---------------------------------------------------------------------------
def train(cold_users: set[str], cold_items: set[str]) -> CFRecommender:
    """Full training pipeline."""
    print("Loading interactions …")
    interactions = load_interactions()
    print(f"  {len(interactions)} rows, date range "
          f"{interactions['timestamp'].min().date()} to {interactions['timestamp'].max().date()}")

    print("Time-based split …")
    train_df, test_df, cutoff = time_split(interactions)
    print(f"  cutoff = {cutoff.date()}; train = {len(train_df)}, test = {len(test_df)}")

    print("Building user×item matrix …")
    data = build_matrices(train_df, test_df, cold_users, cold_items)
    sparsity = 1.0 - data.train_csr.nnz / (data.n_users * data.n_items)
    print(f"  shape = ({data.n_users}, {data.n_items}); nnz = {data.train_csr.nnz}; "
          f"sparsity = {sparsity * 100:.2f}%")

    print("Fitting item-item cosine …")
    item_sim = fit_item_cosine(data.train_csr)

    print("Fitting SVD …")
    user_factors, item_factors, svd = fit_svd(data.train_csr, n_factors=64)
    print(f"  factors = {user_factors.shape}")

    print("Fitting implicit ALS …")
    als = fit_als(data.train_csr) if HAS_IMPLICIT else None
    print(f"  als fitted = {als is not None}")

    print("Building content scorer …")
    catalog = pd.read_csv(PHONE_CATALOG_CSV)
    profiles = pd.read_csv(PROFILES_CSV)
    content = build_content_scorer(catalog, profiles)
    print(f"  item_spec shape = {content.item_spec.shape}")

    print("Building cold-start popularity caches …")
    cluster_pops, province_pops, district_pops = build_popularity_caches(
        interactions, profiles, catalog
    )
    print(f"  cluster_pops: {len(cluster_pops)} clusters")
    print(f"  province_pops: {len(province_pops)} provinces")
    print(f"  district_pops: {len(district_pops)} districts")

    return CFRecommender(
        data=data,
        catalog=catalog,
        profiles=profiles,
        item_sim=item_sim,
        user_factors=user_factors,
        item_factors=item_factors,
        svd=svd,
        als_model=als,
        content=content,
        cluster_pops=cluster_pops,
        province_pops=province_pops,
        district_pops=district_pops,
    )