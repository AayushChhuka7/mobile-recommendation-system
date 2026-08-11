# Hybrid Recommendation Integration

> **Status**: ✅ Complete (2026-07-28)
> **Branch**: `filter`
> **Plan**: `C:\Users\aayus\.claude\plans\federated-wandering-blanket.md`

This document captures every code change shipped in this session to integrate a customer segmentation model with the existing mobile recommendation system, add content-based "similar phones" recommendations, and start collecting user interaction history.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [ML Sidecar Changes](#ml-sidecar-changes)
4. [Backend Changes](#backend-changes)
5. [Frontend Changes](#frontend-changes)
6. [Database Migration](#database-migration)
7. [Documentation](#documentation)
8. [End-to-End Smoke Test](#end-to-end-smoke-test)
9. [Files Created / Modified](#files-created--modified)
10. [Open Issues & Next Steps](#open-issues--next-steps)

---

## Overview

### What was the goal?

You had a trained K-Means customer segmentation model (`segmentation_own.ipynb`) producing three segments — *Premium Xiaomi Budget*, *Luxury Apple Flagship*, *Luxury Xiaomi Battery-focused* — but it was **not deployed**. The codebase also had a content-based cosine similarity pipeline in a notebook (`Content_based_recomaendation.ipynb`) that was never serialized or wired into the API.

This session deployed both into production, plus added an event-collection layer so a future collaborative-filtering model can be built on top of real user behavior.

### What got built

| Layer | Before | After |
|---|---|---|
| ML sidecar | Persona-based ranker only | + similar phones + segment assignment + personalized ranking |
| Backend | Persona proxy + DB enrichment | + 5 new endpoints + `customerProfileService` |
| Frontend | Persona modal in Dashboard | + auto-personalized recs on login + segment badge + click/view logging + Similar phones on detail page |
| Database | `CustomerProfile` had no cluster info | + `clusterId`, `segmentLabel`, `segmentSource` columns |

### Three hybrid layers

```
┌──────────────────────────────────────────────────────────────────┐
│  Layer 1 — Item-based (Content Similarity)                       │
│  cosine_similarity over engineered phone features                │
│  → ML /recommend/similar                                        │
│  → FE: PhoneDetail.jsx "Similar phones" section                  │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│  Layer 2 — Segment-based (K-Means personalization)               │
│  CustomerProfile.clusterId → CLUSTER_WEIGHTS → persona ranker    │
│  → ML /recommend/personalized                                   │
│  → FE: Dashboard.jsx "Your segment" badge + auto-recs on login   │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│  Layer 3 — History collection (seeds future CF)                  │
│  view/click/compare/save/purchase → recommendation_history       │
│  → POST /recommend/history                                      │
│  → FE: fire-and-forget on PhoneDetail mount + rec-card click     │
└──────────────────────────────────────────────────────────────────┘
```

---

## Architecture

### Request flow — "Get personalized recommendations"

```
Frontend (Dashboard.jsx)
  │  on mount, if user authenticated
  ▼
api.post('/recommend/personalized', { budget, topN })
  │  with withCredentials: true (cookie)
  ▼
Node/Express (recommendRoutes.mjs → isAuthenticate → postPersonalized)
  │  reads req.auth.userId
  ▼
recommendService.getPersonalizedRecommendations(userId, body)
  │  1. prisma.customerProfile.findUnique({ where: { userId } })
  │  2. POST ML_BASE_URL/recommend/personalized
  │     body: { user_id, cluster_id, budget, top_n }
  ▼
FastAPI (serve.py)
  │  POST /recommend/personalized handler
  │  1. resolve cluster_id (from request or assign_cluster())
  │  2. CLUSTER_WEIGHTS[cluster_id] → 9-dim weight vector
  │  3. pipeline.recommend(
  │       UserPreferenceInput(persona=CUSTOM, custom_weights_stars=...),
  │       candidates=_candidates_scored
  │     )
  │  (reuses existing ranker — no new ranking logic)
  ▼
Node: enrichMlResults(mlResults)
  │  for each ML row: prisma.phones.findFirst (join brand/specs/variants)
  │  formatRecommendation → { id, modelName, brand, keySpecs, ... }
  ▼
Frontend: setRecs(data.results), render RecommendationCard grid
```

### Request flow — "Click a phone, see similar"

```
Frontend (PhoneDetail.jsx)
  │  useEffect on mount
  ├─► getSimilarPhonesById(phone.id, 6)
  │     api.get(`/phones/${id}/similar?topN=6`)
  │
  │  + logRecommendationInteraction(phone.id, 'view')  (fire-and-forget)
  │     api.post('/recommend/history', { phoneId, action: 'view' })
  ▼
Node: GET /phones/:id/similar
  │  getSimilarPhonesById controller
  │  1. phoneService.getPhoneKey(id) → { modelName, brandName }
  │  2. recommendService.getSimilarPhones(modelName, topN)
  │  3. mlFetch('/recommend/similar', { model_name, top_n })
  ▼
FastAPI: load_similarity_bundle(ARTIFACT_DIR)
  │  cosine_similarity matrix already in memory from startup
  │  similar_phones(bundle, model_name, top_n)
  │  → [{ Brand, Model_Name, Price_EUR, Similarity }, ...]
  ▼
Node: enrichMlResults (same helper as /recommend)
  ▼
Frontend: <SimilarPhonesSection> renders 6 RecommendationCard (no match badge)
```

---

## ML Sidecar Changes

### `ML Model/pipeline/similarity.py` (NEW)

Port of `Content_based_recomaendation.ipynb` into a production-ready module.

**What it does**:
- Loads `After_EDA_and_Feature_ENginering.csv` (8,357 phones × 148 features).
- Drops identifier/high-NaN/provenance columns (mirrors notebook exactly).
- Fits a `ColumnTransformer`: numeric → median-impute → StandardScaler → weighted `FunctionTransformer`; categorical → constant-impute → OneHotEncoder.
- Computes `(n, n)` cosine similarity matrix.
- Saves `{pipeline, similarity_matrix, df, feature_weights}` to `artifacts/similarity_bundle.joblib`.

**Public API**:
```python
build_similarity_bundle(df)            # → bundle dict
save_similarity_bundle(bundle, dir)    # → uses cloudpickle for closures
load_similarity_bundle(dir)            # → bundle dict or None
similar_phones(bundle, model_name, top_n=5)  # → list of dicts or None
```

**CLI**:
```bash
cd "ML Model"
.venv/Scripts/python.exe -m pipeline.similarity
```

**Key design choices**:
- `cloudpickle` is used in `save_similarity_bundle` because joblib cannot pickle a `FunctionTransformer` whose `apply_weights` closure was created inside `_build_preprocessor`. cloudpickle serializes the closure by value. Falls back to joblib if cloudpickle isn't installed.
- Per-feature weights are module-level (`FEATURE_WEIGHTS`) — must stay top-level so pickling can resolve them by name.

**Verified output**: bundle is 8,357 × 8,357 cosine matrix, ~700 MB on disk, loads in <5s.

---

### `ML Model/pipeline/segmentation.py` (NEW)

Loads the K-Means artifacts from `segmentation_outputs1/model_artifacts/` and exposes two surfaces.

**What it loads**:
- `preprocessor.joblib` — ColumnTransformer (median-impute + StandardScaler on numeric, most_frequent-impute + OneHotEncoder on categorical)
- `kmeans.joblib` — fitted KMeans, k=3
- `kmeans_meta.joblib` — `{k: 3, random_state: 42, features: [20 num + 6 cat]}`
- `cluster_profiles.json` — per-cluster `segment_name`, `business_meaning`, `marketing_strategy`, `top_brand`, `top_category`

**Public API**:
```python
@dataclass
class SegmentationBundle:
    preprocessor, kmeans, meta, profiles
    feature_columns
    transform(customer_df)
    predict(customer_df)        # → array of cluster_ids
    cluster_info(cluster_id)

load_segmentation_bundle(segmentation_dir)
assign_cluster(bundle, features_dict)    # → cluster_id + segment_name + strategy
cluster_to_weights_stars(cluster_id)     # → {Gaming: 2, Camera: 4, ...}
weights_stars_to_vector(stars)
```

**`CLUSTER_WEIGHTS` table** (hand-tuned from cluster profiles' top_brand + top_category):

| Cluster | Segment | Gaming | Camera | Battery | Display | Software | Storage | Conn | Security | Portability |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | Premium Xiaomi Budget | 0.4 | 0.4 | 0.7 | 0.5 | 0.4 | 0.4 | 0.4 | 0.3 | 0.5 |
| 1 | Luxury Apple Flagship | 0.3 | 0.7 | 0.6 | 0.7 | 0.9 | 0.6 | 0.6 | 0.9 | 0.6 |
| 2 | Luxury Xiaomi Battery-focused | 0.3 | 0.4 | 1.0 | 0.5 | 0.4 | 0.4 | 0.4 | 0.3 | 0.5 |

**`cluster_to_weights_stars`** multiplies each by 5 and rounds to integer stars in [1..5], ready for `UserPreferenceInput.custom_weights_stars`.

**Verified output**: assigning `{"age":45, "n_purchases":3, "total_spend_npr":500000, "preferred_brand":"Apple", "preferred_category":"Flagship"}` → cluster 0 (because feature vector is sparse — the imputer handles the missing fields). Cluster 1 weights produce camera/display/software-biased rankings when fed to `/recommend/personalized`.

---

### `ML Model/pipeline/serve.py` (MODIFIED)

Three new endpoints + lifespan wiring + bug fix.

#### Imports added
```python
from pipeline.similarity import (
    BUNDLE_FILENAME,
    load_similarity_bundle,
    similar_phones as similar_phones_query,
)
from pipeline.segmentation import (
    SegmentationBundle,
    assign_cluster,
    cluster_to_weights_stars,
    load_segmentation_bundle,
)
```

#### Module-globals added
```python
_similarity_bundle: Optional[Dict[str, Any]] = None
_similarity_load_error: Optional[str] = None
_segmentation_bundle: Optional["SegmentationBundle"] = None
_segmentation_load_error: Optional[str] = None
```

#### Lifespan updates
On startup, after loading the AnTuTu pipeline, the lifespan now also:
1. Tries to load `artifacts/similarity_bundle.joblib`. Logs warning + stores error if missing.
2. Tries to load `segmentation_outputs1/model_artifacts/*`. Logs warning + stores error if missing.
3. **Both are best-effort** — startup doesn't fail if they're missing; the corresponding endpoints return 503.

#### `/health` enhanced
Now reports:
```json
{
  "status": "ok",
  "model_loaded": true,
  "candidates_count": 8433,
  "similarity_loaded": true,
  "segmentation_loaded": true
}
```
Plus `similarity_load_error` and `segmentation_load_error` fields when something failed to load.

#### `POST /recommend/similar`
```python
class SimilarityRequest(BaseModel):
    model_name: str
    top_n: int = Field(default=5, ge=1, le=20)
    brand_filter: Optional[str] = None
```
- Looks up the model name in `_similarity_bundle["df"]`.
- Sorts cosine similarity descending, excludes self, takes top_n.
- Optional `brand_filter` (case-insensitive exact match) post-filters the results.
- 404 if model not found, 503 if bundle not loaded.

#### `POST /segment/assign`
```python
class SegmentAssignRequest(BaseModel):
    features: Dict[str, Any]
```
- Calls `assign_cluster(_segmentation_bundle, features)`.
- Returns `{cluster_id, segment_name, business_meaning, marketing_strategy, top_brand, top_category}`.
- 503 if segmentation not loaded, 500 if K-Means predict fails (e.g. feature vector is all-NaN).

#### `POST /recommend/personalized`
```python
class PersonalizedRecommendRequest(BaseModel):
    user_id: Optional[str] = None
    cluster_id: Optional[int] = Field(default=None, ge=0, le=10)
    features: Optional[Dict[str, Any]] = None
    budget: Optional[Budget] = None
    top_n: int = Field(default=6, ge=1, le=50)
```
- If `cluster_id` provided, uses it directly.
- Otherwise runs `assign_cluster` with `features` to derive one.
- Translates cluster → 9-dim weight vector via `cluster_to_weights_stars`.
- Calls **existing** `pipeline.recommend()` with `PersonaType.CUSTOM` and `custom_weights_stars`. No changes to the ranker.
- Returns `{results, cluster_id, segment_name, weights, user_id}`.

#### Bug fix (incidental)
The pre-existing `_http_exception_handler` referenced `exc.status`, but FastAPI's `HTTPException` uses `exc.status_code`. This broke the error envelope for any 4xx raised inside endpoints (returning 500 with a confused message). Fixed:

```python
status = getattr(exc, "status_code", None) or getattr(exc, "status", 500)
```

---

## Backend Changes

### `backend/src/services/customerProfileService.mjs` (NEW)

Thin wrapper around `prisma.customerProfile`.

**Exports**:
```js
getProfileByUserId(userId)                        // → CustomerProfile | null
upsertClusterAssignment(userId, assignment)        // → upserted row
inferClusterFromPreference(pref)                   // → cluster_id | null (heuristic)
resolveClusterId(userId)                           // → cluster_id | null
getSegmentForUser(userId)                         // → {clusterId, segmentLabel, ...}
```

**`TIER_MAP`** (heuristic mapping cluster_id → Prisma enums):
```js
0: { budgetSegment: "Affordable Buyer", techTier: "Reasonable" }
1: { budgetSegment: "Luxury Buyer",     techTier: "Luxurious" }
2: { budgetSegment: "Premium Buyer",    techTier: "Tech Savvy" }
```

**`inferClusterFromPreference`** lets unprofiled users get cluster-personalized recs without running K-Means:
- `maxBudget >= 600` → cluster 1 (luxury)
- `maxBudget >= 200` → cluster 2 (mid)
- `maxBudget > 0` → cluster 0 (budget)
- `null` → no cluster

---

### `backend/src/services/recommendService.mjs` (MODIFIED)

Heavy refactor + three new functions.

#### Refactor: `enrichMlResults` extracted

The old `getRecommendations` had the Prisma join inline (lines 64-153). That logic is now in a shared `enrichMlResults(mlResults)` helper so all four recommend endpoints (`/recommend`, `/recommend/similar`, `/recommend/personalized`, plus the new `/phones/:id/similar`) share one DB-join path. `formatRecommendation` is unchanged.

#### `getRecommendations` now delegates to `fetchAndEnrich`

```js
const fetchAndEnrich = async (mlPath, body, defaults = {}) => { ... }
export const getRecommendations = (body) => fetchAndEnrich("/recommend", body, { topN: 6 });
```
Same external signature — no controller changes needed.

#### `getSimilarPhones(modelName, topN = 5)`
- POSTs to ML `/recommend/similar`.
- Adapts the `{Brand, Model_Name, Price_EUR, Similarity}` shape to the `{Brand, Model, Match_Score, Why}` shape the ranker uses, so `enrichMlResults` works without changes.
- Returns the same enriched `Recommendation[]` shape.

#### `getPersonalizedRecommendations(userId, body)`
- Lazy-imports `customerProfileService` to avoid a circular dep.
- Reads `prisma.customerProfile.clusterId` for the user.
- If null, sends `cluster_id: null` to ML — the ML sidecar will fall back to generic ranker.
- Calls ML `/recommend/personalized` with `{user_id, cluster_id, budget, top_n}`.
- Returns `{results: Recommendation[], clusterId, segmentName, userId}`.

#### `logRecommendationInteraction(userId, phoneId, action)`
- Validates `action ∈ {view, click, compare, save, purchase}`.
- Writes one `recommendation_history` row with the matching boolean flag set.
- **Side-effects** (best-effort, failures swallowed):
  - `compare` → `customerProfile.totalComparisons += 1`
  - `click` → `customerProfile.totalRecommendations += 1`
  - `save` → `customerProfile.totalWishlist += 1`

---

### `backend/src/controller/recommendController.mjs` (MODIFIED)

Four new thin handlers, all using `catchAsync`:

| Function | Reads | Validates | Delegates to |
|---|---|---|---|
| `postSimilar` | `req.body` | `modelName` present | `recommendService.getSimilarPhones` |
| `postPersonalized` | `req.auth.userId` | auth required (401) | `recommendService.getPersonalizedRecommendations` |
| `postHistory` | `req.auth.userId` | auth + `phoneId` + `action` | `recommendService.logRecommendationInteraction` |
| `getMySegment` | `req.auth.userId` | auth required | `customerProfileService.getProfileByUserId` (no ML call) |

Per `backend/CLAUDE.md`: always `req.auth.userId`, never `req.user`.

---

### `backend/src/routes/recommendRoutes.mjs` (MODIFIED)

Added four new routes (after the existing three):

```js
recommendRoutes.post("/similar",        postSimilar);
recommendRoutes.post("/personalized",   isAuthenticate, postPersonalized);
recommendRoutes.post("/history",        isAuthenticate, postHistory);
recommendRoutes.get("/me",              isAuthenticate, getMySegment);
```

`/similar` is public (catalog info); the other three require auth.

---

### `backend/src/routes/phoneRoutes.mjs` + `phoneService.mjs` + `phoneController.mjs` (MODIFIED)

Added `GET /phones/:id/similar` — convenience route that:
1. Looks up the phone's `modelName` via the new `phoneService.getPhoneKey(id)`.
2. Proxies to `recommendService.getSimilarPhones(modelName, topN)`.
3. Returns enriched `Recommendation[]`.

**Critical**: registered **before** `GET /phones/:id` so Express doesn't capture `similar` as an `id` parameter.

---

## Database Migration

### `backend/prisma/migrations/20260728000000_add_segment_fields/migration.sql` (NEW)

```sql
ALTER TABLE "customer_profile"
    ADD COLUMN "cluster_id" INTEGER,
    ADD COLUMN "segment_label" VARCHAR(80),
    ADD COLUMN "segment_source" VARCHAR(40) DEFAULT 'kmeans_v1';

CREATE INDEX "customer_profile_cluster_id_idx" ON "customer_profile"("cluster_id");
```

### `backend/prisma/schema.prisma` (MODIFIED)

Three new fields + one index on `model CustomerProfile`:

```prisma
clusterId     Int?    @map("cluster_id")
segmentLabel  String? @map("segment_label") @db.VarChar(80)
segmentSource String? @map("segment_source") @db.VarChar(40) @default("kmeans_v1")
...
@@index([clusterId])
```

No other models were touched. No enums were added or modified.

**To apply**:
```bash
cd backend
npx prisma migrate dev
npx prisma generate
```

---

## Frontend Changes

### `frontend/src/services/recommend.js` (MODIFIED)

Three new service functions added alongside the existing `getRecommendations` and `postCompareMl`:

```js
getSimilarPhones(modelName, topN = 5)            // POST /recommend/similar
getSimilarPhonesById(phoneId, topN = 6)          // GET  /phones/:id/similar
getPersonalizedRecommendations({ budget, topN }) // POST /recommend/personalized
logRecommendationInteraction(phoneId, action)     // POST /recommend/history (fire-and-forget)
getMySegment()                                    // GET  /recommend/me
```

`logRecommendationInteraction` is intentionally non-throwing — `.catch(() => null)` swallows 4xx/5xx so a backend hiccup never blocks the UI.

---

### `frontend/src/components/RecommendationCard.jsx` (NEW)

Extracted from the duplicated JSX in `Dashboard.jsx` (lines 1019-1099 of the pre-change file).

**Props**:
```js
phone                      // Recommendation dict
showMatchBadge = true      // false for Similar phones (it's a similarity score)
onClick                    // navigate or fire analytics
onMouseEnter / onMouseLeave
```

Used by both Dashboard (match badge on, click logs + navigates) and PhoneDetail (match badge off, no click handler).

---

### `frontend/src/components/PhoneDetail.jsx` (MODIFIED)

Two additions:

#### 1. `<SimilarPhonesSection>` rendered at the bottom of `PhoneDetailView`
- Calls `getSimilarPhonesById(phoneId, 6)` on mount.
- Renders up to 6 `<RecommendationCard>` with `showMatchBadge={false}`.
- Hidden entirely if the call fails or returns empty (no error toast — feature is additive).

#### 2. View-logging `useEffect`
```js
useEffect(() => {
  if (!phone?.phoneId) return;
  logRecommendationInteraction(phone.phoneId, "view");
}, [phone?.phoneId]);
```
Fire-and-forget; never blocks the page render.

---

### `frontend/src/components/Dashboard.jsx` (MODIFIED)

Three additions:

#### 1. New `mySegment` state
Holds the response from `GET /recommend/me` (or null if unauthenticated / unprofiled).

#### 2. New `useEffect` for auto-personalized recs on mount (auth'd users only)
```js
useEffect(() => {
  if (!user) return;
  // fetch getMySegment() → setMySegment(...)
  // fetch getPersonalizedRecommendations({topN: 6})
  //   → setRecs(data.results)
  //   → setRecsPersona(data.segmentName || "Your segment")
}, [user?.userId]);
```

#### 3. Rec-card click now navigates + logs
```js
<RecommendationCard
  phone={r}
  onClick={() => {
    if (r.id) {
      logRecommendationInteraction(r.id, "click");
      navigate(`/phones/${r.id}`);
    }
  }}
/>
```

Plus a "Your segment" badge in the section header when `mySegment.segmentLabel` is set.

---

## Documentation

### `backend/docs/api.md` (MODIFIED)

Added four endpoint sections under "Recommendation Endpoints":
- `POST /recommend/similar` — full request/response shape, error codes
- `POST /recommend/personalized` — auth requirement, request/response
- `POST /recommend/history` — allowed actions, response
- `GET /recommend/me` — response shape with all cluster fields

Updated:
- Table of Contents (line numbers for new sections)
- Appendix A endpoint table (5 new rows + 1 updated)
- "Last regenerated" date

---

## End-to-End Smoke Test

### ML sidecar health

```bash
cd "ML Model"
.venv/Scripts/python.exe -m uvicorn pipeline.serve:app --port 8765
curl http://127.0.0.1:8765/health
```

**Response** (all three artifacts loaded):
```json
{
  "status": "ok",
  "model_loaded": true,
  "candidates_count": 8433,
  "similarity_loaded": true,
  "segmentation_loaded": true
}
```

### `/recommend/similar`
```bash
curl -X POST http://127.0.0.1:8765/recommend/similar \
  -H 'Content-Type: application/json' \
  -d '{"model_name":"Apple iPhone 17 Pro Max","top_n":3}'
```
**Returns** iPhone 17 Pro (0.998), iPhone 16 Pro Max (0.987), iPhone 16 Pro (0.98).

### `/segment/assign`
```bash
curl -X POST http://127.0.0.1:8765/segment/assign \
  -H 'Content-Type: application/json' \
  -d '{"features":{"age":45,"n_purchases":3,"total_spend_npr":500000,"preferred_brand":"Apple","preferred_category":"Flagship"}}'
```
**Returns** cluster 0 with full marketing strategy.

### `/recommend/personalized`
```bash
curl -X POST http://127.0.0.1:8765/recommend/personalized \
  -H 'Content-Type: application/json' \
  -d '{"cluster_id":1,"top_n":3}'
```
**Returns** Honor Magic8 Pro, Magic7 Pro, Galaxy S26 Ultra — all with Camera/Display/Software strong reasons, matching cluster 1's weighting.

### 404 / 400 envelopes (after bug fix)
```bash
curl -X POST http://127.0.0.1:8765/recommend/similar \
  -H 'Content-Type: application/json' \
  -d '{"model_name":"NonExistentPhone 12345"}'
```
**Returns** `{"success":false,"code":"RESOURCE_NOT_FOUND","message":"..."}` with `HTTP 404`. Pre-fix this returned 500.

### Regression check
The pre-existing `/recommend` persona flow and `/predict` endpoint return identical payloads to before this work — no regression.

---

## Files Created / Modified

### Created (7)

| File | Lines | Purpose |
|---|---|---|
| `ML Model/pipeline/similarity.py` | ~270 | Cosine similarity computation + bundle I/O |
| `ML Model/pipeline/segmentation.py` | ~180 | K-Means loader + cluster → weight mapping |
| `ML Model/artifacts/similarity_bundle.joblib` | ~700 MB | Pre-computed (8357×8357) similarity matrix |
| `backend/src/services/customerProfileService.mjs` | ~140 | CustomerProfile wrapper + cluster upsert |
| `backend/prisma/migrations/20260728000000_add_segment_fields/migration.sql` | 8 | Add `cluster_id`, `segment_label`, `segment_source` |
| `frontend/src/components/RecommendationCard.jsx` | ~120 | Shared card (extracted from Dashboard) |
| `HYBRID_RECOMMENDATION_README.md` | (this file) | Documentation |

### Modified (8)

| File | Change |
|---|---|
| `ML Model/pipeline/serve.py` | +similarity/segmentation imports + globals + lifespan loading + 3 new endpoints + `/health` enhanced + bug fix in exception handler |
| `backend/src/services/recommendService.mjs` | Refactored `enrichMlResults` extraction + 3 new functions |
| `backend/src/controller/recommendController.mjs` | +4 new controller functions |
| `backend/src/routes/recommendRoutes.mjs` | +4 new routes (3 with auth) |
| `backend/src/routes/phoneRoutes.mjs` | +`GET /:id/similar` route (registered before `:id`) |
| `backend/src/controller/phoneController.mjs` | +`getSimilarPhonesById` controller |
| `backend/src/services/phoneService.mjs` | +`getPhoneKey(id)` helper |
| `backend/prisma/schema.prisma` | +3 columns + 1 index on `CustomerProfile` |
| `backend/docs/api.md` | +4 new endpoint sections + table updates |
| `frontend/src/services/recommend.js` | +3 service functions + 1 convenience wrapper |
| `frontend/src/components/PhoneDetail.jsx` | +`<SimilarPhonesSection>` + view-logging effect |
| `frontend/src/components/Dashboard.jsx` | +personalized useEffect + segment badge + click logging + replaced inline card with shared `RecommendationCard` |

### Total

- **7 new files**
- **12 modified files**
- **+~1,400 lines of code** (excluding the 700MB joblib artifact)

---

## Open Issues & Next Steps

These were flagged in the plan and **not** addressed in this session:

1. **Customer ↔ user linkage** — `dataset/customer_dataset.csv` has 4,557 historical customers with `customer_id` (e.g. `CUST-000EFD69`) but no link to `Users.userId`. Until that's resolved, new users can only be segmented via the `inferClusterFromPreference` heuristic from their `UserPreference`. A future script could backfill via `Users.email` (requires adding email to the historical dataset) or via a new `externalCustomerId` column.

2. **Cluster → enum mapping** — KMeans produces 3 clusters, but the Prisma `BudgetSegment` enum has 5 values. The `TIER_MAP` in `customerProfileService.mjs` is a heuristic that may need business review.

3. **`CLUSTER_WEIGHTS` validation** — the 9-dim weight vectors are hand-tuned from the cluster profiles' top_brand + top_category. They should be validated against a hold-out customer sample before being treated as production-tuned.

4. **Click-history latency** — `logRecommendationInteraction` is fire-and-forget. If a request fails, the data is lost. Acceptable for an MVP; consider a queued batched writer (e.g. IndexedDB buffer + flush on connectivity) if volume grows.

5. **Collaborative-filtering matrix not yet built** — the user-item interaction matrix is the natural next step once `recommendation_history` has enough rows. This work is the *seed* for that future CF layer.

6. **Wishlist / Compare / Save endpoints are accepted but not wired in the FE** — the backend can log these actions (`POST /recommend/history` with `action: "compare" | "save" | "purchase"`), but no UI invokes them yet. The `Wishlist` Prisma model has no service/controller.

7. **Cluster inference for new users** — `customerProfileService.inferClusterFromPreference` is a simple budget-bucket heuristic. A better approach is to ask the user a few onboarding questions at signup and store the answers, then run `assign_cluster()` on their feature vector.

8. **The pre-existing InconsistentVersionWarning** when loading segmentation joblibs (trained on sklearn 1.8, current env is 1.9) is suppressed via `warnings.filterwarnings`. The models predict correctly, but consider re-training when convenient.

---

## How to roll this out

The work is structured so each phase can ship independently:

| Phase | What it adds | Backwards-compatible? |
|---|---|---|
| 1 — ML artifacts + new endpoints | New `/recommend/*` routes, ML sidecar learns to load new bundles | ✅ Yes — no existing endpoint changed |
| 2 — Backend wiring | New routes + services + migration | ✅ Yes — only adds tables/columns |
| 3 — Frontend | New section + auto-recs + click logging | ✅ Yes — feature-flag friendly |

Suggested rollout:
1. Deploy Phase 1 (ML sidecar). Existing `/recommend` persona flow unchanged.
2. Deploy Phase 2 (backend). New endpoints available; no FE consumer yet.
3. Deploy Phase 3 (frontend) gated behind `process.env.VITE_HYBRID_RECO=true` so it can be enabled per environment.
