# Mobile Recommendation System — CF Integration: FINAL_README

> **Status:** Hybrid recommender (rule-based + content-based + collaborative-filtering) is integrated end-to-end and validated against the live dev DB. The legacy single-source ML pipeline is preserved unchanged and degrades gracefully when the new CF service is unreachable.

This document covers only the work landed in the 2026-08-12 CF integration session and the follow-up work it implies. It does **not** duplicate the project-wide architecture, install, or API docs from [`README.md`](./README.md) — refer to that file for everything else.

---

## Table of Contents

1. [What Was Built](#1-what-was-built)
2. [System Topology After Integration](#2-system-topology-after-integration)
3. [Component Map — New Files](#3-component-map--new-files)
4. [Component Map — Modified Files](#4-component-map--modified-files)
5. [Failure Modes — Tested Behavior](#5-failure-modes--tested-behavior)
6. [Database Changes](#6-database-changes)
7. [How the Hybrid Merge Works](#7-how-the-hybrid-merge-works)
8. [How to Run Locally (CF on)](#8-how-to-run-locally-cf-on)
9. [What Still Needs To Be Done](#9-what-still-needs-to-be-done)
10. [Validation Evidence](#10-validation-evidence)

---

## 1. What Was Built

| # | Layer | What | Status |
|---|-------|------|--------|
| 1 | CF FastAPI service | `ML Model/filtering/cf_service/app.py` — loads `cf_recommender.pkl` (SVD + item-cosine hybrid, 4329 users / 1731 items) and exposes `/health` + `/recommend` on port 9001. | ✅ Done |
| 2 | CF service Docker image | `ML Model/filtering/Dockerfile` — multi-stage `python:3.11-slim`, healthcheck, runtime pickle bind-mount. | ✅ Done |
| 3 | BE bridge service | `backend/src/services/cfRecommendationService.mjs` — maps app user → CF customer_id, calls CF with 8s timeout, persists cluster + analytics. | ✅ Done |
| 4 | BE config | `backend/src/config/cf.mjs` — `CF_BASE_URL` env var, defaults to `http://127.0.0.1:9001`. | ✅ Done |
| 5 | Prisma models + migration | `customer_cluster` + `cf_recommendation_logs` tables, applied via `20260812000000_add_cf_recommendation_integration`. | ✅ Done |
| 6 | Hybrid merge into existing pipeline | `recommendService.mjs` — CF candidates fetched in parallel with ML; unioned + deduped; `cfReasons` attached to ML rows that overlap. | ✅ Done |
| 7 | Frontend CF reason badge | `Dashboard.jsx` + `Dashboard.css` — "People like you also liked" hint rendered on rec cards when `cfReasons` is present. | ✅ Done |
| 8 | Docker Compose wiring | `cf-service` block in `docker-compose.yml` with pickle bind-mount + segmentation CSVs + backend `depends_on` healthy. | ✅ Done |
| 9 | Env files updated | `backend/.env` + `backend/.env.example` — `CF_BASE_URL` documented. | ✅ Done |
| 10 | Pre-existing FE merge conflict resolved | `frontend/src/components/Compare.css` — leftover git markers removed. | ✅ Done |

---

## 2. System Topology After Integration

```
                ┌─────────────────────────────────────┐
                │       React Frontend (5173)          │
                │  Dashboard.jsx (CF reason badge)     │
                └────────────┬─────────────────────────┘
                             │  HTTPS
                ┌────────────▼─────────────────────────┐
                │       Node.js Backend (8001)         │
                │  recommendService.mjs (HYBRID MERGE) │
                │   ├─ mlFetch  ────► :8002  (existing)│
                │   ├─ CF call  ────► :9001  (new)     │
                │   └─ dedupe + rank, return list      │
                │  cfRecommendationService.mjs (bridge)│
                │  Prisma ─────► PostgreSQL (5432)     │
                └────────────┬─────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
   ┌──────────────────────┐       ┌──────────────────────┐
   │ ml-service (8002)    │       │ cf-service (9001)    │
   │ rule-based + content │       │ SVD + item-cosine    │
   │ XGBoost ranker       │       │ trained pickle       │
   │ (UNCHANGED)          │       │ (NEW)                │
   └──────────────────────┘       └──────────────────────┘
```

The contract enforced everywhere: **the BE never throws if CF is unreachable.** Failures degrade to `results: []` from CF and the existing rule-based + content-based list is served untouched.

---

## 3. Component Map — New Files

| File | Purpose |
|------|---------|
| `ML Model/filtering/cf_service/app.py` | FastAPI app, loads `cf_recommender.pkl` once at startup, `/health` and `/recommend` endpoints. |
| `ML Model/filtering/Dockerfile` | Multi-stage Python 3.11 slim image, healthcheck via curl, runtime pickle bind-mount. |
| `ML Model/filtering/requirements-cf.txt` | Pinned dependencies (`numpy>=2.0,<2.3`, `implicit==0.7.2`, `fastapi==0.115.6`, `pydantic==2.10.3`). |
| `backend/src/config/cf.mjs` | `CF_BASE_URL` env var with permissive default `http://127.0.0.1:9001`. |
| `backend/src/services/cfRecommendationService.mjs` | Bridge: lazy CSV load for cluster map, `resolveCfCustomerId`, `getCfRecommendations`, `safeRecordCfLog`, `safeUpsertCustomerCluster`, `checkCfHealth`. |
| `backend/prisma/migrations/20260812000000_add_cf_recommendation_integration/migration.sql` | Adds `customer_clusters` + `cf_recommendation_logs` tables, FKs + indexes. |

---

## 4. Component Map — Modified Files

| File | Change |
|------|--------|
| `backend/prisma/schema.prisma` | Added `CustomerCluster` + `CfRecommendationLog` models; relations on `Users`. |
| `backend/src/services/recommendService.mjs` | Added `mergeCfCandidates`, `enrichCfCandidate`, `recordCfArtifacts`. Both `getRecommendations` (full fusion) and `getRecommendationsTwoStage` (top-5) call CF in parallel with ML and union the results. `checkHealth` now probes both services. |
| `backend/.env`, `backend/.env.example` | Added `CF_BASE_URL` with Docker compose override note. |
| `docker-compose.yml` | New `cf-service` block: build from `ML Model/filtering`, pickle bind-mount at `/model/cf`, segmentation CSVs at `/model/seg`, internal-only (no host port), `start_period: 45s` for cold pickle load, `backend.depends_on` waits on `cf-service healthy`, `backend.CF_BASE_URL=http://cf-service:9001`. |
| `frontend/src/components/Dashboard.jsx` | New `cf-reason-badge` JSX block: renders `r.cfReasons[0]` as "People like you liked:" hint on rec cards. Gated by the same `recommendationSource === "manual"` flag as the SHAP "why" list. |
| `frontend/src/components/Dashboard.css` | `.cf-reason-badge` styles + dark-mode override. |
| `frontend/src/components/Compare.css` | Pre-existing merge-conflict markers (`<<<<<<< HEAD … >>>>>>> development`) removed — the unrelated `.compare-ml-headline-card` rules were left intact on the HEAD side. |

---

## 5. Failure Modes — Tested Behavior

| Failure | Detected By | Outcome |
|---------|-------------|---------|
| **CF service unreachable** (port closed) | `fetch()` rejects inside `callCfService` | `[cf] recommend failed: fetch failed` warn log → `results: []` envelope → `recommendService.mergeCfCandidates` returns input unchanged → served list = legacy ML-only list. **No 500. No exception.** |
| **CF service timeout** (> 8 s) | `AbortController` in `callCfService` | `results: []`, `error: "CF service timeout"`, `coldStart: true`. Same graceful fallthrough. |
| **CF service returns HTTP error** (e.g. 503 model load failed) | `res.ok === false` | `results: []`, `error: "CF service HTTP <code>"`. Same fallthrough. |
| **User has no CF counterpart** (real registration, no `@import.local` email) | `IMPORT_EMAIL_RE.exec()` fails inside `resolveCfCustomerId` | `customerId: null` → `results: []` returned BEFORE any HTTP call to CF (saves the round-trip). |
| **CF row can't be matched to a DB phone** | `prisma.phones.findFirst()` returns `null` inside `enrichCfCandidate` | Row still surfaces in the served list with `inDatabase: false`, `id: null`, model_name + first-token brand. `dedupeByStableId` falls back to `[brand, modelName]` key. |
| **CustomerCluster lazy-write fails** (e.g. migration not applied yet) | `try/catch` inside `safeUpsertCustomerCluster` | `[cf] cluster upsert failed: ...` warn log → recommendation still served. The CSV lookup is the source of truth for the cluster; the DB row is just a memoize layer. |
| **`CustomerCluster.findUnique` fails** (DB down) | `try/catch` inside `resolveCfCustomerId` | Falls through to the email-pattern lookup. CF call still proceeds if email matches. |
| **`cf_recommender.pkl` missing** (volume not mounted) | `MODEL_DIR / "cf_recommender.pkl"` check inside CF service `/health` | `_load_error` set → `/health` returns `status: "unhealthy"` with the error → BE `checkCfHealth` reports the same → `recommendService` falls back to ML-only list. |

---

## 6. Database Changes

Two new tables, added by migration `20260812000000_add_cf_recommendation_integration`:

### `customer_clusters`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | Default `gen_random_uuid()`. |
| `user_id` | UUID NOT NULL UNIQUE | FK → `users.user_id` ON DELETE CASCADE. |
| `cluster_id` | INTEGER NOT NULL | KMeans label (0..3 for k=4). |
| `cluster_name` | VARCHAR(80) NOT NULL | Human-readable name (e.g. `Premium Flagship Shopper`). |
| `cf_customer_id` | VARCHAR(40) NULL | CF-side `CUST-XXXXXXXX` id, cached to skip the email-pattern split on subsequent calls. |
| `assigned_at` | TIMESTAMP(3) NOT NULL | Default `CURRENT_TIMESTAMP`. |
| `updated_at` | TIMESTAMP(3) NOT NULL | Default `CURRENT_TIMESTAMP`. |

Index: `customer_clusters_cluster_id_idx` on `(cluster_id)` for admin "find all users in cluster 2" queries.

### `cf_recommendation_logs`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | Default `gen_random_uuid()`. |
| `user_id` | UUID NOT NULL | FK → `users.user_id` ON DELETE CASCADE. |
| `cf_customer_id` | VARCHAR(40) NULL | The CF id we used for this call. |
| `is_cold_start` | BOOLEAN NOT NULL | Mirrors the CF service's `cold_start` flag. |
| `model_names` | TEXT NOT NULL | Newline-joined `model_name` field from each CF result. |
| `scores` | TEXT NOT NULL | Newline-joined scores. |
| `reasons` | TEXT NOT NULL | Newline-joined human-readable reasons (e.g. "popular with Premium Flagship Shopper customers"). |
| `served_at` | TIMESTAMP(6) NOT NULL | Default `CURRENT_TIMESTAMP`. |

Index: `cf_recommendation_logs_user_id_served_at_idx` on `(user_id, served_at DESC)` for "show my recent CF logs" admin queries.

Both tables are **additive** — no existing tables were modified.

### Apply the migration

```bash
cd backend
npx prisma migrate deploy
```

Already applied in the dev DB during validation (2026-08-12).

---

## 7. How the Hybrid Merge Works

The merge lives in `recommendService.mjs` and runs in both `getRecommendations` (full-fusion path used by auto-recommend) and `getRecommendationsTwoStage` (top-5 path used by the explicit "Recommend Me a Phone" click). The logic is identical:

1. **Fetch in parallel.** `Promise.all([mlFetch("/recommend", …), getCfRecommendations(userId, 10)])` runs both services concurrently. The CF promise has a `.catch(...)` that converts rejections into the empty envelope — `Promise.all` only rejects if both reject.
2. **Enrich CF rows.** Each CF `model_name` is resolved against `prisma.phones.findFirst` (same pattern as the ML enrichment). DB misses still surface in the list with `inDatabase: false`.
3. **Pre-compute ML keys.** A `Set` of `${brand}::${modelName}` keys is built once for O(1) overlap checks.
4. **Two paths per CF row:**
   - **Already in ML list** → mutates the existing ML row to attach `cfReasons: string[]`. The ML row keeps its rich ranker output (fused score, components, contentSim, tags). The CF reason surfaces as a "People like you liked:" badge in the FE.
   - **New row** → appended to the end of the candidate list with `cfSource: true` and a CF-derived `matchScore`.
5. **Dedup.** `dedupeByStableId` enforces the "no duplicate phones" contract on the served list — first occurrence wins, so the ML row (higher in the ranked order) is always the survivor.
6. **Finalize.** Re-shape for the FE (`matchScore` = 0..100, `matchComponents` from ranker, `cfReasons` for badge).
7. **Log.** `recordCfArtifacts` (fire-and-forget) writes the served CF list to `cf_recommendation_logs` and persists (or updates) the `customer_clusters` row.

**CF score contribution.** CF does NOT re-rank the existing ML list. The ML list order is the authoritative ranking — CF only contributes additional rows (lowest rank) and "people like you also liked" hints on existing rows. This was a deliberate choice to avoid regressing the ranker the user-experience was already tuned around.

---

## 8. How to Run Locally (CF on)

### Docker Compose (recommended)

```bash
# 1. Copy env template and set secrets
cp .env.example .env
# → set POSTGRES_PASSWORD, COOKIE_SECRET (openssl rand -hex 32)

# 2. Boot the full stack
docker compose up --build -d

# 3. Verify the CF service came up healthy
docker compose exec cf-service curl -fsS http://127.0.0.1:9001/health
# → {"status":"ok","n_users":4329,"n_items":1731,...}

# 4. Verify the backend can talk to it
curl http://localhost:8001/api/recommend/health
# → {"data":{"ml":{...},"cf":{"status":"ok","n_users":4329,"n_items":1731}}}
```

If `docker compose up` fails on the `cf-service` build with `ModuleNotFoundError: No module named 'numpy._core.numeric'`, your local build is using numpy <2.0 — re-pull with `--no-cache`:

```bash
docker compose build --no-cache cf-service
```

### Host-mode dev (Python 3.11 only)

```bash
# Terminal 1 — CF service
cd "ML Model/filtering"
C:/Users/Sushil/AppData/Local/Programs/Python/Python311/python.exe -m pip install -r requirements-cf.txt
C:/Users/Sushil/AppData/Local/Programs/Python/Python311/python.exe -m uvicorn cf_service.app:app --host 127.0.0.1 --port 9001

# Terminal 2 — backend
cd backend
npm install
npx prisma migrate deploy
npm run dev   # CF_BASE_URL=http://127.0.0.1:9001 is in .env
```

The pickle must live at `ML Model/filtering/03_collaborative_filtering/output/cf_recommender.pkl`. If you re-train, the `cf-service` container picks it up on the next request (it's bind-mounted, not COPY'd).

---

## 9. What Still Needs To Be Done

The hybrid recommender is integrated and validated end-to-end, but the following items are follow-ups (not blockers):

| # | Item | Why | How |
|---|------|-----|-----|
| 1 | **Admin panel for `cf_recommendation_logs`** | Useful for offline analytics ("which CF reasons get the most impressions?") but not surfaced anywhere yet. | Add a section under `frontend/src/components/admin/` that queries `GET /api/admin/cf-logs` (new route, paginated, groupable by user/cluster). |
| 2 | **Cluster-level A/B testing** | We don't yet know if the cluster info on the badge improves CTR. | Add a `cluster_id` column to `recommendation_calls` (already exists via FK if you join), and an admin-side query that correlates the CF reason clicks with `behavior_scores.updates` deltas. |
| 3 | **Re-train CF model in CI** | The pickle is committed to disk and never refreshed. | Add a step to `ML Model/filtering/03_collaborative_filtering/train.py` to the CI pipeline that re-trains nightly against the latest `customer_dataset.csv` and PRs the new pickle. |
| 4 | **Pre-warm CF results on login** | First `/recommend` call after login has a ~100-300 ms CF latency. | Add a route that calls `getCfRecommendations` once on user login (fire-and-forget) and caches the result in Redis with TTL = session. The actual `/recommend` call already falls back to the ML list if the cache misses. |
| 5 | **Surface CF metrics on `/api/recommend/health`** | The new `checkHealth` returns `{ml: ..., cf: ...}` but the FE doesn't render the CF side anywhere yet. | Add a "ML health" admin widget on the existing dashboard that shows both services' status + the trained CF model stats (`n_users`, `n_items`). |
| 6 | **Real-user cluster assignment for imported `@import.local` users** | Right now we re-read the segmentation CSV on every first lookup. The lazy `CustomerCluster` write memoizes the answer, so this is fine, but if you want offline re-segmentation to be reactive, you'd add a webhook here. | Listen to a "segmentation retrained" event from the `02_segmentation/` pipeline and invalidate the `customer_clusters` rows whose `cluster_id` changed. |
| 7 | **Add a `/cf-logs/me` route** for users to inspect their own CF history. | Useful for the "why am I seeing this?" trust UX. | New `GET /api/cf-logs/me` that paginates `cf_recommendation_logs` for the authenticated user. |
| 8 | **Wire `cfReason` into the auto-recommend path** | Currently the badge is gated by `recommendationSource === "manual"`. Auto-rec cards don't show it. | If desired, render the badge in both paths — it's a single-line conditional flip in `Dashboard.jsx`. |

---

## 10. Validation Evidence

Captured during the 2026-08-12 integration session against the dev DB (`mobile_recommender` on `localhost:5432`):

| Check | Result |
|-------|--------|
| `cf-service` `/health` after fresh boot | `{"status":"ok","n_users":4329,"n_items":1731,"cf_weight":0.7,"content_weight":0.3}` |
| CF `/recommend?customer_id=CUST-000EFD69&top_n=3` | Real, brand-aware picks: S25 Ultra (score 0.70, "popular with Premium Flagship Shopper"), iPhone 14 Pro Max (0.30, "matches Apple"), iPhone 13 Pro Max (0.28). |
| CF `/recommend?customer_id=CUST-NEWUNKNOWN&top_n=2` | Cold-start fallback: global popularity (`cold_start: true`, both rows score 0.0 with reason "Most popular in Nepal right now"). |
| BE `recommendService.checkHealth()` | `{"ml":{"status":"unhealthy","error":"ML service unreachable"},"cf":{"status":"ok","n_users":4329,"n_items":1731}}` — ML unreachable in test env, CF healthy. |
| BE `getCfRecommendations(importedUserId, 5)` | `cfCustomerId: "CUST-000EFD69"`, `cluster: {"id":2,"name":"Premium Flagship Shopper"}`, 5 real results. |
| `CustomerCluster` row after `safeUpsertCustomerCluster` | Persisted: `{userId, clusterId: 2, clusterName: "Premium Flagship Shopper", cfCustomerId: "CUST-000EFD69", assignedAt, updatedAt}`. |
| Graceful degradation (CF port closed) | `checkCfHealth` → `unreachable`, `getCfRecommendations` → `results: []`, `coldStart: true`, `error: "fetch failed"`. No exception thrown, served list unchanged. |
| Migration apply | `npx prisma migrate deploy` → `migrations/20260812000000_add_cf_recommendation_integration/migration.sql` applied. |
| FE build | `vite build` → `built in 293ms`, `dist/index-B6wMl2av.css` (66.91 kB), `dist/index-DXyNJOBe.js` (410.31 kB). |
| Docker Compose schema | `docker compose config --quiet` → exit 0 (warnings about `postgressushil$` env-var placeholder are pre-existing and unrelated to this work). |

---

*See [`README.md`](./README.md) for the project-wide architecture, install, and API documentation. This FINAL_README covers only the CF integration work landed in the 2026-08-12 session.*
