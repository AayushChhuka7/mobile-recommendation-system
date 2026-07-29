# 02 — Architecture Review

> A line-by-line architectural review of the current system, plus a proposed target.
> Diagrams are in `diagrams/`.

---

## 1. Current architecture

The project runs as three docker services orchestrated by `docker-compose.yml`:

```
┌──────────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│  frontend (Vite SPA) │   │  backend  (Express)  │   │  ml-service (FastAPI)│
│  port 5173           │   │  port 4000           │   │  port 8002           │
└──────────┬───────────┘   └──────────┬───────────┘   └──────────┬───────────┘
           │ /api/*                    │ /api/*                    │ /recommend
           └──────────────────────────▶│                           │
                                      │ fetch() 8s timeout         │
                                      ├──────────────────────────▶│
                                      │                           ├─ XGBoost JSON
                                      │                           ├─ scoring_snapshot
                                      │                           ├─ category_dtypes
                                      │                           └─ After_EDA CSV
                                      │
                                      │ Prisma 7 (driver-adapter)
                                      ▼
                                ┌────────────┐
                                │ PostgreSQL │
                                │ port 5432  │
                                └────────────┘
```

### 1.1 What is good

- **Single source of truth for the ML pipeline.** `MobileRecommendationPipeline` is loaded once at FastAPI startup, all requests reuse the same booster. No model re-loading per request.
- **Frozen preprocessing.** `categorical_dtypes.json` and `scoring_snapshot.json` are written at train time and read at predict time. This is the right pattern for production.
- **`enable_categorical=True` on XGBoost.** Correct — you have 28 categorical columns and one-hot would explode the dimensionality.
- **`tree_method='hist'`.** Correct — the dataset has ~5k rows × 120 features and `hist` is the right algorithm.
- **`@asynccontextmanager lifespan`** for startup. Correct FastAPI pattern.
- **Lazy `TreeExplainer`** in `model.py` — SHAP is computed only when `/explain` is called.
- **3NF Prisma schema.** `Brands`, `Phones`, `PhoneVariants`, `PhoneSpecs`, `Users`, `Roles`, `Otp`, `Session`, `CustomerProfile`, `UserPreference`, `UserProfile`, `RecommendationHistory`, `Wishlist`, `ComparisonHistory`, `AdminStatsCache`.
- **Cache FKs as nullable** (`AdminStatsCache.mostRecommendedPhoneId` → `Phones.phoneId` with `onDelete: SetNull`). This is a thoughtful design choice that preserves historical snapshots.

### 1.2 What is fragile

- **`/recommend` falls back to NaN candidates on schema drift.** If `feature_columns.json` ever has a column the CSV does not, the service returns a 503 — but does not log which column. Add `logger.error("missing column %s", col)` before raising.
- **`ScoringSnapshot.quantiles` is computed from the full training matrix.** If you retrain on a smaller dataset and a phone's value falls outside the frozen `(lo, hi)`, the score is clipped to the boundary. Document this or re-train and re-snapshot in lockstep.
- **`recommendService.mjs` does `contains: item.Model` with `mode: "insensitive"`** to join ML results back to the DB. This is brittle — `item.Model` from the ML side is the **dataset** model name (e.g. `Apple iPhone 16 Pro Max 1TB`), but `modelName` in the DB may be normalised to `Apple iPhone 16 Pro Max`. Add a `Model_Name_normalized` column or join on a stable slug.
- **Two-stage join** (ML → DB enrich) runs N queries per request (`Promise.all(map(async (item) => prisma.phones.findFirst(...)))`). With `topN = 50`, that's 50 round-trips per `/recommend`. Use `findMany({ where: { OR: [...] } })` instead.
- **`backend/.gitignore` includes `src/generated/prisma`** but the `package.json` does not have a `postinstall: prisma generate`. A fresh clone cannot start the backend without manual `prisma generate`.
- **`ml.mjs`** (the config that exports `ML_BASE_URL`) has `try { ... } catch { ... }` returning a placeholder URL. The error path is silent. Add `logger.warn(...)`.
- **`CustomerProfile.recommendationHistory` is a back-relation but the segment column is not in the schema.** The segmentation output sits in `customer_segments.csv` but there is no `clusterId Int?` column. See `sql/02_segment_membership.sql`.

### 1.3 What is wrong

- **`returnValue === undefined` in `recommendService.mjs`** — the function returns the result of `Promise.all` but does not check whether `mlResults.length === 0`. The early return at line 61 handles this, but the variable `enriched` is shadowed.
- **`_DIM_KEY_NORMALIZE` in `serve.py` has both `"gaming": "Gaming"` and the FE uses `gaming` — but only 4 keys come from the FE. If the FE adds `software: 5`, the route accepts it (the validator does not require all 9 dims), so the missing dimensions default to 3.** Document this or make the API explicit about which 9 keys are valid.
- **`_error_envelope`** in `serve.py` is defined but the `@app.exception_handler(HTTPException)` handler is **registered twice** (lines 478 and commented-out block at 459). This is dead code.
- **Compare endpoint** at line 320 has a **commented-out implementation** with the active one at line 330 doing the same thing. Delete the dead code.
- **`startup` event is registered twice** — once with the modern `lifespan` (line 120) and once with `@app.on_event("startup")` (line 190). The second one re-loads candidates. The first one already does. This double-load is a startup latency hit and a code smell.
- **The `frontend/.gitignore` and the Vite config** are not visible in the read I did, but the **bundled images** (`assets/iphone12pm.jpeg`, `assets/samsungs25.jpeg`, etc.) suggest static asset URLs. These will break when the API delivers phone images via `imageUrl` from the DB. Use a CDN URL or a relative `/images/phones/` mount.

### 1.4 What is missing

- **Service health checks** beyond `/health` — no `/readyz` (model loaded AND candidates loaded), no `/livez`.
- **A graceful-shutdown handler** in FastAPI. `uvicorn` handles SIGTERM, but the XGBoost booster's `predict` is in C — if a request is mid-flight when shutdown starts, you can segfault. Use `signal.signal(SIGTERM, ...)` or run uvicorn with `--graceful-timeout`.
- **API versioning.** `/recommend` lives at the root, not `/v1/recommend`. When the new LTR ranker ships, you'll have to break clients.
- **Per-user rate limiting.** Without a rate limiter, a single bad actor can exhaust the XGBoost budget.
- **Prometheus metrics.** `/metrics` endpoint exposing request count, latency histogram, model-loaded boolean, candidate-pool size.

---

## 2. Proposed target architecture

The change list:

1. **Add an `ml-models` package** with sub-packages per model: `ml_models/antutu_regressor`, `ml_models/brand_loyalty`, `ml_models/camera_tier`, `ml_models/churn`, `ml_models/ranker`. Each has its own `train.py`, `predict.py`, `model_card.md`.
2. **Replace the single booster** with a **model registry** keyed on `model_name`. The FastAPI app loads them lazily.
3. **Add an `experiment` layer** — every `/recommend` logs `(user_id, persona, topN, model_version, returned_phone_ids, clicked)` to a new `RecommendationEvent` Prisma table. This is the raw material for offline ranking metrics and online A/B tests.
4. **Add a `feedback` route** `POST /api/recommendations/:id/click` so the user click is captured.
5. **Persist the segmentation output** by adding `clusterId` to `CustomerProfile` and a `Segment` table with the human-readable names from `cluster_profiles.json`.
6. **Add a SHAP-aggregated dashboard** at `/api/admin/explanations` that returns the top-3 SHAP features aggregated by cluster.

---

## 3. ML-side notes

### 3.1 The pipeline is well-factored — keep it

```
pipeline/
  __init__.py
  features.py      ← raw row → 152-column engineered frame
  scoring.py       ← 152-col frame → 11 dimension scores
  recommend.py     ← 11-dim + persona → ranked list
  model.py         ← XGBoost wrapper + SHAP + categorical manager
  train.py         ← CSV → artefacts
  serve.py         ← FastAPI
  test_pipeline.py ← artifact round-trip test
```

To add more XGBoost models, follow this pattern:

```
ml_models/
  brand_loyalty/
    features.py    ← engineered schema → brand-loyalty input
    train.py
    predict.py
    model_card.md
    tests/
      test_train.py
      test_predict.py
  camera_tier/
    ...
  ...
```

Each model has its own train/predict and is loaded by the registry in `serve.py`.

### 3.2 Quantile clipping is a real concern

`_clip_norm` clips a value to the `(lo, hi)` quantile from training time. If the production dataset drifts (a 2027 phone with 1TB RAM), the value gets clipped to the 99th percentile and the score is misleading.

**Mitigations.**
- Re-train and re-snapshot quarterly.
- Add a `clip_warnings` log line per request: `if x > hi: log.warning("clipped %s from %.1f to %.1f", col, x, hi)`.
- In the response, return the raw `x` and the clipped value separately so the frontend can show "the model expected up to N, this phone has more".

### 3.3 Cold-start

A new user with no `RecommendationHistory` has no segment, no preference vector. The current `/recommend` works because it only needs `persona + budget`. But the **segmentation** layer has no fallback.

**Mitigation.** Add a `k-NN on UserPreference` lookup: when a new user fills the questionnaire (`UserPreference` is already in the schema), find the 5 nearest existing customers in `(usage_type, camera_preference, max_budget)` space and inherit their cluster ID.

### 3.4 The two clustering notebooks are duplicates

`customer_segmentation_continuation.ipynb` and `segmentation_own.ipynb` produce identical outputs (same `k=3`, same centroids, same cluster names) but write to `segmentation_outputs/` and `segmentation_outputs1/` respectively. Delete `segmentation_own.ipynb`. Keep the `continuation` one because it has the explicit `cluster_profiles.json` export.

---

## 4. Recommendations (one-line each)

- **Refactor the FastAPI service to a model registry.** See `06_research_paper_extensions.md`.
- **Add Prisma tables** for `Segment`, `SegmentMembership`, `RecommendationEvent`. See `sql/`.
- **Replace K-Means** with **Gaussian Mixture + bootstrap stability ARI**. See `09_segmentation_improvements.md`.
- **Add a learning-to-rank model.** See `xgboost_ideas/06_lambda_ranker.md`.
- **Add SHAP for every model.** See `04_explainability_xai.md`.

---

## 5. Quick wins (≤ 1 day each)

1. Delete `segmentation_own.ipynb`. (5 minutes.)
2. Delete the duplicate `@app.on_event("startup")` block in `serve.py`. (10 minutes.)
3. Add a `prisma generate` `postinstall` script to `backend/package.json`. (5 minutes.)
4. Add `logger = logging.getLogger("uvicorn.error")` to every `print()` in `serve.py`. (20 minutes.)
5. Replace the N-query `Promise.all` in `recommendService.mjs` with `findMany`. (30 minutes.)
6. Add a `tests/test_smoke.py` that POSTs `/health` and asserts `model_loaded=true`. (1 hour.)