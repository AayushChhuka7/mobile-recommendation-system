# Project Flow — Step A → Step D (worked example)

> Companion to [`README_all_recomendaion_explanation.md`](README_all_recomendaion_explanation.md).
> That file explains the **architecture**. This file traces a single user's
> session through every layer the implementation has built so far, so
> you can read it once and have the whole pipeline in your head.

## Who this is for

If you want to understand **what was built, in what order, and why each
piece exists**, read this end-to-end. The example is fictional but every
DB column, table, endpoint and weight referenced below is real.

## The user in our example

Let's call her **Sita**. She signs up, picks the *Camera Lover* persona,
sets a budget of €900, then spends ten minutes browsing the listing —
she searches for "ROG", opens two Galaxy S25 Ultra details, and
compares it with an iPhone 17 Pro. Then she clicks "Recommend me a
phone" again.

Below is every line the system writes or reads in response, in
chronological order.

---

## Step A — Explicit preferences (one-shot)

**Where:** `frontend/src/components/Dashboard.jsx` → `POST /api/profile/preferences`
**Backend:** `backend/src/controller/profileController.mjs` →
`backend/src/services/profileService.mjs::saveExplicitPreferences`
**Tables touched:** `user_preferences`, `customer_profile`

When Sita submits the questionnaire modal, the FE sends:

```jsonc
{
  "persona": "camera",
  "weights": { "camera": 5, "gaming": 1, "battery": 3, "display": 4 },
  "budgetMin": 400,
  "budgetMax": 900
}
```

The BE normalises this into one row in `user_preferences` and bumps
`customer_profile.budget_segment = "Premium Buyer"`. This row never
changes unless Sita submits the questionnaire again.

**Why we have this:** every later ranking needs an "anchor" — what
would you have asked for if you didn't behave at all. Step A is that
anchor. Without it, behaviour alone would have to invent a persona.

---

## Step B — Behaviour events

**Where:** everything that touches the listing or detail page.
**Backend:** `backend/src/services/behaviorAnalyzer.mjs::recordEvent`
**Tables touched:** `events`, `behavior_scores` (plus legacy
`search_history` / `browsing_history` for back-compat).

Ten minutes of browsing produces these events:

| # | event_type | payload                                    |
|---|------------|--------------------------------------------|
| 1 | search     | `{ q: "ROG" }`                              |
| 2 | view       | `{ phoneLabel: "Galaxy S25 Ultra", brandName: "Samsung" }` |
| 3 | view       | `{ phoneLabel: "Galaxy S25 Ultra", brandName: "Samsung" }` |
| 4 | compare    | `{ modelNameA: "Galaxy S25 Ultra", modelNameB: "iPhone 17 Pro" }` |

The analyzer applies per-event-tag deltas, then exponentially decays
each `behavior_scores` row. After the session:

```
behavior_scores (userId = sita, tag = "camera",     score =  4.21)
behavior_scores (userId = sita, tag = "gaming",     score =  1.05)
behavior_scores (userId = sita, tag = "battery",    score =  0.40)
behavior_scores (userId = sita, tag = "brand:Samsung", score =  2.30)
behavior_scores (userId = sita, tag = "tier:flagship", score =  1.80)
```

Note that **brand and tier tags also leak in**. That's the same-session
nudge Step C and Step D will read.

**Why we have this:** explicit preferences are sparse — the user only
touches the questionnaire when they choose to. Behaviour is dense.
A model that ignores the last 10 minutes of what a user *actually
looked at* is going to recommend yesterday's intent.

---

## Step C — Profile Fusion (instant, same request)

**Where:** `backend/src/services/profileFusion.mjs::buildFusedWeights`
**Trigger:** every call to `POST /api/recommend/recommend` if the user
is logged in.
**Tables touched:** read-only — `user_preferences`, `behavior_scores`.

When Sita clicks *Recommend Me*, the BE first builds a fused weight
map for FastAPI's `preferences` field:

```
explicit (from Step A):     { camera: 5, gaming: 1, battery: 3, display: 4 }
behavioral (from Step B):  { camera: 4.21, gaming: 1.05, battery: 0.40 }
                       ──→ fused: { camera: 4.84, gaming: 0.91, battery: 2.45, display: 4 }
                          (β = 0.7 weight on behaviour)
```

The BE then overrides the persona to `"Custom"` so FastAPI honours the
fused weights instead of the `Camera_Lover` preset. Step C's output
is **not persisted** — it lives only for the lifetime of this request.

**Why we have this:** FastAPI's ranker wants a per-dim weight map.
Behaviour alone is too noisy (one "ROG" search shouldn't make Sita a
gamer); explicit alone is too stale. The 70/30 blend reflects the
recent intent without letting it hijack the persona.

---

## Step D — Final ranking (5-signal fusion)

**Where:** `backend/src/services/recommendService.mjs::getRecommendations`
**Companions:** `fusionRanker.mjs`, `similarityClient.mjs`, new
FastAPI endpoint `POST /similarity/score`.
**Tables touched:** read `behavior_scores` again (raw, not the
4-dim bucket from Step C); write `recommendation_logs` (one row per
served candidate).

FastAPI now returns six phones in budget, each with three sub-scores:

| Phone             | Match_Score | Overall_Score | Value_Score |
|-------------------|------------:|--------------:|------------:|
| Galaxy S25 Ultra  |        87.4 |          91.2 |        78.5 |
| Pixel 9 Pro XL    |        84.1 |          86.0 |        82.1 |
| iPhone 17 Pro     |        81.9 |          88.4 |        71.0 |
| OnePlus 13 Pro    |        78.5 |          80.2 |        84.0 |
| Xiaomi 14 Ultra   |        75.0 |          79.5 |        85.7 |
| Honor Magic 7 Pro |        71.8 |          75.3 |        83.6 |

Then the BE runs **four more sub-scores per candidate** and combines
them via the canonical 5-signal fusion in `fusionRanker.mjs`:

| signal              | weight | source                                              | range    |
|---------------------|-------:|-----------------------------------------------------|----------|
| compatibility       | 0.4211 | FastAPI `Overall_Score` / 100                        | 0..1     |
| customer_preference | 0.2105 | FastAPI `Match_Score` / 100                          | 0..1     |
| content_similarity  | 0.1579 | new `/similarity/score` (cosine to centroid)         | 0..1     |
| search_history      | 0.1053 | `searchHistoryScore(phone.tags, behaviourMap)`        | 0..1     |
| value               | 0.1053 | FastAPI `Value_Score` / 100                           | 0..1     |
| **sum**             | **1.0**|                                                     |          |

The 6th slot (`popularity`, 0.05) is **deliberately empty**. It is
reserved for a future customer-segmentation cluster: when a clustering
model is in place, phones that get a lot of impressions inside Sita's
cluster will earn a small "social proof" boost without disturbing the
relative ordering of the other five signals.

The BE does this in three steps:

1. **`fetchContentSimilarity(candidates)`** — POSTs the candidate set
   to FastAPI's new `/similarity/score` endpoint, which lazy-loads
   `similarity_bundle.joblib` on first hit. Each candidate's score is
   its cosine similarity to the **mean vector** of all candidates.
   If the bundle is missing, every candidate gets 0; the other four
   signals still rank.
2. **`loadBehaviorScoreMap(userId)`** — reads the raw
   `behavior_scores` rows as `Map<tag, score>`. Not the 4-dim bucket
   from Step C — that one was lossy.
3. **`fusionRank(candidates, behaviourMap)`** — pure function; folds
   the 5 sub-scores through `FUSION_WEIGHTS`, sorts desc, attaches
   `finalScore` and `components` to each row.

For Sita's set, the components come out roughly like:

| Phone             | compatibility | customer_pref | content_sim | search_hist | value | finalScore |
|-------------------|--------------:|--------------:|------------:|------------:|------:|-----------:|
| Galaxy S25 Ultra  |         0.912 |         0.874 |       0.812 |       0.713 | 0.785 |     **0.840** |
| Pixel 9 Pro XL    |         0.860 |         0.841 |       0.792 |       0.502 | 0.821 |     **0.795** |
| iPhone 17 Pro     |         0.884 |         0.819 |       0.751 |       0.554 | 0.710 |     **0.781** |
| OnePlus 13 Pro    |         0.802 |         0.785 |       0.806 |       0.405 | 0.840 |     **0.756** |
| Xiaomi 14 Ultra   |         0.795 |         0.750 |       0.778 |       0.420 | 0.857 |     **0.745** |
| Honor Magic 7 Pro |         0.753 |         0.718 |       0.730 |       0.480 | 0.836 |     **0.717** |

Notice the **Galaxy jumps from rank-1 to a clearer rank-1** — the
search_history sub-score (Samsung + flagship both strongly positive)
adds 0.1053 × 0.713 ≈ 0.075 to its finalScore, which is enough to
widen the gap against the iPhone that ranked 3rd. The `Why` list
("Camera strong", "Software strong") still comes from the FastAPI
output; the new badge "Boosted by your activity" appears on the
Galaxy card because `search_history > 0.6`.

The BE then writes **one `recommendation_logs` row per candidate**
(rank + finalScore + phoneId) for future segmentation clustering.
The writes are fire-and-forget — they never block the response.

---

## What every step is responsible for (one-line summary)

| Step | Job | Tables it owns | Endpoints |
|------|-----|----------------|-----------|
| A    | Persist the one-shot questionnaire answer            | `user_preferences`, `customer_profile` | `POST /api/profile/preferences` |
| B    | Log every interaction; roll up per-tag scores         | `events`, `behavior_scores` (+ legacy) | `POST /api/events` |
| C    | Fuse Step A + Step B into a per-dim weight map        | (read-only)                            | (called inside `/recommend/recommend`) |
| D    | Fuse 5 signals into a finalScore; write impression log | `recommendation_logs` (read behaviour) | (called inside `/recommend/recommend`) |

Each step is layered on top of the previous one — none of them replace
what came before. The compatibility / customer_preference / value
signals are still coming out of the same FastAPI `recommend.py` they
came from before Step D; only the **ranking** changed.

---

## Reading the result in the FE

* The `% match` badge (`Math.round(matchScore * 100)`) now shows the
  fused finalScore rather than the raw FastAPI `Match_Score`. Ranking
  order can shift slightly because Step D is no longer purely
  descending on `Match_Score`.
* A new pill badge **"Boosted by your activity"** appears on cards
  whose `matchComponents.search_history > 0.6`. This is the FE's
  visual hint that a phone ranks well partly because of Sita's recent
  browsing, not because of its intrinsic specs.

---

## What's NOT in Step D (yet)

* **Popularity / segmentation** — the 0.05 weight is reserved but
  unused. A future clustering step will train on `recommendation_logs`
  + click data and plug `popularity = clusterLift(user, phone)`
  in.
* **Diversity re-ranking** — top-N can be all-Samsung if Samsung
  happens to score best. MMR-style diversity is a separate plan.
* **Sub-fusion across the 9 dims** — Step D collapses each candidate
  to 5 sub-scores; the per-dim `SubScores` block FastAPI now ships
  is preserved on the BE for a future richer sub-fusion.
* **Profile evolution** — Step F (writing fused weights back to
  `user_preferences` over time) is separate.

---

## Auto-recommend on login (Dashboard mount)

### What was the situation before

The recommendation flow used to require a click:

> User logs in → Dashboard opens → user clicks *Recommend Me* → BE
> calls `/recommend` → ML returns picks → FE renders.

The persona + budget + weight knobs lived in the *Recommend Me* modal,
and the user had to open it, fill it in, and click the button before
they saw anything personalised. The listing page loaded normally, but
the recommendations panel above it stayed empty until the user
interacted.

### What changed

Recommendations now load **automatically** as soon as the Dashboard
mounts. The same fusion pipeline (Steps A → D) runs under the hood;
the only difference is that the persona + budget come from the
user's stored profile instead of from a form they just submitted.

```
User logs in
   │
   ▼
Dashboard mounts
   │
   ▼
useEffect → GET /api/recommend/auto       (only if recs panel empty)
   │
   ▼
recommendService.getAutoRecommendations(userId)
   │   ─ reads CustomerProfile.recommendationPersona
   │   ─ reads UserPreference.maxBudget
   │   ─ defaults: persona="allrounder", budget.max=1500
   ▼
getRecommendations({ persona, budget, topN: 6 }, userId)
   │   ─ exact same code path as the click button
   │   ─ profileFusion (Step C) + fusionRanker (Step D)
   ▼
setRecs(results)
   │
   ▼
Existing recs panel renders identically to a click-triggered set.
```

The *Recommend Me* button still works. It opens the modal, lets the
user override persona / budget / weights, and posts to the existing
`POST /api/recommend/recommend` route. Auto-recommend only fires on
mount and only when the recs panel is empty.

### Files changed and why

| File | Change | Why |
|------|--------|-----|
| `backend/src/services/recommendService.mjs` | Added `getAutoRecommendations(userId)` | Reuses `getRecommendations` end-to-end so ML / similarity / fusion paths stay single-source-of-truth. Reads persona + budget from `getProfileBundle(userId)` and delegates. Logs failures instead of throwing — auto-recommend is best-effort, never blocks the listing. |
| `backend/src/controller/recommendController.mjs` | Added `getAutoRecommend` handler | Thin wrapper: auth check → call service → log into `RecommendationHistory` (persona="auto" tag) → return `{results, defaultedAt}`. Same `sendSuccess` envelope as `postRecommend`. |
| `backend/src/routes/recommendRoutes.mjs` | Added `GET /auto` route | Mounts the new handler. `POST /recommend` and `POST /compare-ml` are untouched. |
| `frontend/src/services/recommend.js` | Added `getAutoRecommendations()` | Thin `api.get("/recommend/auto")` wrapper. Returns `{results, defaultedAt}` with safe defaults so the FE never reads `undefined`. |
| `frontend/src/components/Dashboard.jsx` | New `useEffect` block on mount | Auto-fetches once when `user?.userId` is set and `recs === null`. Reuses existing `recs/recsLoading/recsError` state — the existing "Finding phones for you…" spinner and error UI work for auto-recommend with zero duplication. |

### Files NOT changed

| File | Why |
|------|-----|
| `backend/src/services/profileFusion.mjs` | Auto-recommend already goes through it via `getRecommendations`. |
| `backend/src/services/fusionRanker.mjs` | Same. |
| `backend/src/services/similarityClient.mjs` | Same. |
| `ML Model/pipeline/recommend.py` | FastAPI contract unchanged. |
| `ML Model/pipeline/serve.py` | `/similarity/score` and `/recommend` unchanged. |
| `similarity_bundle.joblib` | Not touched. |
| Frontend *Recommend Me* button + modal | Still wired to `POST /recommend`. |

### Cold-start behaviour

A user who has never filled the questionnaire has no
`recommendationPersona` and no `maxBudget`. The service defaults:

| Field | Default | Flag in response |
|-------|---------|------------------|
| persona | `"allrounder"` | `defaultedAt.persona = true` |
| budget.max | `1500` (covers the full catalog) | `defaultedAt.budget = true` |

The FE renders the picks normally — the defaulted flags are available
for future UX (e.g. a "Cold-start picks" badge) but are not required.

### Failure modes

| Failure | Behaviour |
|---------|-----------|
| BE can't load `similarity_bundle.joblib` | `contentSim = 0` for every candidate; the other 4 signals still rank. Existing Step D degradation policy — unchanged. |
| FastAPI `/recommend` returns 503 | `getRecommendations` throws → `getAutoRecommendations` logs + returns `{results: [], defaultedAt}`. The recs panel renders the existing "No matches" state. |
| User has zero behaviour + zero explicit prefs | Defaulted picks, low finalScore variance. The user sees something, can still click *Recommend Me* to override. |
| `userId` missing in JWT | Guard at the controller returns `{results: [], defaultedAt: {false, false}}` with `sendSuccess`. The Dashboard effect never reaches this path because the route is auth-guarded. |
| Auto-recommend returns an empty array | Existing "No matches for the chosen persona and budget" UI renders. User clicks *Recommend Me* to retry. |

### Why this is minimal-risk

* No new ML endpoints. FastAPI and `similarity_bundle.joblib` are
  untouched.
* No new recommendation route. `POST /recommend` is still the source
  of truth for the click flow.
* No new state on the FE. The auto-fetch reuses `recs`,
  `recsLoading`, `recsError`, and the entire existing render block.
* No new auth surface. `GET /auto` rides on the existing
  `isAuthenticate` middleware via `recommendRoutes` →
  `router.use("/recommend", recommendRoutes)` in `main.mjs`.
* The persona + budget defaults match Dashboard's existing defaults
  (`selectedCategory="gamer"` is overridden to `"allrounder"` here
  because that's the catalogue-wide default that doesn't bias toward
  any one segment when no preferences exist).
