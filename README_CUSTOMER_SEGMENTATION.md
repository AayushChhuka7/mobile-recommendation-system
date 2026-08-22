# Customer Segmentation Module — Status & Audit

This README is an audit of your **Smartphone Hybrid Recommendation System**
against the **Ollama Customer Segmentation Prompt** at
`c:\Users\LENOVO\Downloads\ollama_customer_segmentation_prompt.md`.

It answers three questions:

1. **Have you done all 10 parts of the segmentation prompt?**
2. **How does your project compare to the prompt's reference pipeline?**
3. **What would your synthetic dummy data look like (with 5 example rows)?**
4. **What does the project look like after you finish the prompt?**

---

## 1. Status against the 10 parts of the segmentation prompt

The prompt asks for a **Customer Segmentation module** that plugs into your
existing pipeline (which it treats as fixed ground truth). Below is a
part-by-part audit against your current repo.

| # | Part of the prompt | Status in your repo | Evidence / Gap |
|---|---|---|---|
| **1** | Synthetic dataset design (20–40 features, table format) | ❌ Not built | No synthetic user feature schema. You have the phone knowledge base (`Phones`, `PhoneSpecs`, `PhoneVariants`) but no customer-side feature store. |
| **2** | Synthetic data generation rules (6–10 archetypes with % + rules + correlations) | ❌ Not built | No `customer_segments` archetype definitions, no rule-based generator. |
| **3** | Feature engineering for clustering (encoding/normalization decisions) | ❌ Not built | No clustering preprocessing step. |
| **4** | Clustering algorithm comparison (K-Means / DBSCAN / Hierarchical / GMM / Spectral) | ❌ Not built | No clustering algorithm in `ML Model/pipeline/`. |
| **5** | Choosing number of clusters (Elbow / Silhouette / DB / CH) | ❌ Not built | No cluster count validation step. |
| **6** | Segment interpretation (cluster N → name / characteristics / strategy) | ⚠️ Partial | Your existing **Persona presets** (`Gamer`, `Camera_Lover`, `Battery_Focused`, `All_Rounder`, `Business_User`, `Custom`) in `ML Model/pipeline/recommend.py` give a handcrafted analogue, but they are **rules**, not **discovered segments**. |
| **7** | Pipeline integration (where does segmentation sit?) | ⚠️ Partial | Your pipeline already has rule-based filtering → scoring → persona weighting → content similarity → ranking → diversity → explanations. Segmentation would be a new layer that **feeds the personalized weighting** step. Not yet wired. |
| **8** | How segmentation improves each existing component | ❌ Not built | No segment-conditioned weights. Today weights come from `PERSONA_PRESETS` only. |
| **9** | Database design (new tables for segmentation) | ❌ Not built | Schema is missing `customer_segments`, `user_segment_history`, `segment_profiles`, `segment_statistics`. |
| **10** | Ongoing recalculation (batch vs online, cadence, reassignment rules) | ❌ Not built | No scheduler, no reassignment rule. |

### Headline

- **You have NOT yet built any of the 10 parts of the segmentation module.**
- Your project **does** have all the **upstream** pieces the prompt says must
  stay unchanged: the XGBoost AnTuTu predictor (R² ≈ 0.85), the 9-dim
  scoring, persona presets, content similarity joblib, FastAPI sidecar,
  Express+Prisma backend, React frontend.
- Your Prisma schema has `UserProfile`, `UserPreference`, and a partial
  `CustomerProfile` (with `budgetSegment`, `techTier`, `recommendationPersona`,
  `segmentConfidence`, `searchCount`, etc.). That is a **hand-written rule
  tag** (`segmentConfidence: provisional | confirmed`), **not** a clustering
  output. The prompt's segmentation tables are different and must be added.

### What "done so far" looks like for segmentation, ranked

| Component | State | Notes |
|---|---|---|
| Phone feature engineering + XGBoost AnTuTu | ✅ Done | `ML Model/Preprocessing_all_dataset.ipynb` → `artifacts/model.json` |
| Phone knowledge base | ✅ Done | `Phones`, `Brands`, `PhoneVariants`, `PhoneSpecs` in `schema.prisma` |
| 9-dim compatibility scoring | ✅ Done | `ML Model/pipeline/scoring.py` |
| Rule-based persona ranking | ✅ Done | `ML Model/pipeline/recommend.py` (6 personas) |
| Content-based similarity bundle | ✅ Done | `ML Model/similarity_bundle.joblib` |
| FastAPI sidecar | ✅ Done | `ML Model/pipeline/serve.py` (`/recommend`, `/score`, `/explain`, …) |
| Express + Prisma gateway | ✅ Done | `backend/src/index.mjs`, `recommendRoutes.mjs`, `recommendService.mjs` |
| React dashboard | ✅ Done | `frontend/src/components/Dashboard.jsx`, `PhoneListing.jsx` |
| Auth (register / OTP / login) | ✅ Done | `backend/src/routes/authRoutes.mjs` |
| Customer profile persistence (Steps A from README) | ⚠️ Partial | `UserProfile`/`UserPreference` exist, controller/route not yet added |
| Behaviour event log (Step B) | ❌ Not built | `Event`, `BehaviorScore` Prisma models missing |
| Profile Fusion Engine (Step C) | ❌ Not built | No `profileFusion.mjs` yet |
| Final ranking formula (Step D) | ❌ Not built | No `fusionRanker.mjs` yet |
| Diversity re-rank (Step E) | ❌ Not built | No `diversityRerank.mjs` yet |
| Profile Evolution Engine (Step F) | ❌ Not built | No `ProfileSuggestion` table |
| Explainability wiring (Step G) | ⚠️ Partial | FastAPI `/explain` exists; FE doesn't surface bullets yet |
| **Customer Segmentation (THIS PROMPT)** | ❌ **Not built** | All 10 parts of the segmentation prompt are pending |

---

## 2. How your project compares to the reference pipeline in the prompt

The prompt says this pipeline is **already implemented** and must NOT change:

```
Smartphone Dataset → Feature Engineering → XGBoost (predicts missing AnTuTu)
→ Smartphone Knowledge Base → User Login → Cold Start (4 onboarding Qs)
→ Explicit Profile → Behaviour Learning → Behaviour Profile
→ Profile Fusion Engine (in-memory) → Rule-Based Filtering
→ Compatibility Scoring → Personalized Weighting
→ Content-Based Similarity → Final Ranking → Diversity Re-ranking
→ Explainable AI → Top-10 Recommendations
```

### What you actually have, mapped 1-to-1

| Prompt's pipeline stage | Your equivalent | Where it lives | Match? |
|---|---|---|---|
| Smartphone Dataset | ✅ | `dataset/GSMArena_Cleaned_Dataset.csv` | ✅ |
| Feature Engineering | ✅ | `ML Model/Preprocessing_all_dataset.ipynb` → `After_EDA_and_Feature_ENginering.csv` | ✅ |
| XGBoost (predict AnTuTu) | ✅ | `ML Model/artifacts/model.json` (R²=0.85) | ✅ |
| Smartphone Knowledge Base | ✅ | `Phones`, `Brands`, `PhoneVariants`, `PhoneSpecs` in `schema.prisma` | ✅ |
| User Login | ✅ | `authRoutes.mjs` (register / OTP / login / forgot) | ✅ |
| Cold Start (4 onboarding Qs) | ⚠️ Partial | DB columns exist (`UserPreference.maxBudget`, `cameraPreference`, `usageType`, `preferredBrandId`); no controller/route/UI yet | ⚠️ |
| Explicit Profile | ⚠️ Partial | Schema present, no service layer | ⚠️ |
| Behaviour Learning | ❌ | No `Event`/`BehaviorScore` tables | ❌ |
| Behaviour Profile | ❌ | Missing | ❌ |
| Profile Fusion Engine | ❌ | Missing | ❌ |
| Rule-Based Filtering | ✅ | `recommend.py` does persona-based filtering | ✅ |
| Compatibility Scoring | ✅ | `scoring.py` (9-dim) | ✅ |
| Personalized Weighting | ✅ | `PERSONA_PRESETS` in `recommend.py` | ✅ |
| Content-Based Similarity | ✅ | `similarity_bundle.joblib` + `Content_based_recomaendation.ipynb` | ✅ |
| Final Ranking | ⚠️ Partial | FastAPI ranking exists; **fusion of 6 sub-scores** (Step D from README) is not yet built | ⚠️ |
| Diversity Re-ranking | ❌ | Missing | ❌ |
| Explainable AI | ⚠️ Partial | SHAP `/explain` endpoint exists; UI doesn't render bullets | ⚠️ |
| Top-10 → React | ✅ | `PhoneListing.jsx` | ✅ |

### Verdict

Your project is **~60% aligned** with the reference pipeline:

- **Offline ML side (Python):** ~95% done. The hard part — XGBoost, scoring,
  similarity, content joblib — is complete.
- **Online serving (FastAPI + Express + Prisma):** ~75% done. The contract is
  complete; the persistence, fusion, ranking-formula, and diversity layers
  are missing.
- **Behaviour / personalization layer (the prompt's segmentation focus):**
  ~10% done. The schema is the only thing that exists.

You are **NOT behind** on the segmentation prompt because **none of it was
the segmentation prompt's deliverable yet** — your project has been built
sequentially from data → ML → backend → frontend, and segmentation is the
next logical module on top.

---

## 3. What your dummy synthetic data would look like (5 example rows)

The prompt requires a **rule-based synthetic dataset generator** with
internally consistent personas (a Gamer row must have high gaming interest
AND high refresh-rate preference AND flagship chipset preference — not
independently randomized). Below is what the output of that generator would
look like once you build Part 1 + Part 2 of the prompt.

### Feature schema (subset — full schema has 20–40 features)

| Feature | Type | Example | Range | Source |
|---|---|---|---|---|
| `user_id` | string | `syn_u_00042` | unique id | derived |
| `archetype` | categorical | `Hardcore Gamer` | one of 8 archetypes | derived |
| `budget_min` | numeric | `450` | 100–1500 USD | explicit |
| `budget_max` | numeric | `1100` | 100–2000 USD | explicit |
| `preferred_brand` | categorical | `ASUS` | one of ~15 brands | explicit |
| `gaming_interest` | numeric 0–100 | `92` | 0–100 | behaviour |
| `camera_interest` | numeric 0–100 | `35` | 0–100 | behaviour |
| `battery_interest` | numeric 0–100 | `78` | 0–100 | behaviour |
| `display_interest` | numeric 0–100 | `88` | 0–100 | behaviour |
| `performance_interest` | numeric 0–100 | `95` | 0–100 | behaviour |
| `software_interest` | numeric 0–100 | `40` | 0–100 | behaviour |
| `value_interest` | numeric 0–100 | `55` | 0–100 | behaviour |
| `min_ram_gb` | numeric | `12` | 4–16 | explicit |
| `min_storage_gb` | numeric | `256` | 32–1024 | explicit |
| `chipset_tier` | categorical | `Flagship` | Budget / Mid / Flagship | explicit |
| `min_refresh_rate_hz` | numeric | `120` | 60–144 | explicit |
| `min_battery_mah` | numeric | `5000` | 3000–7000 | explicit |
| `search_freq_per_week` | numeric | `18` | 0–50 | behaviour |
| `compare_freq_per_week` | numeric | `9` | 0–25 | behaviour |
| `click_through_rate` | numeric 0–1 | `0.42` | 0–1 | behaviour |
| `avg_session_minutes` | numeric | `14.6` | 1–60 | behaviour |
| `favorite_brand_consistency` | numeric 0–1 | `0.88` | 0–1 | derived |

### 5 example rows (internally consistent personas)

```
| user_id     | archetype             | budget | brand  | gaming | camera | battery | display | perf  | chipset_tier | min_rr | battery_mah | favorite_brand_consistency |
|-------------|-----------------------|--------|--------|--------|--------|---------|---------|-------|--------------|--------|-------------|----------------------------|
| syn_u_00001 | Hardcore Gamer        |  900   | ASUS   |   92   |   35   |   78    |   88    |   95  | Flagship     |  144   |   5500      |            0.88            |
| syn_u_00002 | Mobile Photographer   |  650   | Google |   25   |   96   |   50    |   65    |   55  | Flagship     |   90   |   4500      |            0.91            |
| syn_u_00003 | Budget Buyer          |  180   | Redmi  |   35   |   40   |   70    |   45    |   30  | Budget       |   60   |   5000      |            0.62            |
| syn_u_00004 | Premium Flagship User | 1300   | Apple  |   50   |   80   |   60    |   82    |   90  | Flagship     |  120   |   4500      |            0.95            |
| syn_u_00005 | Battery-Focused User  |  400   | Samsung|   40   |   45   |   95    |   50    |   55  | Mid          |   90   |   6500      |            0.71            |
```

Notice the **correlations inside each row**:

- **Hardcore Gamer** → high gaming (92) + high refresh-rate (144 Hz) +
  Flagship chipset + high battery demand (5500 mAh) + ASUS brand
  (ROG line). All consistent.
- **Mobile Photographer** → high camera (96) + Flagship (for image signal
  processor) + Google brand (Pixel line) + high favorite_brand_consistency
  (0.91). Gaming/disinterest (25) is suppressed.
- **Budget Buyer** → Budget chipset + low budget + Redmi + lower refresh
  rate (60 Hz) + average everything.
- **Premium Flagship User** → Flagship chipset + Apple + high budget
  + high favorite_brand_consistency (0.95).
- **Battery-Focused User** → battery_interest = 95 (the highest column) +
  6500 mAh requirement + Samsung (M-series) + Mid chipset (acceptable
  trade-off for capacity).

The generator would add ±10% Gaussian noise to each interest score so that
clusters aren't perfectly separable — e.g., a Gamer row might have
`gaming=87` instead of `92`, `camera=42` instead of `35`. That's why the
prompt asks for a **clustering step after generation**: the noise is what
clustering has to discover.

### Archetype distribution (Part 2 deliverable, preview)

| Archetype | % of synthetic population |
|---|---|
| Hardcore Gamer | 12% |
| Mobile Photographer | 14% |
| Budget Buyer | 22% |
| Premium Flagship User | 10% |
| Battery-Focused User | 11% |
| Brand-Loyal Customer | 13% |
| All-Round User | 10% |
| Display Enthusiast | 8% |
| **Total** | **100%** |

You would generate **~5,000–10,000 synthetic users** (the prompt says "no
real historical data" — synthetic size should be large enough that
k=4–12 clustering has statistical power). 8,000 is a reasonable default
(80/20 train-test split for the clustering model).

---

## 4. What the project looks like AFTER finishing the prompt

Below is what your repo would look like once all 10 parts of the prompt are
implemented.

### New ML files (Python)

```
ML Model/
├── segmentation/                        ← NEW MODULE
│   ├── __init__.py
│   ├── archetypes.py                    ← Part 2: 8 archetypes with rules + distributions
│   ├── synthetic_generator.py           ← Part 1+2: feature schema + rule-based data gen
│   ├── preprocessing.py                 ← Part 3: encoding / normalization decisions
│   ├── cluster_comparison.py            ← Part 4: K-Means vs DBSCAN vs GMM vs …
│   ├── choose_k.py                      ← Part 5: Elbow / Silhouette / DB / CH
│   ├── train_segmenter.py               ← Part 6: fit K-Means (or chosen algo), save centroids
│   ├── predict_segment.py               ← Part 6: assign segment to a new user
│   ├── segment_profiles.py              ← Part 6: turn centroids into named profiles
│   └── recalc.py                        ← Part 10: batch recalculation job
├── artifacts/
│   ├── segmenter.joblib                 ← NEW: trained clustering model + centroids
│   ├── segment_profiles.json            ← NEW: cluster N → name + recommendation strategy
│   └── synthetic_users.csv              ← NEW: ~8,000 synthetic rows
├── pipeline/
│   └── serve.py                         ← MODIFIED: add /segment, /segment/<user_id> endpoints
```

### New schema additions (Prisma)

```prisma
// NEW MODELS — added to backend/prisma/schema.prisma

model CustomerSegment {
  segmentId     Int      @id @default(autoincrement()) @map("segment_id")
  segmentName   String   @unique @map("segment_name") @db.VarChar(60)
  description   String?  @map("description") @db.Text
  // centroid stats as JSON (mean values of each cluster feature)
  centroidJson  Json     @map("centroid_json")
  // recommendation strategy weights (Part 8)
  weightsJson   Json     @map("weights_json")
  // segment size & last training metadata
  populationSize Int     @default(0) @map("population_size")
  trainedAt     DateTime @default(now()) @map("trained_at")
  isActive      Boolean  @default(true) @map("is_active")

  users UserSegmentHistory[]

  @@map("customer_segments")
}

model UserSegmentHistory {
  id           String   @id @default(uuid()) @map("id") @db.Uuid
  userId       String   @map("user_id") @db.Uuid
  segmentId    Int      @map("segment_id")
  assignedAt   DateTime @default(now()) @map("assigned_at")
  confidence   Float    @map("confidence")        // distance to centroid, normalised
  // snapshot of the user's feature vector that triggered this assignment
  featureSnapshot Json? @map("feature_snapshot")
  // keep history rows so we can see segment drift over time
  supersededBy String?  @map("superseded_by") @db.Uuid
  isCurrent    Boolean  @default(true) @map("is_current")

  user    Users           @relation(fields: [userId], references: [userId], onDelete: Cascade)
  segment CustomerSegment @relation(fields: [segmentId], references: [segmentId])

  @@index([userId, isCurrent])
  @@index([segmentId])
  @@map("user_segment_history")
}

model SegmentProfile {
  // segment-level smartphone preferences — derived from synthetic data centroids
  profileId    String   @id @default(uuid()) @map("profile_id") @db.Uuid
  segmentId    Int      @map("segment_id")
  preferredChipsetTier String? @map("preferred_chipset_tier") @db.VarChar(30)
  preferredBrand       String? @map("preferred_brand") @db.VarChar(60)
  avgBudget            Decimal? @map("avg_budget") @db.Decimal(10, 2)
  avgMinRamGb          Int?     @map("avg_min_ram_gb")
  avgMinBatteryMah     Int?     @map("avg_min_battery_mah")
  avgMinRefreshRateHz  Int?     @map("avg_min_refresh_rate_hz")
  // top-3 sub-score weights this segment cares about most
  topSubScoresJson     Json     @map("top_sub_scores_json")

  segment CustomerSegment @relation(fields: [segmentId], references: [segmentId])

  @@index([segmentId])
  @@map("segment_profiles")
}

model SegmentStatistics {
  statId       String   @id @default(uuid()) @map("stat_id") @db.Uuid
  segmentId    Int      @map("segment_id")
  computedAt   DateTime @default(now()) @map("computed_at")
  activeUserCount Int   @map("active_user_count")
  // segment performance: how often its users click recommendations
  avgClickThroughRate Float? @map("avg_click_through_rate")
  avgConversionRate   Float? @map("avg_conversion_rate")
  avgSessionMinutes   Float? @map("avg_session_minutes")

  segment CustomerSegment @relation(fields: [segmentId], references: [segmentId])

  @@index([segmentId, computedAt(sort: Desc)])
  @@map("segment_statistics")
}
```

These tables **do not duplicate** your existing `users`, `phones`,
`explicit_profiles`, `implicit_profiles`, `events`, `behavior_scores`,
`profile_suggestions`, `recommendation_logs` tables — they sit beside them
and reference `users` and `customer_segments` by FK.

### New backend files (Node)

```
backend/src/
├── routes/
│   ├── segmentRoutes.mjs              ← NEW: GET /me, GET /:userId, GET /all
│   └── adminSegmentRoutes.mjs         ← NEW: POST /retrain, GET /stats
├── services/
│   ├── segmentationService.mjs        ← NEW: call ML /segment endpoint
│   └── segmentWeightService.mjs       ← NEW: merge segment weights into fusion
└── controller/
    ├── segmentController.mjs          ← NEW
    └── adminSegmentController.mjs     ← NEW
```

### New ML pipeline output to FastAPI

The `ML Model/pipeline/serve.py` would gain:

```
POST /segment              body: {user_features}            → {segmentId, segmentName, confidence, weights}
POST /segment/batch        body: {users: [...]}             → [{userId, segmentId, …}, …]
GET  /segments             (list all segments + centroids) → [{segmentId, name, description}, …]
POST /segment/retrain      (admin only — recompute)        → {trainedAt, silhouette, segments: […]}
```

### Updated pipeline diagram (where segmentation sits)

```
                OFFLINE (Python, ✅ done)
                ─────────────────────────────
Smartphone Dataset → Feature Engineering → XGBoost → Smartphone Knowledge Base

                OFFLINE (Python, 🆕 from segmentation prompt)
                ─────────────────────────────
Synthetic Archetype Generator → ~8,000 Synthetic Users
   → Feature Engineering (encoding/normalization) → Cluster Algorithm
   → Segment Profiles (centroid → name + strategy) → customer_segments table

══════════════════════════════════════════
                ONLINE (per request)
                ─────────────────────────
Rule-Based Filtering → Compatibility Scoring
   → Segmentation Lookup        ← 🆕 NEW STEP (Part 7)
                                   loads the user's current segmentId,
                                   fetches that segment's centroid weights
                                   and blends them into personalized weighting
   → Personalized Weighting     ← MODIFIED: now = β·explicit + γ·segment + (1-β-γ)·behaviour
   → Content-Based Similarity
   → Final Ranking Formula
   → Diversity Re-ranking
   → Explainable AI (segment-aware explanations)
   → Top-10 Recommendations

                OFFLINE (Python, 🆕 batch)
                ─────────────────────────────
Segment Recalculation Job (Part 10)
   runs nightly, reassigns users whose Behaviour Profile drifted > threshold
   keeps history rows in user_segment_history for drift analysis
```

### UI changes (React)

In `frontend/src/components/Dashboard.jsx` and `PhoneListing.jsx`:

- After login, if the user has no segment yet, fire `POST /segment` with
  their explicit + behaviour features → assign a segment.
- Show a small badge on each phone card:
  > "Recommended because you match the *Hardcore Gamer* segment
  > (12% of users, prefers 144 Hz + Flagship chipset)."
- Admin page (`/admin/segments`) shows segment population size, centroid
  weights, and a "Retrain now" button.

---

## 5. Effort and ordering

| Step | Description | Effort | Files touched |
|---|---|---|---|
| **S1** | Synthetic data generator (Parts 1+2) | 1 day | `segmentation/synthetic_generator.py`, `segmentation/archetypes.py` |
| **S2** | Feature engineering for clustering (Part 3) | ½ day | `segmentation/preprocessing.py` |
| **S3** | Cluster algorithm comparison + choose k (Parts 4+5) | 1 day | `segmentation/cluster_comparison.py`, `segmentation/choose_k.py` |
| **S4** | Train segmenter + segment interpretation (Part 6) | 1 day | `segmentation/train_segmenter.py`, `segmentation/segment_profiles.py` |
| **S5** | Prisma migration for new tables (Part 9) | ½ day | `backend/prisma/schema.prisma`, new migration |
| **S6** | FastAPI `/segment` endpoints | ½ day | `ML Model/pipeline/serve.py` |
| **S7** | Express routes + service + controller | 1 day | `backend/src/routes/segmentRoutes.mjs`, etc. |
| **S8** | Wire segmentation into `recommendService.mjs` (Part 7+8) | 1 day | `backend/src/services/recommendService.mjs` |
| **S9** | Batch recalc job + drift threshold (Part 10) | 1 day | `segmentation/recalc.py` |
| **S10** | Frontend badge + admin page | ½ day | `Dashboard.jsx`, new `AdminSegments.jsx` |
| **Total** | | **~7 days** | |

Total new code: ~1,500–2,000 lines of Python + ~600 lines of Node + a small
React component. **No existing files are rewritten** — only additive.

---

## 6. Where this README lives

This file: **`README_CUSTOMER_SEGMENTATION.md`** at the project root.

Existing files unchanged:

- `README.md` — overall project guide
- `Documentation/PROJECT.md` — proposal-aligned description
- `Documentation/Smartphone_Hybrid_Recommendation_Architecture.md` — design doc

## 7. Summary

- **You have built 0 of 10 parts** of the segmentation prompt, because the
  segmentation module is genuinely new work — not an extension of anything
  missing.
- **You have built ~60–75%** of the upstream pipeline the prompt treats as
  fixed ground truth. The Python offline ML side is essentially complete;
  the Node/Prisma online behaviour/personalization side is the gap.
- **Your synthetic data would look exactly like the 5 example rows above** —
  internally consistent personas (Gamer = high gaming + 144 Hz + Flagship +
  big battery), with ~10% Gaussian noise per feature so clustering has
  something to discover.
- **After finishing the prompt**, your project gains ~7 days of additive
  work: 4 new Prisma tables, a new `ML Model/segmentation/` module, a
  `/segment` endpoint on FastAPI, an Express `/segment` route, a small
  frontend badge, and a nightly recalculation job. The existing
  FastAPI/Express/Prisma/React layers stay exactly as they are.