# 01 — Project Audit

> A walk-through of what the project actually is, what is present, what is missing,
> and what is risky.

---

## 1. What this project is

A full-stack recommendation platform with three containers:

```
┌────────────┐    HTTP    ┌──────────────────┐    HTTP     ┌──────────────────┐
│ React/Vite │ ─────────▶ │ Express + Prisma │ ──────────▶ │ FastAPI + XGBoost │
│ frontend/  │            │      backend/    │             │   ML Model/      │
└────────────┘            └──────────────────┘             └──────────────────┘
                                  │                                  │
                                  ▼                                  ▼
                           ┌──────────┐                      ┌─────────────┐
                           │ Postgres │                      │ XGBoost JSON│
                           │  16      │                      │  SHAP tree  │
                           └──────────┘                      └─────────────┘
```

The FastAPI sidecar at `ML Model/pipeline/serve.py` loads `artifacts/model.json`
(XGBoost), `artifacts/scoring_snapshot.json` (frozen quantiles for composite scoring),
`artifacts/category_dtypes.json` (frozen category index), and `After_EDA_and_Feature_ENginering.csv`
(pre-scored candidate pool).

---

## 2. What is present (verified by reading the tree)

### Backend (`backend/`)

| Component                | Status                                                              |
| ------------------------ | ------------------------------------------------------------------- |
| Prisma schema            | ✅ Normalized (`Brands`, `Phones`, `PhoneVariants`, `PhoneSpecs`, `Users`, `Otp`, `Session`, `Roles`, `CustomerProfile`, `RecommendationHistory`, `Wishlist`, `ComparisonHistory`, `AdminStatsCache`, `UserProfile`, `UserPreference`). |
| Migrations               | ✅ 14 migrations from `20260628051029_initial` to `20260707142149_normalize_phones_into_brands_variants_specs` |
| Auth (Passport-Local)    | ✅ Session cookie, OTP-based registration, password reset            |
| RBAC (Phase 1)           | ✅ `Customer`, `Salesman`, `Admin` roles                             |
| REST routes              | ✅ `authRoutes`, `phoneRoutes`, `userRoutes`, `recommendRoutes`, `ownUserRoutes`, `productRoutes`, `main` |
| Recommendation proxy     | ✅ `recommendService.mjs` → FastAPI `/recommend` + DB enrichment     |
| Comparison               | ✅ `compareWithML` → FastAPI `/compare`                              |
| Wishlist                 | ✅ 1-to-many, unique on `(userId, phoneId)`                          |
| Bulk import              | ✅ `import-gsmarena-bulk.mjs` from `GSMArena_Cleaned_Dataset.csv`    |
| Tests                    | ❌ None. `npm test` exits 1 deliberately                             |
| CI                       | ❌ None                                                              |
| OpenAPI / Swagger        | ❌ None                                                              |

### ML service (`ML Model/pipeline/`)

| Component                    | Status                                                          |
| ---------------------------- | --------------------------------------------------------------- |
| XGBoost trainer              | ✅ `train.py` (R² 0.85, MAE 0.19 log, 5-fold CV 0.85 ± 0.016)   |
| Production feature pipeline  | ✅ `features.py` — 14 idempotent functions, no global state     |
| Composite scoring            | ✅ `scoring.py` — 11-dimension scoring with frozen quantiles    |
| Ranking function             | ✅ `recommend.py` — 5 persona presets + custom weights          |
| Model wrapper                | ✅ `model.py` — `MobileRecommendationPipeline` class             |
| FastAPI server               | ✅ `serve.py` — `/health`, `/predict`, `/predict_new`, `/score`, `/recommend`, `/compare`, `/explain/{model_name}`, `/phones` |
| SHAP explainer               | ✅ TreeExplainer (lazy-init), top-N per prediction              |
| Tests                        | ⚠ `pipeline/test_pipeline.py` exists but only exercises artifacts |
| Model card / data card       | ❌ None                                                          |

### Notebooks (`ML Model/*.ipynb`)

| Notebook                                       | Purpose                                                                | Issue                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `EDA_and_Feature_Engineering_to_Dataset.ipynb` | Source of all 152 features; 134k tokens                                | Reference, but extremely long; not reproducible cell-by-cell easily     |
| `Preprocessing_all_dataset.ipynb`              | Source of cleaned 100-column schema                                    | Reference                                                               |
| `Content_Based_Recommendation.ipynb`           | Content-based recommender using cosine similarity on phone features    | Hard-coded NPR→EUR `1/150` rate. Cluster-boost only 0.05 — too weak    |
| `customer_segmentation_continuation.ipynb`     | K-Means on per-customer features (4557 customers, 3 clusters)         | Silhouette 0.13; cluster labels don't agree with cluster means         |
| `segmentation_own.ipynb`                       | Duplicate of the above with a different output folder                  | **Should be deleted** — duplicate code, duplicate outputs              |

### Frontend (`frontend/`)

| Component        | Status                                                                       |
| ---------------- | ---------------------------------------------------------------------------- |
| Vite + React 19  | ✅ SPA shell with router, auth context                                      |
| Auth flow        | ✅ `Login`, `Registration`, `ForgotPassword`, `AuthShared`                   |
| Dashboard        | ✅ `Dashboard.jsx`                                                           |
| Phone listing    | ✅ `PhoneListing.jsx`                                                        |
| Phone detail     | ✅ `PhoneDetail.jsx`                                                         |
| Compare          | ✅ `Compare.jsx` + `ComparePanel.jsx`                                        |
| ML services      | ✅ `services/recommend.js`, `services/phones.js`, `services/api.js`          |
| SHAP display     | ⚠ Recommendations show "why" strings (text only); no per-feature SHAP chart |
| Segment display  | ❌ No page that shows the user's segment from `cluster_profiles.json`        |

### Datasets (`dataset/`)

| File                              | Rows   | Purpose                                               |
| --------------------------------- | ------ | ----------------------------------------------------- |
| `customer_dataset.csv`            | 16,608 | Per-transaction; 4,557 unique customers               |
| `GSMArena_Cleaned_Dataset.csv`    | 8,500  | Cleaned phone specs (100 columns, many imputed flags) |

### Documentation

| File                                  | Quality                                                                |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `README.md`                           | ✅ Very detailed (469 lines)                                            |
| `Documentation/FUTURE_WORK.md`        | ✅ Honest about gaps (Prose: "tech stack divergence from proposal")     |
| `Documentation/mid term prop/`        | ⚠ Gantt chart, system architecture diagrams — present but informal    |

---

## 3. What is missing

### 3.1 Engineering

- **No automated tests** in the backend or the FastAPI service.
- **No model versioning** — `model.json` lives in `artifacts/` but there is no MLflow, no DVC, no timestamped artifact dir.
- **No drift monitoring** — if a new phone SKU has a chip family not seen in training, the `CategoricalDtypeManager` correctly maps it to NaN, but there is no alert.
- **No rate limiting** on the public recommendation endpoint (the project claims 50/req/min in `recommendRoutes.mjs` but I have not verified it).
- **No CORS tightening** — `serve.py` has `allow_origins=["*"]`.
- **No structured logging** — `console.log` everywhere.
- **No OpenAPI spec** generated from FastAPI (the project has `/docs` but it's the default Swagger UI, not an exported spec).

### 3.2 ML

- **One XGBoost model** for one target. See `xgboost_ideas/` for 12 more.
- **K-Means is the only clustering algorithm.** Silhouette 0.13 means clusters overlap. Try GMM, Agglomerative, or HDBSCAN.
- **No learning-to-rank.** The current recommender is a weighted sum of dimension scores — there is no model that *learns* the weights from user feedback.
- **No evaluation harness.** Offline metrics (NDCG@K, MAP@K, MRR) are missing.
- **No A/B test** — even a logged-only experiment would let you compare two rankers.
- **No LTV / churn model** — the dataset supports both.

### 3.3 Explainability / XAI

- **SHAP for one model only.** LIME, ELI5, partial dependence, counterfactuals — none are used.
- **No fairness audit.** `gender`, `country`, `age_bucket` are all in the data. There is no test for disparate impact.
- **No global feature-importance plot** in the README or the report.

### 3.4 Research framing

- **No ablation study** — what happens if you remove the XGBoost step? Use rule-based scoring?
- **No comparison vs baselines** — random, popularity, kNN, ALS, LightFM, neural CF.
- **No human-evaluation study** — "do users prefer the SHAP explanation or a text-only reason?"
- **No statistical tests** — paired t-test, bootstrap CI on NDCG@K.

---

## 4. Risk register

| Risk                                                  | Severity | Mitigation                                                                  |
| ----------------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| Currency mismatch (NPR vs EUR) corrupts budget filter | High     | Pin a single source of truth (recommend service takes `budget_eur` directly)|
| Two duplicate notebooks cause confusion at viva       | Medium   | Delete `segmentation_own.ipynb`                                              |
| Cluster labels disagree with cluster means            | Medium   | Replace rule-based labeler with quantile-based labels                       |
| `predict_new` is reachable but `/recommend` does not use it | Medium   | Document why (candidate pool is curated; predict_new is for ad-hoc)         |
| Hard-coded silhouette threshold for k selection        | Low      | Add gap-statistic and bootstrap stability ARI to the diagnostics             |
| Categorical dtype drift on new chip families           | Low      | Already handled by `CategoricalDtypeManager`; add an alert on every NaN     |

---

## 5. Suggested order of work (12-week plan for the team)

| Week | Deliverable                                                                                  |
| ---- | -------------------------------------------------------------------------------------------- |
| 1    | Delete `segmentation_own.ipynb`. Fix NPR→EUR. Add `pytest` to `pipeline/test_pipeline.py`.   |
| 2    | Add the 3 highest-value XGBoost models: `BrandLoyalty`, `CameraTier`, `TechTier`.            |
| 3    | Wire them through the FastAPI service and add a `/explain` endpoint for each.                |
| 4    | Add the 3 next-best: `Churn`, `LTV`, `PriceValue`.                                          |
| 5    | Build a learning-to-rank LambdaMART model on `(user, phone, persona, label=clicked)` history.|
| 6    | Add a SHAP summary plot and per-cluster SHAP to the React UI.                               |
| 7    | Add Prisma tables for `Segment`, `SegmentMembership`, `ModelRegistry`, `DriftLog`.            |
| 8    | Persist the segmentation output and add a `/api/users/me/segment` route.                     |
| 9    | Write `model_card.md`, `data_card.md`, and a `README.md` for `ML Model/pipeline/`.           |
| 10   | Build an offline evaluation harness (NDCG@K, MAP@K) on a held-out split.                     |
| 11   | Run an A/B test against the current ranker (logged-only if no traffic).                      |
| 12   | Write the final report. Export SHAP plots and the segmentation dashboard.                   |

This plan keeps the project **runnable at every step** — no big-bang migration.