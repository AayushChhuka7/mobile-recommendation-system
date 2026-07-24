# Mobile Recommendation System

> A full-stack, Docker-orchestrated smartphone recommendation platform that combines a normalized PostgreSQL catalog, a Node.js + Express + Prisma backend, a React + Vite frontend, and a FastAPI / XGBoost ML service that scores, ranks, and explains phones per user persona.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Features](#2-features)
3. [Technology Stack](#3-technology-stack)
4. [Project Structure](#4-project-structure)
5. [System Architecture](#5-system-architecture)
6. [Database](#6-database)
7. [API Documentation](#7-api-documentation)
8. [ML Service](#8-ml-service)
9. [Environment Variables](#9-environment-variables)
10. [Docker](#10-docker)
11. [Installation](#11-installation)
12. [Access URLs](#12-access-urls)
13. [Useful Docker Commands](#13-useful-docker-commands)
14. [Development Workflow](#14-development-workflow)
15. [Troubleshooting](#15-troubleshooting)
16. [Future Improvements](#16-future-improvements)
17. [Contributors](#17-contributors)
18. [License](#18-license)

---

## 1. Project Overview

The **Mobile Recommendation System** helps users find the right smartphone based on their preferences, budget, and usage style. It uses a trained XGBoost model (with SHAP-based explainability) to rank phones, while a normalized PostgreSQL catalog — populated from a curated GSMArena dataset — powers rich filtering, comparison, wishlist, and admin analytics.

The platform is built around a strict layered architecture:

- **React + Vite** single-page app for the user interface
- **Node.js + Express + Prisma** REST API with Passport-Local authentication and PostgreSQL session storage
- **PostgreSQL 16** for users, RBAC, phones, variants, specs, wishlist, history, and analytics
- **FastAPI + XGBoost + SHAP** sidecar for ML ranking, scoring, predictions, and explanations
- **Docker Compose** to orchestrate every service for local development

> **Note:** The first `docker compose up` runs the `db-init` one-shot job that pushes the Prisma schema, seeds the RBAC roles, and bulk-imports the GSMArena CSV. **This takes several minutes** on the very first boot.

---

## 2. Features

### Authentication

| Capability                   | Description                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------- |
| Registration with OTP        | Email + password + role-name (`Customer` / `Salesman`); OTP verification by email |
| OTP resend                   | New OTP for unverified users                                                      |
| Login                        | Passport Local; session cookie (`connect.sid`); role-name verified against DB row |
| Logout                       | Destroys session, clears cookie                                                   |
| Forgot password              | Email-based OTP → change password                                                 |
| Email change (logged in)     | Current-password + new email → OTP → email swap                                   |
| Change password (logged in)  | Current password + new password (password policy enforced)                        |
| Self-deactivate account      | Sets `isActive = false`, logs out, clears cookie                                  |
| Boot-time session validation | Frontend re-checks `GET /users/me` to avoid stale localStorage sessions           |

### Recommendation (ML)

- Persona-driven recommendations: `Gamer`, `Camera_Lover`, `Battery_Focused`, `All_Rounder`, `Business_User`, `Custom`
- Budget-bounded ranking (`min`, `max` in EUR)
- Per-dimension weighting (`gaming`, `camera`, `battery`, `display`, `software`, `storage`, `connectivity`, `security`, `portability`) — 1–5 stars
- Configurable `topN` (default 6, max 50)
- **Explainability:** SHAP top-N feature contributions per recommendation
- **Comparison (ML):** Head-to-head per-dimension winner + SHAP for each side

### Search & Filtering (Catalog)

- Full-text search by model name
- Filter by brand, price range, RAM, storage, 5G, NFC, OIS, headphone jack, OS, chipset, display type, battery, refresh rate, lens count, year
- Sort: newest, oldest, name (A–Z / Z–A), price (low–high / high–low), AnTuTu performance
- Listing pages: **Featured** (5G + best AnTuTu), **Latest** (by announced date), **Best Value** (≤ €300, ≥ 6 GB RAM)

### Comparison

- Compare 2–5 phones simultaneously
- ML-powered per-dimension winner across 9 dimensions (Gaming, Camera, Battery, Display, Software, Storage, Connectivity, Security, Portability)
- Per-side SHAP top-5 and an overall winner

### Wishlist

- Add / remove / list saved phones (1-to-many per user)
- Unique constraint on `(userId, phoneId)` prevents duplicates

### ️ Admin (RBAC Phase 1)

- One role per user: `Customer`, `Salesman`, `Admin`
- Admin-only user CRUD (`GET /users`, `POST /users`, `PATCH /users/:id`, `DELETE /users/:id`)
- Role assignment: `POST /users/:id/roles`, `DELETE /users/:id/roles/:roleName`
- Self-registration is restricted to `Customer` and `Salesman`; `Admin` is admin-only

### Reporting & Analytics (schema-level)

- `RecommendationHistory` (click / compared / saved / purchased events)
- `ComparisonHistory` (per-user phone-vs-phone comparisons)
- `Wishlist` (per-user)
- `CustomerProfile` (running persona state, totals, averages, `segmentConfidence`)
- `AdminStatsCache` (denormalized snapshot — most-recommended, most-compared, most-viewed, persona popularity, avg compatibility)

### ML

- Trained **XGBoost** booster on engineered features (artifacts bundled under `ML Model/artifacts/`)
- **SHAP TreeExplainer** for per-prediction contributions
- 9-dimension composite score (Gaming, Camera, Battery, Display, Software, Storage, Connectivity, Security, Portability)
- Pre-computed candidate scoring cache for fast in-memory ranking
- Customer segmentation artifacts (KMeans, cluster profiles, brand-mix plots) under `ML Model/segmentation_outputs/`

---

## 3. Technology Stack

| Layer              | Technology                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| Frontend           | React 19 · Vite 8 · React Router 7 · Axios                                                                    |
| Backend            | Node.js 20 · Express 5 · Prisma 7.8 (`@prisma/client`, `@prisma/adapter-pg`)                                  |
| Auth               | Passport Local · express-session · connect-pg-simple · bcrypt                                                 |
| Validation         | express-validator                                                                                             |
| Mail               | Nodemailer (Gmail SMTP by default)                                                                            |
| Database           | PostgreSQL 16                                                                                                 |
| ML Runtime         | Python 3.11 (slim) · FastAPI 0.115 · Uvicorn 0.34                                                             |
| ML Libraries       | XGBoost 2.1.3 · scikit-learn 1.5.2 · pandas 2.2.3 · numpy 1.26.4 · SHAP 0.46.0 · pydantic 2.10 · joblib 1.4.2 |
| Orchestration      | Docker Compose                                                                                                |
| Frontend Container | node:20-alpine                                                                                                |
| Backend Container  | node:20-bookworm-slim (3-stage build)                                                                         |
| ML Container       | python:3.11-slim (2-stage build)                                                                              |

---

## 4. Project Structure

```
mobile-recommendation-system/
├── backend/                      # Node + Express + Prisma API
│   ├── prisma/
│   │   ├── schema.prisma         # Prisma schema (auth, RBAC, phones, history, analytics)
│   │   ├── data-quality.mjs      # One-shot data QA helper
│   │   ├── deep-verify.mjs       # Deep verification of imports
│   │   ├── import-gsmarena-bulk.mjs  # Bulk CSV → DB importer (run by db-init)
│   │   ├── verify-import.mjs     # Light import verification
│   │   └── migrations/           # Prisma migration history
│   ├── src/
│   │   ├── config/               # prisma, email, ml singletons
│   │   ├── controller/           # Thin HTTP handlers (auth, user, phone, recommend)
│   │   ├── middleware/           # auth, RBAC, OTP, error, validation, context
│   │   ├── routes/               # Route registration (main, auth, user, ownUser, phone, recommend, product)
│   │   ├── services/             # Business logic (auth, user, rbac, phone, recommend)
│   │   ├── strategies/           # Passport Local strategy
│   │   ├── serializers/          # phoneSerializer (list-item vs detail shape)
│   │   ├── utils/                # ApiError, ApiResponse, catchAsync, crypto, email
│   │   ├── validation/           # express-validator schemas
│   │   ├── mockData/             # Local mock data helpers
│   │   ├── generated/            # Prisma generated client (output dir)
│   │   └── index.mjs             # Express bootstrap
│   ├── docs/                     # api.md, architecture.md, plan, flows, updates
│   ├── seed.mjs                  # RBAC seed (Customer / Salesman / Admin)
│   ├── prisma.config.ts          # Prisma config
│   ├── Dockerfile                # 3-stage Node image
│   ├── package.json              # dev, seed:rbac, seed:phones, db:init
│   └── .env.example              # Backend-local env vars
│
├── frontend/                     # React + Vite SPA
│   ├── src/
│   │   ├── components/           # Auth, Login, Registration, ForgotPassword, Dashboard,
│   │   │                         # PhoneListing, PhoneDetail, Compare, ComparePanel, AuthShared
│   │   ├── hooks/useAuth.jsx     # AuthProvider, session validation, localStorage sync
│   │   ├── services/             # api.js, phones.js, recommend.js (Axios wrappers)
│   │   ├── assets/               # Phone images, hero, favicon
│   │   ├── App.jsx, main.jsx     # App shell + router + protected routes
│   │   └── *.css                 # Component styles
│   ├── public/                   # favicon.svg, icons.svg
│   ├── Dockerfile                # Single-stage Vite dev server
│   ├── package.json              # dev (vite), build, lint, preview
│   └── vite.config.js
│
├── ML Model/                     # FastAPI ML service
│   ├── pipeline/
│   │   ├── serve.py              # FastAPI app, routes, lifespan
│   │   ├── model.py              # MobileRecommendationPipeline (XGBoost + SHAP)
│   │   ├── features.py           # Feature engineering
│   │   ├── scoring.py            # 11-dim composite scoring
│   │   ├── recommend.py          # PersonaType, UserPreferenceInput, ranker
│   │   ├── test_pipeline.py      # Pipeline tests
│   │   └── __init__.py
│   ├── artifacts/                # model.json, feature_columns.json,
│   │                             # category_dtypes.json, scoring_snapshot.json,
│   │                             # training_report.json
│   ├── segmentation_outputs/     # Customer segmentation (KMeans, plots, profiles)
│   ├── After_EDA_and_Feature_ENginering.csv  # Engineered candidate dataset (baked into image)
│   ├── *.ipynb                   # EDA, preprocessing, segmentation notebooks
│   ├── requirements.txt          # Pinned pip deps
│   └── Dockerfile                # 2-stage Python slim image
│
├── dataset/                      # Source CSVs
│   ├── GSMArena_Cleaned_Dataset.csv
│   └── customer_dataset.csv
│
├── Documentation/                # Project proposals, mid-term presentation, FUTURE_WORK.md
├── docker-compose.yml            # 5-service orchestration
├── .env.example                  # Root env template (compose-time)
└── README.md                     # You are here
```

---

## 5. System Architecture

```
                 ┌──────────────────────────────────────────────┐
                 │                  Browser                     │
                 │        React 19 + Vite (port 5173)           │
                 └────────────────────┬─────────────────────────┘
                                      │  /api/*  (Axios, cookies)
                                      ▼
                 ┌──────────────────────────────────────────────┐
                 │     Node.js + Express 5 (port 8001)           │
                 │   Auth · RBAC · Phones · Recommend · Admin    │
                 └────────┬─────────────────────────────┬───────┘
                          │ Prisma 7 + pg adapter        │ HTTP (axios/fetch)
                          ▼                              ▼
            ┌──────────────────────────┐    ┌──────────────────────────┐
            │   PostgreSQL 16 (5432)   │    │   FastAPI ML (port 8002) │
            │   Users · Phones · etc.  │    │  XGBoost + SHAP ranker   │
            └──────────────────────────┘    └──────────────────────────┘
```

**Request flow inside the backend** (per `backend/docs/architecture.md`):

```
Client → Routes → Middleware → Controller → Service → Prisma → PostgreSQL
```

Controllers never touch Prisma. Services never touch `req` / `res` / `next`. Authorization always reads from `req.auth`, never from `req.user`.

---

## 6. Database

Schema source: `backend/prisma/schema.prisma`. Models are normalized — phone pricing lives in `PhoneVariants`, technical specifications in `PhoneSpecs`, and brand identity in `Brands`. Users can hold at most **one** role.

### Core Models

| Model                   | Purpose                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `Users`                 | Account row; FK to `Roles`; one-role-per-user RBAC                                                         |
| `Roles`                 | `Customer`, `Salesman`, `Admin` (seeded via `npm run seed:rbac`)                                           |
| `Otp`                   | Time-bound, single-use OTPs (purposes: `Registration`, `PasswordReset`, `EmailChange`)                     |
| `Session`               | `connect-pg-simple` session store (Prisma-owned, not auto-created)                                         |
| `Brands`                | Master brand list (logo, website, country)                                                                 |
| `Phones`                | One row per phone model; `unique(brandId, modelName)`; soft-deletable                                      |
| `PhoneVariants`         | RAM/Storage/Price combinations; `unique(phoneId, ramGb, storageGb)`                                        |
| `PhoneSpecs`            | 1-to-1 with `Phones`: network, display, platform, camera, physical, battery, metadata                      |
| `UserProfile`           | Demographics: age, gender, country, state, city                                                            |
| `UserPreference`        | Questionnaire: budget, camera preference, usage type, preferred brand                                      |
| `RecommendationHistory` | Every recommendation served, with click/compared/saved/purchased events                                    |
| `CustomerProfile`       | Running state: persona, totals, averages, `segmentConfidence`                                              |
| `Wishlist`              | Per-user saved phones (`unique(userId, phoneId)`)                                                          |
| `ComparisonHistory`     | Per-user comparison pairs                                                                                  |
| `AdminStatsCache`       | Denormalized snapshot: most-recommended, most-compared, most-viewed, persona popularity, avg compatibility |

### Notable Enums

- `CameraPreference`: `Sensible`, `Photophile`, `Selfie-Addict`
- `UsageType`: `Student`, `Gamer`, `Business`, `Casual`, `Creator`
- `BudgetSegment`: `Budget Explorer`, `Affordable Buyer`, `Mid Range Buyer`, `Premium Buyer`, `Luxury Buyer`
- `TechTier`: `Budget`, `Reasonable`, `Flagship Killer`, `Tech Savvy`, `Luxurious`
- `SegmentConfidence`: `provisional`, `confirmed`

### Phone Catalog ERD (simplified)

```
Brands ─┐
        │ 1:N
        ▼
      Phones ─┬─ 1:1 ─ PhoneSpecs
              │
              └─ 1:N ─ PhoneVariants
```

---

## 7. API Documentation

> All paths are mounted under **`/api`** (see `backend/src/index.mjs:60`). The home `GET /` returns plain-text `Home` and is **not** part of the JSON contract.

### 7.1 Auth (`/api/auth`)

| Method | Endpoint                      | Purpose                                             |
| ------ | ----------------------------- | --------------------------------------------------- |
| `GET`  | `/auth/role-options`          | List self-assignable roles (`Customer`, `Salesman`) |
| `POST` | `/auth/register`              | Create account; sends OTP email                     |
| `POST` | `/auth/verify`                | Verify registration OTP                             |
| `POST` | `/auth/resend`                | Resend registration OTP                             |
| `POST` | `/auth/login`                 | Authenticate with email + password + `roleName`     |
| `POST` | `/auth/logout`                | Destroy session; requires login                     |
| `POST` | `/auth/forget`                | Send password-reset OTP                             |
| `POST` | `/auth/forget/verify`         | Verify password-reset OTP                           |
| `POST` | `/auth/forget/changePassword` | Set new password after OTP verification             |
| `POST` | `/auth/me/email/request`      | Request email change (current password + new email) |
| `POST` | `/auth/me/email/verify`       | Verify email-change OTP                             |

### 7.2 Users (self-service) (`/api/users/me`)

| Method  | Endpoint               | Purpose                                       |
| ------- | ---------------------- | --------------------------------------------- |
| `GET`   | `/users/me`            | Get own profile                               |
| `PATCH` | `/users/me`            | Update own name / phone                       |
| `PATCH` | `/users/me/password`   | Change own password (current + new + confirm) |
| `POST`  | `/users/me/deactivate` | Deactivate own account, log out, clear cookie |

### 7.3 Users (admin) (`/api/users`)

All admin endpoints require `requireRole("Admin")` and a valid session.

| Method   | Endpoint                     | Purpose             |
| -------- | ---------------------------- | ------------------- |
| `GET`    | `/users`                     | List all users      |
| `GET`    | `/users/:id`                 | Get user by id      |
| `POST`   | `/users`                     | Create a user       |
| `PATCH`  | `/users/:id`                 | Update a user       |
| `DELETE` | `/users/:id`                 | Delete a user       |
| `POST`   | `/users/:id/roles`           | Assign role to user |
| `DELETE` | `/users/:id/roles/:roleName` | Revoke user's role  |

### 7.4 Phones (`/api/phones`)

| Method | Endpoint                   | Purpose                                                                                                                                                                                                                                                 |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/phones`                  | Paginated list with filters (`brand`, `minPrice`, `maxPrice`, `minRam`, `minStorage`, `has5G`, `hasNfc`, `hasOis`, `hasHeadphoneJack`, `os`, `chipset`, `displayType`, `minBattery`, `minRefreshRate`, `minLensCount`, `year`, `sort`, `page`, `limit`) |
| `GET`  | `/phones/:id`              | Phone detail (full specs + variants)                                                                                                                                                                                                                    |
| `GET`  | `/phones/search?q=...`     | Search by model name                                                                                                                                                                                                                                    |
| `GET`  | `/phones/brand/:brandName` | List phones for a brand                                                                                                                                                                                                                                 |
| `GET`  | `/phones/filters`          | Filter options: brands, OS, display types, years, price range, RAM, storage, features, sort options                                                                                                                                                     |
| `GET`  | `/phones/stats`            | Catalog stats: totals, pricing, feature counts, averages, top brands                                                                                                                                                                                    |
| `GET`  | `/phones/featured`         | Top 10 by AnTuTu among 5G phones                                                                                                                                                                                                                        |
| `GET`  | `/phones/latest`           | Top 10 by `announced` date                                                                                                                                                                                                                              |
| `GET`  | `/phones/best-value`       | Top 10 AnTuTu phones ≤ €300 with ≥ 6 GB RAM                                                                                                                                                                                                             |
| `POST` | `/phones/compare`          | Compare 2–5 phones by `phoneIds` array                                                                                                                                                                                                                  |

### 7.5 Recommendation (`/api/recommend`)

| Method | Endpoint                | Purpose                                                |
| ------ | ----------------------- | ------------------------------------------------------ |
| `GET`  | `/recommend/health`     | ML service health check                                |
| `POST` | `/recommend/recommend`  | ML-ranked recommendations (enriched with DB data)      |
| `POST` | `/recommend/compare-ml` | ML-powered per-dimension comparison between two phones |

### 7.6 Products (`/api/products`)

| Method | Endpoint    | Purpose                              |
| ------ | ----------- | ------------------------------------ |
| `GET`  | `/products` | Placeholder; requires authentication |

### Response Envelopes

**Success:**

```json
{ "success": true, "message": "optional", "data": {} }
```

**Paginated:**

```json
{
  "success": true,
  "data": [],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 123,
    "totalPages": 7,
    "hasNextPage": true,
    "hasPrevPage": false
  }
}
```

**Error:**

```json
{
  "success": false,
  "code": "RESOURCE_NOT_FOUND",
  "message": "Phone not found",
  "details": {}
}
```

`limit` is capped at **100**. Out-of-range pages return empty `data`, not a 404.

### Error Code Registry

| `code`                     | HTTP | Source                        |
| -------------------------- | ---- | ----------------------------- |
| `AUTH_NOT_AUTHENTICATED`   | 401  | missing/invalid session       |
| `AUTH_INVALID_CREDENTIALS` | 401  | bad password                  |
| `AUTH_ACCOUNT_DEACTIVATED` | 403  | `isActive === false`          |
| `AUTH_FORBIDDEN_ROLE`      | 403  | role check failed             |
| `VALIDATION_INVALID_INPUT` | 400  | express-validator / bad shape |
| `OTP_INVALID`              | 400  | wrong/used/expired OTP        |
| `RESOURCE_NOT_FOUND`       | 404  | domain miss                   |
| `DUPLICATE_ENTRY`          | 409  | Prisma `P2002`                |
| `RECORD_NOT_FOUND`         | 404  | Prisma `P2025`                |
| `FOREIGN_KEY_FAILURE`      | 400  | Prisma `P2003`                |
| `INTERNAL_ERROR`           | 500  | catch-all                     |

---

## 8. ML Service

Source: `ML Model/pipeline/serve.py`. Started as:

```bash
uvicorn pipeline.serve:app --host 0.0.0.0 --port 8002
```

The service loads `MobileRecommendationPipeline(ARTIFACT_DIR)` on startup, pre-computes a scored candidate DataFrame from `After_EDA_and_Feature_ENginering.csv`, and serves all endpoints with a uniform `{success, code, message, ...}` error envelope.

### Endpoints

| Method | Path                            | Purpose                                                                                       |
| ------ | ------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET`  | `/health`                       | Liveness + `model_loaded` + `candidates_count` (+ `load_error` when degraded)                 |
| `POST` | `/predict`                      | Body: `{"features": {...}, "top_n_shap": 5}` → AnTuTu (linear + log) + SHAP top-N             |
| `POST` | `/predict_new`                  | Body: `{"raw": {...}}` → score + SHAP for a phone not in the dataset                          |
| `POST` | `/score`                        | Body: `{"features": {...}}` → 9-dimension composite score                                     |
| `POST` | `/recommend`                    | Body: `RecommendRequest` → ranked phones with match score and "why" list                      |
| `POST` | `/compare`                      | Body: `{"model_name_a": "...", "model_name_b": "..."}` → per-dimension winner + SHAP per side |
| `GET`  | `/explain/{model_name}?top_n=5` | SHAP top-N for a phone in the pool                                                            |
| `GET`  | `/phones?search=&limit=`        | Convenience list of candidate phones                                                          |

### `POST /recommend` request shape

```json
{
  "persona": "gamer | camera | battery | allrounder | business | custom",
  "budget": { "min": 0, "max": 1200 },
  "preferences": {
    "gaming": 5,
    "camera": 3,
    "battery": 4,
    "display": 4
  },
  "topN": 6
}
```

Persona aliases accepted by the service: `gamer`, `camera`, `battery`, `allrounder`, `business`, `custom` (and the PascalCase enum values). Missing preference keys are padded with `3` (neutral).

### `POST /compare` response shape (abridged)

```json
{
  "Phone_A": "Pixel 8 Pro", "Price_A": 999,
  "Phone_B": "Galaxy S24",   "Price_B": 899,
  "Dimension_Comparison": {
    "Gaming": { "A": 8.1, "B": 7.4, "Winner": "A" },
    "Camera": { "A": 9.2, "B": 8.8, "Winner": "A" }
    /* …Battery, Display, Software, Storage, Connectivity, Security, Portability… */
  },
  "Overall_Winner": "A",
  "SHAP_A": [{ "feature": "chipset_score", "shap": 1.4 }, …],
  "SHAP_B": [{ "feature": "antutu_score",  "shap": 0.9 }, …]
}
```

### Artifacts Shipped

`ML Model/artifacts/`:

- `model.json` — XGBoost booster
- `feature_columns.json` — frozen training feature order
- `category_dtypes.json` — categorical index snapshot
- `scoring_snapshot.json` — quantile snapshot for 11 score columns
- `training_report.json` — training metrics

`ML Model/segmentation_outputs/` — customer segmentation (KMeans, cluster profiles, brand-mix plots, PCA cluster plot, K-selection diagnostics, spend-per-cluster).

---

## 9. Environment Variables

### Root `.env.example` (used by `docker-compose.yml`)

| Variable            | Required       | Default              | Purpose                                                                         |
| ------------------- | -------------- | -------------------- | ------------------------------------------------------------------------------- |
| `POSTGRES_USER`     | yes            | `postgres`           | PostgreSQL username (also injected into backend `DATABASE_URL`)                 |
| `POSTGRES_PASSWORD` | **yes**        | —                    | PostgreSQL password. **Required** — `docker-compose.yml` errors out if missing. |
| `POSTGRES_DB`       | yes            | `mobile_recommender` | Database name                                                                   |
| `COOKIE_SECRET`     | **yes**        | —                    | Session signing secret. Generate with `openssl rand -hex 32`                    |
| `SMTP_HOST`         | optional (dev) | —                    | SMTP host (e.g. `smtp.gmail.com`)                                               |
| `SMTP_PORT`         | optional       | `587`                | SMTP port                                                                       |
| `SMTP_USER`         | optional       | —                    | SMTP username                                                                   |
| `SMTP_PASS`         | optional       | —                    | SMTP password / app password                                                    |

### `backend/.env.example` (host-only dev without Docker)

| Variable        | Required       | Default                                                                             | Purpose                                                                                              |
| --------------- | -------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `PORT`          | no             | `8001`                                                                              | Express port                                                                                         |
| `NODE_ENV`      | no             | `development`                                                                       | Environment                                                                                          |
| `DATABASE_URL`  | yes (host dev) | `postgresql://postgres:postgres123@localhost:5432/mobile_recommender?schema=public` | Prisma connection. **Overridden by compose to point at the `postgres` service.**                     |
| `COOKIE_SECRET` | yes            | placeholder                                                                         | Session secret. **Overridden by compose.**                                                           |
| `ML_BASE_URL`   | yes            | `http://127.0.0.1:8002`                                                             | URL the backend uses to reach the ML service. **Overridden by compose to `http://ml-service:8002`.** |
| `CORS_ORIGIN`   | no             | `http://localhost:5173`                                                             | Comma-separated allowed CORS origins                                                                 |
| `SMTP_HOST`     | optional       | `smtp.gmail.com`                                                                    | SMTP host                                                                                            |
| `SMTP_PORT`     | optional       | `587`                                                                               | SMTP port                                                                                            |
| `SMTP_USER`     | optional       | placeholder                                                                         | SMTP username                                                                                        |
| `SMTP_PASS`     | optional       | placeholder                                                                         | SMTP app password                                                                                    |

> **Never commit the real `.env`.** Both root and backend `.gitignore` already exclude it. Use a Gmail **App Password** (not your real Gmail password) — see https://myaccount.google.com/apppasswords.

---

## 10. Docker

`docker-compose.yml` defines **five services**, booted in this order:

1. **`postgres`** — `postgres:16-alpine`
   - Healthchecked via `pg_isready`
   - Named volume `postgres_data` for durability
2. **`db-init`** (one-shot) — same `backend` image, overridden `CMD`:
   - `npx prisma db push` → apply schema
   - `npm run seed:rbac` → system roles + customer backfill
   - `node ./prisma/import-gsmarena-bulk.mjs /seed/GSMArena_Cleaned_Dataset.csv` → bulk-import the phone catalog
   - Bound-mounts `./dataset/GSMArena_Cleaned_Dataset.csv` → `/seed/...`
   - `restart: "no"` so a failure is visible, not silently retried
3. **`ml-service`** — `ML Model/Dockerfile`
   - FastAPI / Uvicorn on port `8002`
   - Healthchecked via `curl /health` (curl is installed in the runtime image for this purpose)
4. **`backend`** — `backend/Dockerfile`
   - Multi-stage build (deps → prisma-gen → runtime, all on `node:20-bookworm-slim`)
   - Runs as the non-root `node` user under `tini` (PID 1)
   - Depends on `postgres` (healthy), `db-init` (completed), `ml-service` (healthy)
5. **`frontend`** — `frontend/Dockerfile`
   - Single-stage `node:20-alpine`
   - Vite dev server bound to `0.0.0.0:5173`
   - `CHOKIDAR_USEPOLLING=true` is set in the image so HMR works on macOS / Windows hosts

Port mapping summary:

| Service      | Host port | Container port |
| ------------ | --------- | -------------- |
| `postgres`   | 5432      | 5432           |
| `backend`    | 8001      | 8001           |
| `ml-service` | 8002      | 8002           |
| `frontend`   | 5173      | 5173           |

---

## 11. Installation

### 11.1 Clone the repository

```bash
git clone https://github.com/AayushChhuka7/mobile-recommendation-system.git
cd mobile-recommendation-system
```

### 11.2 Copy the environment file

**Linux / macOS**

```bash
cp .env.example .env
```

**Windows (PowerShell)**

```powershell
copy .env.example .env
```

Open `.env` and set real values for `POSTGRES_PASSWORD` and `COOKIE_SECRET`:

```env
POSTGRES_PASSWORD=your_strong_password
COOKIE_SECRET=$(openssl rand -hex 32)
```

> **Windows (PowerShell) — generate a cookie secret:**
>
> ```powershell
> -join (1..64 | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
> ```

If you want OTP / password-reset emails, also fill in `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`.

### 11.3 Run

```bash
docker compose up --build
```

> **First startup** runs the `db-init` service which pushes the Prisma schema, seeds the RBAC roles, and bulk-imports the GSMArena CSV. **This takes several minutes** depending on your machine. Subsequent restarts reuse the existing `postgres_data` volume and skip the CSV import.

---

## 12. Access URLs

| Service                          | URL                                                               |
| -------------------------------- | ----------------------------------------------------------------- |
| Frontend (Vite dev)              | <http://localhost:5173>                                           |
| Backend API base                 | <http://localhost:8001/api>                                       |
| Backend health (liveness ping)   | <http://localhost:8001/> (returns plain-text `Home`)              |
| ML service                       | <http://localhost:8002/health>                                    |
| ML interactive docs (Swagger UI) | <http://localhost:8002/docs>                                      |
| ML alternate docs (ReDoc)        | <http://localhost:8002/redoc>                                     |
| PostgreSQL                       | `localhost:5432` (user: `${POSTGRES_USER}`, db: `${POSTGRES_DB}`) |

---

## 13. Useful Docker Commands

```bash
# Stop everything (keeps volumes)
docker compose down

# Stop and DELETE volumes (full DB reset)
docker compose down -v

# Rebuild + restart a single service
docker compose up --build backend

# Tail logs
docker compose logs -f backend
docker compose logs -f ml-service
docker compose logs -f db-init

# Re-seed the database from scratch
docker compose down -v
docker compose up --build

# Open a shell in a running container
docker exec -it mobile-recommender-backend sh
docker exec -it mobile-recommender-ml bash
docker exec -it mobile-recommender-db psql -U postgres -d mobile_recommender

# Force re-run the one-shot initializer
docker compose run --rm db-init

# List running containers
docker compose ps
```

---

## 14. Development Workflow

| Change                                                          | Required action                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `frontend/src/**` (JSX/CSS/JS)                                  | **No rebuild** — Vite HMR reloads in the browser. Just save.                                                 |
| `backend/src/**` (controllers/services/routes)                  | **Restart** `backend` container: `docker compose restart backend`                                            |
| `backend/prisma/schema.prisma`                                  | **Rebuild + re-init** the backend image, then re-run `db-init` (or apply manually with `npx prisma db push`) |
| `ML Model/pipeline/**` (Python source)                          | **Rebuild** the `ml-service` image: `docker compose up --build ml-service`                                   |
| `ML Model/requirements.txt`                                     | **Rebuild** the `ml-service` image (deps are installed in the `builder` stage)                               |
| `docker-compose.yml`, root `Dockerfile`s, `.env`                | **Rebuild the affected service(s)**: `docker compose up --build`                                             |
| CSV / dataset under `dataset/`                                  | Re-run `db-init` after refreshing the bind mount: `docker compose run --rm db-init`                          |
| `ML Model/After_EDA_and_Feature_ENginering.csv` or any artifact | Rebuild the `ml-service` image so the new file is baked in                                                   |

**Backend `npm` scripts** (`backend/package.json`):

| Script        | Command                                                      | Purpose                           |
| ------------- | ------------------------------------------------------------ | --------------------------------- |
| `dev`         | `nodemon ./src/index.mjs`                                    | Dev server with auto-reload       |
| `seed:rbac`   | `node ./seed.mjs`                                            | Upsert roles + backfill customers |
| `seed:phones` | `node ./prisma/import-gsmarena-bulk.mjs`                     | Bulk-import phones from CSV       |
| `db:init`     | `prisma db push && npm run seed:rbac && npm run seed:phones` | Full local DB bootstrap           |

**Frontend `npm` scripts** (`frontend/package.json`):

| Script    | Command        | Purpose                   |
| --------- | -------------- | ------------------------- |
| `dev`     | `vite`         | Vite dev server           |
| `build`   | `vite build`   | Production bundle         |
| `lint`    | `eslint .`     | Lint                      |
| `preview` | `vite preview` | Preview production bundle |

---

## 15. Troubleshooting

### `COOKIE_SECRET` / `POSTGRES_PASSWORD` not set

`docker-compose.yml` uses `${VAR:?...}` substitution. Compose aborts with a clear message. Set them in `.env`.

### Frontend opens but API calls fail with CORS

- The backend allows `http://localhost:5173` only. If you change the FE port, set `CORS_ORIGIN` in the root `.env` to match.
- The browser must send `withCredentials: true` (the frontend `services/api.js` already does this).

### ML service returns 503

`GET /health` reports `model_loaded: false` with a `load_error` field. Common causes:

- Missing `ML Model/artifacts/model.json` (artifacts dir is in `.dockerignore`? — re-check the ML Dockerfile's `COPY artifacts/ ./artifacts/`)
- Missing `ML Model/After_EDA_and_Feature_ENginering.csv`

Rebuild the image (`docker compose up --build ml-service`) after fixing the file layout.

### `db-init` fails / takes forever

- The CSV import is a single Node script that reads `dataset/GSMArena_Cleaned_Dataset.csv` and writes to Postgres. On a fresh DB this can take several minutes.
- Inspect progress: `docker compose logs -f db-init`.

### `bcrypt` build errors on a custom Node image

`backend/Dockerfile` deliberately uses `node:20-bookworm-slim` instead of Alpine because bcrypt@6 lacks prebuilt musl wheels. If you switch to Alpine, expect a 60–180s `node-gyp` compile (and potential failures in low-RAM CI).

### Vite HMR hangs in Docker on Mac/Windows

`CHOKIDAR_USEPOLLING=true` is set in the frontend Dockerfile. If you bind-mount a different path, keep this env var set.

### Login immediately bounces back to `/login`

Frontend `useAuth` validates the session on boot via `GET /users/me`. A 401 means the `connect.sid` cookie was lost. Confirm:

- `cookie.secure` is `false` in dev (it is — see `backend/src/index.mjs:46`)
- Your browser is not blocking third-party cookies
- The backend can actually reach the `postgres` service for session lookups (check `docker compose logs backend`)

### `docker compose down -v` is destructive

It deletes the `postgres_data` named volume — **all data is lost**. The next `up` will rerun the slow CSV import.

### Need to re-seed manually

```bash
docker compose run --rm db-init
```

This re-pushes the Prisma schema, re-seeds the RBAC roles, and re-imports the CSV.

### OTP emails never arrive

- The backend silently no-ops if SMTP is unconfigured — the request returns 200 but the email is never sent.
- For Gmail, use an **App Password** (`SMTP_PASS`), not your real Gmail password.
- Check `docker compose logs backend` for any nodemailer errors.

---

## 16. Future Improvements

See `Documentation/FUTURE_WORK.md` for the full backlog. Highlights:

- **Recommendation module — application layer** (schema in place; services / controllers are next)
- **Reporting dashboards** powered by the `AdminStatsCache` and `CustomerProfile` tables
- **CI/CD pipeline** (the multi-stage Dockerfiles are already cache-optimized for it)
- **Production frontend profile** (run `npm run build` and serve `dist/` via nginx)
- **Tightened CORS allow-list** for the ML service (currently `*` in dev)
- **Background jobs** for re-computing the `AdminStatsCache` on a schedule
- **Improved SHAP UX** (waterfall charts, force plots)
- **Per-region pricing / currency** (today everything is EUR)
- **Multi-role RBAC** (currently one-role-per-user; a permission model could be reintroduced per `backend/docs/plans_role_endpoint.md`)

---

## 17. Contributors

| Name               | GitHub                                               |
| ------------------ | ---------------------------------------------------- |
| Aayush Chhuka      | [@AayushChhuka7](https://github.com/AayushChhuka7)   |
| HomeRaj Bhandari   | [@homrajbhandari](https://github.com/homrajbhandari) |
| Sudip Kumar Tamang | [@sudeeptmng](https://github.com/sudeeptmng)         |
| Suresh Khadka      | [@suresh-khadka](https://github.com/suresh-khadka)   |

> **Adding yourself:** open a PR that updates this list and a short description of your contribution. Project conventions and contribution guidelines live under `Documentation/`.

---

## 18. License

This project is licensed under the **ISC License** (per `backend/package.json`). See the project root for the full license text.

---

<div align="center">
  <sub>Built with Node.js · Express · Prisma · PostgreSQL · React · Vite · FastAPI · XGBoost · SHAP · Docker.</sub>
</div>
