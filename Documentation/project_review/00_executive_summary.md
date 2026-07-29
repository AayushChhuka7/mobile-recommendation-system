# Executive Summary — One-Page Review

**Project:** Customer Segmentation and Intelligent Mobile Recommendation System
**Stack:** Node 22 / Express 5 / Prisma 7 / PostgreSQL 16 + Python 3.11 / FastAPI / XGBoost / SHAP + React 19 / Vite 7
**Scope of review:** Code, schema, ML pipeline, docs, deployment story — *no changes applied.*

---

## TL;DR

The project is **functionally correct** (predictive pipeline runs, SHAP works, recommendation endpoint serves), **architecturally coherent** (clean Express+Prisma+Python split, normalized schema), and **explainable at one layer** (XGBoost predictions have SHAP). What it **lacks for a research-grade defence** is breadth of ML, an experimentation layer, and a written MLOps story.

Three numbers tell the story:

| Metric                                      | Value           | Verdict                                                                |
| ------------------------------------------- | --------------- | ---------------------------------------------------------------------- |
| XGBoost AnTuTu test R²                      | **0.852**       | Strong. Slight overfit (train R² 0.990). Add early stopping.           |
| 5-fold CV R² (std)                          | 0.850 ± 0.016  | Stable. Already acceptable for production.                              |
| K-Means silhouette (customer segmentation) | **0.133**       | Weak. Below the "0.5 is reasonable" line. Try GMM, DBSCAN, or feature selection. |

---

## The 5 most important recommendations (ranked)

1. **Add 3–5 more XGBoost models.** The dataset supports `BrandLoyalty`, `CameraTier`, `TechTier`, `ChurnRisk`, and a **learning-to-rank** LambdaMART model. See `xgboost_ideas/`. This single change upgrades the thesis from "one model" to "ML system".
2. **Re-run K-Means with `StandardScaler` on fewer, better features** or switch to Gaussian Mixture / hierarchical. Current silhouette 0.13 means the 3 clusters overlap badly. See `09_segmentation_improvements.md`.
3. **Write the MLOps story now** — even if it is not implemented. `model_card.md`, `data_card.md`, a `README` for the `ML Model/pipeline/` package, a small test (`pytest tests/test_pipeline.py`), and a `make train` target. See `05_mlops_production_readiness.md`.
4. **Persist the segmentation output.** The `customer_segments.csv` is sitting in `ML Model/segmentation_outputs/` and nothing reads it. Add a Prisma migration (`sql/02_segment_membership.sql`), a `GET /api/users/me/segment` route, and a single React tile. This closes the customer-side loop.
5. **SHAP for every XGBoost model + a counterfactual layer.** Beyond the existing XGBoost-on-AnTuTu SHAP, add global SHAP summary plots for each new model, partial dependence for the ranker, and counterfactual explanations for individual recommendations. See `04_explainability_xai.md`.

---

## Honest weaknesses a reviewer will spot

- **Two parallel segmentation notebooks** (`customer_segmentation_continuation.ipynb` and `segmentation_own.ipynb`) with **identical code and identical outputs** but written into different folders. Delete one.
- **`cameras` vs `cameras`** typo in `Content_Based_Recommendation.ipynb` (it says "Parse browsing history" — fine, but the codebase mixes `cameras` and `cameras` across notebooks).
- **No tests.** `package.json` has `"test": "echo \"Error: no test specified\" && exit 1"` which fails deliberately. The Python pipeline has `pipeline/test_pipeline.py` (good!) but the rest of the project has nothing.
- **Two clusters dominate the dataset.** Cluster 0 (48.5%) is "Premium Xiaomi Budget — Frequent but Lapsing", Cluster 2 (37.9%) is "Luxury Xiaomi Battery-focused — Frequent but Lapsing". The names disagree with the **spend** (Cluster 0 mean spend NPR 170k ≠ Premium, Cluster 2 spend NPR 235k ≠ Luxury). The auto-labeller is fragile; replace with quantile-based labels.
- **Currency is mixed.** Dataset is NPR (Nepalese Rupee); the model and the UI use EUR. Hard-coded `npr_to_eur = 1 / 150` in `Content_Based_Recommendation.ipynb` is a maintenance trap.
- **Cold-start is unsolved.** A new user with no purchase history has no cluster. Add a fallback in `recommendService.mjs` that uses `UserPreference` (which already exists in the schema) to pick the nearest cluster centroid.
- **`/recommend` returns only phones that exist in the dataset.** The `predict_new` endpoint can score a brand-new phone but is not wired through the recommend endpoint. Either wire it or document why not.

---

## What is already great (do not refactor)

- **Feature engineering discipline.** `pipeline/features.py` ports 14 notebook cells into pure, idempotent functions with documented provenance. This is publication-quality.
- **`CategoricalDtypeManager`** (in `pipeline/model.py`) freezes the train-time category list so predict-time novel categories become NaN instead of crashing. This is a non-trivial production decision; keep it.
- **`ScoringSnapshot`** (in `pipeline/scoring.py`) freezes quantiles from training time so scoring a single new phone row uses the same scale. Same story — keep.
- **SHAP is already integrated** into the FastAPI service (`/explain/{model_name}` and `/predict` both return SHAP). The plumbing exists; just expand the inputs.
- **Prisma schema is normalised** — `Brands` → `Phones` → `PhoneVariants` → `PhoneSpecs` is textbook 3NF, with proper indexes and nullable historical caches (`AdminStatsCache`).
- **The persona presets** in `pipeline/recommend.py` are explicit and tunable. This is a strength — most academic projects hard-code weights.

---

## What would make this publishable

See `06_research_paper_extensions.md`. Short version: a focused paper needs (a) a clear research question, (b) a baseline vs proposed experiment with offline metrics, (c) a human-evaluation study on the explanations, and (d) a negative-results section. The data and models are already there; the experiment framing is not.

---

## What would make this a BCT grade-A defence

See `12_thesis_defense_checklist.md`. Top five viva questions a panel will ask, and how to answer them in one sentence each.