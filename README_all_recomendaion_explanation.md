# Smartphone Hybrid Recommendation System

> **Customer Segmentation and Intelligent Mobile Recommendation System**
> Tribhuvan University — National College of Engineering (BCT minor project)
> Authors: Aayush Chhuka, Hom Raj Bhandari, Sudip Kumar Tamang, Suresh Khadka

This README is the practical, code-level guide for this project. It explains:

1. **What the system does** — the hybrid recommender from end to end
2. **What is already built** — code you can run today (your existing flow is preserved)
3. **What still needs to be built** — small additions that layer on top of your current code without changing it
4. **Step-by-step plan** to reach the goal, mapped to actual files in this repo
5. **How to run, test, and extend**

For the full design document, see [`Documentation/Smartphone_Hybrid_Recommendation_Architecture.md`](Documentation/Smartphone_Hybrid_Recommendation_Architecture.md). This README is the implementation map that stays consistent with that design and respects your existing project flow.

---

## 1. The goal, in one paragraph

A user signs up, answers a short 4-question survey, and immediately gets the top 10 smartphones ranked for them. Every later action (search, view, compare, click, save) is logged and used to influence the next set of recommendations — both instantly in the current session (via the Profile Fusion Engine) and permanently once behaviour is consistent enough (via the Profile Evolution Engine). Each recommendation is also explained with a few bullet points ("why this phone?") so the system is defensible in a viva / report.

Your existing flow — Python notebook for feature engineering → trained XGBoost model → FastAPI sidecar for scoring → Node/Express + Prisma gateway → React frontend — stays exactly as it is. The new pieces below are added alongside, not in place of.

---

## 2. The hybrid pipeline (what each box does)

```
                OFFLINE (Python, already done)
                ─────────────────────────────
Smartphone Dataset (GSMArena + AnTuTu)
        │
        ▼
Feature Engineering  ────────────────────  ✅ DONE  (Preprocessing_all_dataset.ipynb)
        │
        ▼
XGBoost → Predicted AnTuTu  ──────────────  ✅ DONE  (artifacts/model.json, R²=0.85)
        │
        ▼
Smartphone Knowledge Base  ───────────────  ✅ DONE  (backend/prisma/schema.prisma
        │                                              → Brands, Phones, PhoneVariants,
        │                                                 PhoneSpecs)
══════════════════════════════════════════ (offline / online boundary)
                ONLINE (per request)
                ─────────────────────
Rule-Based Filtering  ────────────────────  ✅ DONE  (pipeline/recommend.py)
        │
        ▼
Compatibility Scoring  ───────────────────  ✅ DONE  (pipeline/scoring.py)
        │
        ▼
Personalized Weighting  ──────────────────  ✅ DONE  (PERSONA_PRESETS in recommend.py)
        │
        ▼
Content-Based Similarity  ────────────────  ✅ DONE  (Notbook + similarity_bundle.joblib)
        │
        ▼
Profile Fusion Engine  ──────────────────  🆕 NEW  (in-memory blend, per request)
        │   explicit_priority (β≈0.7) + behavior_score (1−β)
        ▼
Search / Behaviour Score  ────────────────  🆕 NEW  (events → behavior_scores)
        │
        ▼
Final Ranking Formula  ──────────────────  🆕 NEW  (fusion of 6 sub-scores, weights below)
        │
        ▼
Diversity Re-ranking (MMR)  ─────────────  🆕 NEW  (brand cap, no duplicate-heavy top 10)
        │
        ▼
Explainable AI Layer  ───────────────────  🆕 NEW  (SHAP + rule templates)
        │
        ▼
Top-10 Ranked, Explained → React Frontend  ✅ DONE  (PhoneListing.jsx)
        │
        ▼  (async, non-blocking)
Behaviour Analyzer → Confidence Checker → Profile Evolution Engine  🆕 NEW
        │                                                    │
        ▼                                                    ▼
Updated Explicit Profile (or Suggested-Change prompt)  →  improves next request
```

Final Ranking Formula (default weights — treat as hyperparameters):

```
Final Score =
    0.40 × Compatibility Score        (from pipeline/scoring.py)
  + 0.20 × Customer Preference Score  (from PersonaType weights)
  + 0.15 × Content Similarity Score   (from similarity_bundle.joblib)
  + 0.10 × Search History Score       (NEW — from behaviour_scores)
  + 0.10 × Value Score                (from pipeline/scoring.py)
  + 0.05 × Popularity Score           (optional)
```

All six sub-scores are **min-max normalised to 0–1** before weighting. The five weights (0.40/0.20/0.15/0.10/0.10/0.05) are a sensible default; tweak them once you have any click data.

---

## 3. What's already built (your current flow — DO NOT CHANGE)

| # | Component | Status | Where it lives |
|---|---|---|---|
| 1 | Data cleaning + feature engineering | ✅ | `ML Model/Preprocessing_all_dataset.ipynb` → `After_EDA_and_Feature_ENginering.csv` |
| 2 | XGBoost AnTuTu predictor | ✅ | `ML Model/artifacts/model.json` (test R² = 0.852) |
| 3 | 9-dim composite scoring | ✅ | `ML Model/pipeline/scoring.py` (Gaming, Camera, Battery, Display, Software, Storage, Connectivity, Security, Portability, Value) |
| 4 | Persona-based ranking | ✅ | `ML Model/pipeline/recommend.py` (Gamer, Camera_Lover, Battery_Focused, All_Rounder, Business_User, Custom) |
| 5 | Content-based similarity (.joblib) | ✅ | `ML Model/similarity_bundle.joblib` (cosine) |
| 6 | FastAPI ML service | ✅ | `ML Model/pipeline/serve.py` — endpoints `/health`, `/predict`, `/score`, `/recommend`, `/compare`, `/explain`, `/predict_new` |
| 7 | Express + Prisma gateway | ✅ | `backend/src/index.mjs` + `backend/prisma/schema.prisma` |
| 8 | Phone schema (Brands, Phones, PhoneVariants, PhoneSpecs) | ✅ | `backend/prisma/schema.prisma` |
| 9 | User-side tables ready | ✅ | `UserProfile`, `UserPreference`, `CustomerProfile` exist in `schema.prisma` — only endpoints are missing |
| 10 | Recommendation proxy | ✅ | `backend/src/routes/recommendRoutes.mjs` + `services/recommendService.mjs` |
| 11 | React frontend | ✅ | `frontend/src/components/PhoneListing.jsx`, `Dashboard.jsx` |
| 12 | Auth (register, OTP, login, forget password) | ✅ | `backend/src/routes/authRoutes.mjs` |

**None of the above is touched by the new work.** The new components sit beside them.

---

## 4. What needs to be added (six new pieces, all small)

| # | New piece | Why it matters | Effort |
|---|---|---|---|
| A | **Customer Profile persistence** (explicit + implicit) | Returning users shouldn't re-fill the form | 1 day |
| B | **Behaviour event log + Search History Score** | Recommendations adapt to real usage | 1–2 days |
| C | **Profile Fusion Engine** (in-memory, per request) | Same-session behaviour nudges today's recs immediately — no DB writes | ½ day |
| D | **Final Ranking fusion formula** | Combines 6 sub-scores into one number | ½ day |
| E | **Diversity re-ranking (MMR)** | Top-10 isn't ten OnePlus variants | ½ day |
| F | **Profile Evolution Engine** (confidence-checked, suggested-change mode) | Long-term profile updates only when behaviour is consistent | 1 day |
| G | **Explainability wiring** | Surface SHAP bullets and rule-based reasons in the UI | ½ day |

Total: ~6 days of focused work. None of it requires you to rewrite what you already have.

---

## 5. Step-by-step plan (matches your project flow)

Each step says **what to add, where to put it, and how to verify it**. Do them in order — each step builds on the previous one's data.

### Step 0 — Pre-flight: nothing changes (5 minutes)

Confirm your current end-to-end run works:

```bash
# 1. ML service
cd "ML Model" && source venv/bin/activate
uvicorn pipeline.serve:app --port 8002
curl http://localhost:8002/health
# expected: {"status":"ok","model_loaded":true,"candidates_count":~8500}

# 2. Backend
cd ../backend && npm run dev
# 3. Frontend
cd ../frontend && npm run dev
```

If all three start and `/api/recommend/recommend` returns phones, you have a baseline. Everything below adds to it.

---

### Step A — Customer Profile persistence (1 day)

**Goal:** Save the user's preference so it survives between sessions.

**Files to touch (add only — no modifications to existing files except wiring):**

1. **Migration** — the Prisma schema already has `UserProfile`, `UserPreference`, `CustomerProfile`. Run:
   ```bash
   cd backend
   npx prisma migrate dev --name ensure_profile_tables
   ```

2. **New file: `backend/src/routes/profileRoutes.mjs`**
   ```js
   import { Router } from "express";
   import { isAuthenticate } from "../middleware/auth.mjs";
   import { getProfile, onboardProfile, patchProfile } from "../controller/profileController.mjs";

   export const profileRoutes = Router();
   profileRoutes.use(isAuthenticate);
   profileRoutes.get("/me",        getProfile);
   profileRoutes.post("/onboard",  onboardProfile);
   profileRoutes.patch("/me",      patchProfile);
   ```

3. **New file: `backend/src/controller/profileController.mjs`** — reads `req.user.id`, upserts into `UserPreference` + `CustomerProfile`. Map the existing `POST /api/recommend/recommend` body shape (`persona`, `budget.min/max`, `preferences`) into the DB columns.

4. **Mount in `backend/src/routes/main.mjs`** (one line):
   ```js
   import { profileRoutes } from "./profileRoutes.mjs";
   router.use("/profile", profileRoutes);
   ```

5. **Update `backend/src/services/recommendService.mjs`** — when `req.user` is present and the body does not include `persona`/`budget`, read them from the user's stored profile and pass them through to the FastAPI call. **Do not change the FastAPI contract.**

6. **Frontend** — in `frontend/src/components/Dashboard.jsx`, after a successful recommendation request, also call `POST /api/profile/me` to save the persona + budget + slider preferences once.

**Verify:**
```bash
# Register, login, hit /api/profile/me/onboard, then /api/recommend/recommend — no body
curl -b jar.txt http://localhost:8001/api/profile/me
# expected: 200 JSON with persona, budget, preferences
```

---

### Step B — Behaviour event log + Search History Score (1–2 days)

**Goal:** Capture every interaction so the model can adapt.

**Files to add:**

1. **Migration** — add to `backend/prisma/schema.prisma`:
   ```prisma
   model Event {
     eventId    String   @id @default(uuid()) @map("event_id") @db.Uuid
     userId     String   @map("user_id") @db.Uuid
     eventType  String   @map("event_type") @db.VarChar(40)
     phoneId    String?  @map("phone_id") @db.Uuid
     payload    Json?    @map("payload")
     createdAt  DateTime @default(now()) @map("created_at")
     user       Users    @relation(fields: [userId], references: [userId], onDelete: Cascade)
     @@index([userId, createdAt(sort: Desc)])
     @@index([eventType])
     @@map("events")
   }

   model BehaviorScore {
     userId    String   @map("user_id") @db.Uuid
     tag       String   @db.VarChar(60)
     score     Float
     updatedAt DateTime @updatedAt @map("updated_at")
     user      Users    @relation(fields: [userId], references: [userId], onDelete: Cascade)
     @@id([userId, tag])
     @@map("behavior_scores")
   }
   ```
   Then `npx prisma migrate dev --name add_events_behavior_scores`.

2. **New file: `backend/src/routes/eventRoutes.mjs`**
   ```js
   eventRoutes.post("/",            postEvent);   // body: {eventType, phoneId?, payload?}
   eventRoutes.get("/behavior/me",  getBehavior); // current behaviour_scores dict
   ```

3. **New file: `backend/src/services/behaviorAnalyzer.mjs`** with the delta table:
   ```js
   const DELTAS = {
     search:  { gaming: +2, chipset: +1 },
     compare: { gaming: +3 },
     view:    { brand: +1, tier: +1 },
     click:   { brand: +2, category: +1 },
     ignore:  { brand: -1, category: -1 },
     save:    { brand: +4, category: +2 },
   };
   // applied: score = score * 0.95 + delta
   ```

4. **New file: `backend/src/services/searchHistoryScore.mjs`** — pure function:
   ```js
   // search_history_score(phone, user_behavior) ∈ [0,1]
   // tag overlap between phone.tags and behaviour_scores, normalised.
   ```

5. **Frontend hooks** — in `frontend/src/components/PhoneListing.jsx`, fire `POST /api/events` on each click, save, dismiss, compare, view-detail. Do this with a small `useEventLogger` hook in `frontend/src/hooks/`.

**Verify:**
```bash
# Fire a few events, then check the rolled-up score
curl -X POST -b jar.txt -H "Content-Type: application/json" \
     -d '{"eventType":"search","payload":{"q":"ROG"}}' \
     http://localhost:8001/api/events
curl -b jar.txt http://localhost:8001/api/events/behavior/me
```

---

### Step C — Profile Fusion Engine (½ day)

This is the **request-time, in-memory, no-DB-write** step. It reads `explicit_priority` (from your stored profile in Step A) and `behavior_scores` (from Step B) and produces a temporary `final_active_profile` that this request's ranker uses.

**Files to add:**

1. **New file: `backend/src/services/profileFusion.mjs`** — a pure function:
   ```js
   // final_weight[dim] = β * explicit_priority[dim] + (1 - β) * behavior_score[dim]
   // β defaults to 0.7 (explicit dominates)
   export function fuseProfile(explicit, behavior, beta = 0.7) {
     const out = {};
     for (const dim of new Set([...Object.keys(explicit), ...Object.keys(behavior)])) {
       out[dim] = beta * (explicit[dim] ?? 0) + (1 - beta) * (behavior[dim] ?? 0);
     }
     return out;
   }
   ```

2. **Where it's called** — inside `backend/src/services/recommendService.mjs`, **before** the FastAPI `/recommend` call:
   ```js
   const explicitPriority = await loadExplicitPriority(userId);   // from Step A
   const behaviorScores   = await loadBehaviorScores(userId);     // from Step B
   const finalWeights     = fuseProfile(explicitPriority, behaviorScores);
   // pass finalWeights to FastAPI as `custom_weights_stars` (already supported)
   ```

3. **FastAPI side already supports this** — `pipeline/serve.py` already accepts `preferences: {gaming, camera, battery, display}` (lowercase) and translates to the 9-dim `custom_weights_stars`. So the fusion output flows into the existing endpoint with **zero changes** to Python.

**Verify:**
- For a new user with no events, the fusion output ≈ explicit_priority (behaviour scores are 0).
- For a user who has searched "ROG" 5 times, the `gaming` weight in the fusion output should rise, and the next recommendation should rank gaming phones higher.

---

### Step D — Final Ranking fusion formula (½ day)

**Goal:** Combine the existing 5 sub-scores (compat, content similarity, value, persona-weight, popularity if you have it) with the new Search History Score from Step B into one ranked list.

**Files to add:**

1. **New file: `backend/src/services/fusionRanker.mjs`** — pure function:
   ```js
   // Takes an array of candidate phones, each with the 6 sub-scores already
   // computed upstream (compat, content, value, search_history, popularity,
   // persona_fit). Min-max normalises each column to [0,1], applies weights,
   // sorts.
   const WEIGHTS = {
     compatibility:       0.40,
     customer_preference: 0.20,
     content_similarity:  0.15,
     search_history:      0.10,
     value:               0.10,
     popularity:          0.05,
   };
   ```

2. **Where it's called** — in `recommendService.mjs`, after FastAPI returns the persona-ranked list:
   ```js
   const candidatesWithScores = attachSubScores(topN, fastApiResults, behaviorScores);
   const ranked = fusionRanker(candidatesWithScores, WEIGHTS);
   ```

3. **Add `recommendation_logs`** — single Prisma model:
   ```prisma
   model RecommendationLog {
     logId      String   @id @default(uuid()) @map("log_id") @db.Uuid
     userId     String   @map("user_id") @db.Uuid
     phoneId    String   @map("phone_id") @db.Uuid
     finalScore Float    @map("final_score")
     rank       Int
     shownAt    DateTime @default(now()) @map("shown_at")
     clicked    Boolean  @default(false)
     user       Users    @relation(fields: [userId], references: [userId], onDelete: Cascade)
     @@index([userId, shownAt(sort: Desc)])
     @@map("recommendation_logs")
   }
   ```
   Write a row per recommendation in the response.

**Verify:** A phone with high compat but ignored 5 times should drop in the list. A phone previously clicked and saved should rise.

---

### Step E — Diversity re-ranking (½ day)

**Goal:** Top-10 isn't 10× the same brand.

**Files to add:**

1. **New file: `backend/src/services/diversityRerank.mjs`** — implements MMR:
   ```js
   // MMR(d) = λ * relevance(d) − (1 − λ) * max_similarity(d, selected)
   // λ = 0.7
   // Use the FastAPI /compare endpoint (or cosine on features) to get similarity.
   ```
   As a fallback / sanity check, also enforce a **brand cap of 3** per brand in the top 10.

2. **Where it's called** — at the end of `recommendService.mjs`, right before serialising the response.

**Verify:** Force a user persona that strongly favours OnePlus. The top-10 should contain ≤ 3 OnePlus phones, with the remaining slots filled by Samsung / iQOO / Xiaomi / Nothing / Realme.

---

### Step F — Profile Evolution Engine (1 day)

This is the **database-writing** sibling of Step C. It runs **periodically** (or after each event) but only persists a change when behaviour is consistent.

**Files to add:**

1. **Migration** — add `ProfileSuggestion`:
   ```prisma
   model ProfileSuggestion {
     id         String   @id @default(uuid()) @map("id") @db.Uuid
     userId     String   @map("user_id") @db.Uuid
     tag        String   @db.VarChar(60)
     oldValue   Float
     newValue   Float
     confidence Float
     status     String   @default("pending")   // pending | accepted | rejected
     createdAt  DateTime @default(now()) @map("created_at")
     user       Users    @relation(fields: [userId], references: [userId], onDelete: Cascade)
     @@index([userId, status])
     @@map("profile_suggestions")
   }
   ```

2. **New file: `backend/src/services/profileEvolution.mjs`** — implements the pseudocode from the architecture doc:
   ```js
   // 1. Look at the last 5 interactions.
   // 2. If the dominant interest is the same in all 5, AND
   //    confidence = matches_in_window / window_size ≥ 0.8, AND
   //    behaviour_value > explicit_value:
   //    → write a ProfileSuggestion row (suggested-change mode).
   ```

3. **New endpoints** (mount in `profileRoutes.mjs`):
   ```js
   profileRoutes.get( "/me/suggestions",            getSuggestions);
   profileRoutes.post("/me/suggestions/:id/accept", acceptSuggestion);
   profileRoutes.post("/me/suggestions/:id/reject", rejectSuggestion);
   ```

4. **Frontend** — add a banner in `frontend/src/components/Dashboard.jsx`:
   > "We noticed you're into photography lately — update your preferences?"
   > [Update] [Dismiss]

**Verify:** A consistent stream of 5 "camera"-typed events for a "Gamer" persona should create exactly one `ProfileSuggestion` row. An inconsistent stream should create none.

---

### Step G — Explainability wiring (½ day)

**Goal:** "Why this phone?" bullets in the UI.

The FastAPI sidecar already has `/explain/:model_name` (SHAP) and the ranker already returns `Why` (rule-based). Nothing new in Python — only surface it.

**Files to touch:**

1. **New endpoint in `backend/src/routes/recommendRoutes.mjs`:**
   ```js
   recommendRoutes.get("/:userId/:phoneId/explain", getExplain);
   ```
   Calls FastAPI `/explain/<phoneName>` for SHAP, plus composes rule-based reasons (within budget, matches preferred brand, satisfies min RAM, …) directly in Express.

2. **Frontend** — in `frontend/src/components/PhoneListing.jsx`, expand each phone card to show 3–4 bullets (e.g.):
   ```
   OnePlus 13 — Match Score 96%
   ✓ Within your budget
   ✓ Snapdragon flagship chipset (SHAP: chipset_tier +0.31)
   ✓ High predicted AnTuTu (SHAP: RAM +0.18)
   ✓ Similar to phones you've searched before
   ```

**Verify:** Expand any phone card. You should see at least one SHAP-driven explanation and at least one rule-driven explanation.

---

## 6. How the new pieces fit your existing files

| Your existing file | What changes (only after the corresponding step) |
|---|---|
| `ML Model/pipeline/serve.py` | **Nothing changes.** It already accepts `custom_weights_stars` from the FE. |
| `ML Model/pipeline/recommend.py` | **Nothing changes.** Persona presets stay as they are. |
| `ML Model/pipeline/scoring.py` | **Nothing changes.** |
| `backend/src/services/recommendService.mjs` | Adds: load stored profile → fuse → call FastAPI → attach sub-scores → fusion ranker → diversity rerank → log → return. **The existing FastAPI call stays.** |
| `backend/src/routes/main.mjs` | Adds 2 lines: `router.use("/profile", profileRoutes);` and `router.use("/events", eventRoutes);` |
| `backend/src/routes/recommendRoutes.mjs` | Adds 1 line: `recommendRoutes.get("/:userId/:phoneId/explain", getExplain);` |
| `backend/prisma/schema.prisma` | Adds: `Event`, `BehaviorScore`, `ProfileSuggestion`, `RecommendationLog` |
| `frontend/src/components/PhoneListing.jsx` | Adds: explain expand, event firing, suggestion banner |
| `frontend/src/components/Dashboard.jsx` | Adds: save-profile-once call after recommend |

No file is deleted. No existing logic is rewritten.

---

## 7. How to run the project today

### Prerequisites

- Node.js 20+, npm
- Python 3.11+
- PostgreSQL 14+

### One-time setup

```bash
git clone <repo-url>
cd mobile-recommendation-system

# Backend
cd backend && npm install
# create backend/.env with DATABASE_URL, COOKIE_SECRET, SMTP_*, ML_SERVICE_URL=http://localhost:8002
npx prisma migrate dev
node prisma/import-gsmarena-bulk.mjs     # import CSV → Phones/Brands/PhoneSpecs
cd ..

# Frontend
cd frontend && npm install
# create frontend/.env with VITE_API_URL=http://localhost:8001
cd ..

# ML service
cd "ML Model" && python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cd ..
```

### Start everything (3 terminals)

```bash
# Terminal 1 — ML service (port 8002)
cd "ML Model" && source venv/bin/activate
uvicorn pipeline.serve:app --port 8002 --reload

# Terminal 2 — Backend (port 8001)
cd backend && npm run dev

# Terminal 3 — Frontend (port 5173)
cd frontend && npm run dev
```

### Smoke test

```bash
# Health
curl http://localhost:8002/health

# Register → OTP → login
curl -X POST http://localhost:8001/api/auth/register -H "Content-Type: application/json" \
     -d '{"name":"Demo","email":"demo@x.com","password":"demo123"}'
# (verify OTP via email)
curl -c jar.txt -X POST http://localhost:8001/api/auth/login -H "Content-Type: application/json" \
     -d '{"email":"demo@x.com","password":"demo123"}'

# Recommend
curl -b jar.txt -X POST http://localhost:8001/api/recommend/recommend \
     -H "Content-Type: application/json" \
     -d '{"persona":"gamer","budget":{"min":300,"max":1000},"topN":5}'
```

After the new steps are built:

```bash
# Save profile (Step A)
curl -b jar.txt -X POST http://localhost:8001/api/profile/me/onboard -H "Content-Type: application/json" \
     -d '{"persona":"gamer","budget":{"min":300,"max":1000},"preferences":{"gaming":5,"camera":2,"battery":3,"display":4}}'

# Fire events (Step B)
curl -b jar.txt -X POST http://localhost:8001/api/events -H "Content-Type: application/json" \
     -d '{"eventType":"search","payload":{"q":"ROG"}}'

# Recommendations should now use Fusion (Step C) → Fusion formula (Step D) → Diversity (Step E).
```

---

## 8. Coding conventions in this repo

- **Backend:** ES modules (`.mjs`), Prisma + Postgres, `catchAsync` for controllers, `ApiResponse` / `ApiError` envelopes (`backend/src/utils/`).
- **Frontend:** React 19 functional components, hooks in `frontend/src/hooks/`, all API calls via `frontend/src/services/`.
- **ML:** Python 3.11+, type hints everywhere, no module-global mutable state, `pipeline/serve.py` is the FastAPI surface.
- **Migrations:** never edit a checked-in migration. Always create new ones with `npx prisma migrate dev --name <change>`.
- **Commits:** follow the existing style (`add <thing>`, `fix <thing>`, `cherrypick: <thing>`).

---

## 9. Pitfalls and gotchas (saves hours if you read once)

1. **Don't re-run the notebook to retrain.** Use `pipeline/train.py`. Notebooks are for EDA only.
2. **The scoring snapshot is frozen.** `artifacts/scoring_snapshot.json` holds quantile anchors used by `compute_scores`. Re-run `train.py` if the dataset changes; never recompute quantiles per-request.
3. **Persona keys must match the FE aliases.** The FE sends `gamer`, `camera`, `battery`, `allrounder`, `business`. The Python enum uses `Gamer`, `Camera_Lover`, `Battery_Focused`, `All_Rounder`, `Business_User`. Mapping lives in `PERSONA_ALIASES` in `pipeline/serve.py`.
4. **`phones` table is the source of truth for the frontend.** `backend/src/routes/phoneRoutes.mjs` reads Prisma; the FastAPI sidecar reads `After_EDA_and_Feature_ENginering.csv`. After a model retrain, also re-run `import-gsmarena-bulk.mjs` if specs changed.
5. **Session lifetime is 3 minutes** in `backend/src/index.mjs`. Dev default; bump it for any real demo.
6. **`stratagies/` is a typo for `strategies/`.** Don't rename — three files already import from it.
7. **Fusion ≠ Evolution.** Fusion (Step C) is in-memory per request. Evolution (Step F) writes to DB. Keep them separate or you either react to noise or never react at all.
8. **Normalise before weighting.** The 6 sub-scores live on different natural scales (0–1 already, 0–100 from the ranker, raw cosine). Apply min-max in `fusionRanker.mjs` before the weighted sum.

---

## 10. Where to learn more

- **Architecture & design rationale** — [`Documentation/Smartphone_Hybrid_Recommendation_Architecture.md`](Documentation/Smartphone_Hybrid_Recommendation_Architecture.md)
- **Proposal-aligned project description** — [`Documentation/PROJECT.md`](Documentation/PROJECT.md)
- **Known issues and roadmap** — [`Documentation/FUTURE_WORK.md`](Documentation/FUTURE_WORK.md)
- **ML model metrics** — [`ML Model/artifacts/training_report.json`](ML%20Model/artifacts/training_report.json)
- **API contracts** — `ML Model/pipeline/serve.py` (Python) and `backend/src/routes/recommendRoutes.mjs` (Node)

---

## 11. One-page summary

You have a working hybrid recommender. Everything offline (data, features, XGBoost, scoring, similarity, content joblib) is done. Everything serving (FastAPI, Express, Prisma, React) is done. The database schema for users, phones, profiles is done.

What you need to reach the goal is six small additions — none of which changes your existing code:

1. **Save the user's profile** (1 day) so it persists.
2. **Log interactions** (1–2 days) so the system can learn.
3. **Fuse explicit + behaviour** (½ day) for same-session adaptation — pure function, no DB writes.
4. **Combine 6 sub-scores** (½ day) into one final ranking.
5. **Re-rank for diversity** (½ day) so top-10 isn't 10× the same brand.
6. **Suggest permanent updates** (1 day) when behaviour is consistent — explicit user consent via the UI.

Each step is independent enough to demo. Each step has a concrete verification check. Together they turn your current pipeline into the full hybrid recommender described in the architecture document, without rewriting anything you already have.