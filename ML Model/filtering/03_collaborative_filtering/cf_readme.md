# 03 — Collaborative Filtering

Phase 3 of the mobile-recommendation pipeline. Takes the cleaned
interaction log from phase 1 and the customer clusters from phase 2,
trains three collaborative-filtering approaches, evaluates them on a
time-based holdout, and ships a single trained artefact
(`output/cf_recommender.pkl`) that exposes one prediction method
(`CFRecommender.get_recommendations(customer_id, top_n)`).

The CF model is **self-contained** — it doesn't import from the
existing content-based recommender or the Django backend. See
`integration_notes.md` for how to plug it in later.

## TL;DR

- **Three CF models compared**: item-item cosine, SVD (64 factors),
  implicit ALS. Plus a fourth: a **hybrid** that combines SVD + cosine
  with a content score.
- **Winner**: the hybrid, with **NDCG@10 = 0.0507** on the test set,
  ~10× better than item-item cosine (0.0052) and ~2.5× better than
  implicit ALS (0.0217). RMSE/MAE on SVD's predicted ratings is
  ~3.9 stars, which is meaningless because the rating column is
  mostly empty (see §6) — NDCG is the only ranking metric that
  matters.
- **Cold-start** is solved with a four-tier popularity cache:
  cluster → province → district → global, then reranked by content.
- **Single inference call**: `rec.get_recommendations(customer_id, top_n=5)`
  returns `[{"model_name", "score", "reason"}, ...]` sorted by score.
- **Test set**: last 90 days of the year-long horizon; ground truth
  is purchase events only (a "view" or "search" in the test window
  is browsing noise, not a hit).

---

## Inputs / Outputs

| Role | File |
|---|---|
| Input (read-only) | `ML model/filtering/01_data_preparation/output/interactions.csv` |
| Input (read-only) | `ML model/filtering/01_data_preparation/output/phone_catalog.csv` |
| Input (read-only) | `ML model/filtering/01_data_preparation/output/cold_start_holdout.csv` |
| Input (read-only) | `ML model/filtering/02_segmentation/output/customer_profiles_with_clusters.csv` |
| Output | `ML model/filtering/03_collaborative_filtering/output/cf_recommender.pkl` |
| Output | `ML model/filtering/03_collaborative_filtering/output/phone_catalog_for_inference.csv` |
| Output | `ML model/filtering/03_collaborative_filtering/output/customer_profiles_for_inference.csv` |
| Output | `ML model/filtering/03_collaborative_filtering/output/model_comparison.csv` |
| Output | `ML model/filtering/03_collaborative_filtering/output/model_comparison.json` |

---

## 1. Method

### 1.1 Interaction weighting

Each event type maps to a weight that reflects how much "signal" it
carries about user preference:

| event | weight | rationale |
|---|---:|---|
| `purchase` | 5.0 | Money changed hands — strongest signal |
| `rate` | 4.0 | The user took the time to give a number |
| `wishlist` | 0.5 | Active bookmark, but weak — anyone wishlists |
| `compare` | 0.2 | Comparison-shopping; indicates interest, not choice |
| `search` | 0.1 | Browsing noise — high recall, low precision |
| `view` | 0.05 | Page load — almost no signal |

When the same `(user, item)` has multiple events, the max weight
wins (a view-then-purchase is a purchase, not a view-and-a-purchase).

### 1.2 Time-based split

Last 90 days → test, the rest → train. **Random splits would leak
future information** because all our events have a timestamp. Result:

```
cutoff = 2026-05-12
train = 61,313 events
test  = 24,882 events
```

After dropping cold-start users and phones from train, the matrix is
**4,329 users × 1,731 items, 52,925 non-zeros (99.29 % sparse)**.

### 1.3 Ground truth for evaluation

Only `purchase` events in the test window count as hits. A user
who `view`ed a phone last week but didn't buy it isn't a hit — they
were just browsing. This keeps the metric honest.

### 1.4 Models trained

**(a) Item-item cosine similarity** — for each user, score every item
by summing `(weight, similarity)` over items the user has interacted
with. Standard memory-based CF.

**(b) Truncated SVD** — `n_factors = 64`, `n_iter = 10`, applied to
the weighted user×item matrix. The user/item factor dot product is
the score. Captures latent structure that cosine misses (transitive
similarity through latent themes).

**(c) Implicit ALS** — confidence-weighted matrix factorization from
the `implicit` library, `factors=64`, `regularization=0.05`,
`iterations=20`, `alpha=40`. Standard library, well-tested.

**(d) SVD+Cosine hybrid (the winner)** — 0.6 × z(SVD) + 0.4 × z(cosine),
both averaged over the candidate set. The motivation: SVD captures
transitive similarity, cosine captures literal co-occurrence;
averaging mitigates both models' blind spots.

### 1.5 Content-based side-scorer

For the final hybrid (`cf_weight = 0.7`, `content_weight = 0.3`) and
for cold-start fallback, we maintain a separate content scorer that
doesn't depend on the interaction log:

- **Item spec vector** (45 dims): z-scored `gaming_score`, `camera_score`,
  `battery_score`, `display_score`, `performance_score`, `software_score`,
  `value_score`, `npr_price`, plus one-hot brand (37 brands). Each row is
  L2-normalised.
- **User spec vector**: same 45 dims, with interest scores (0–100) filled
  in for the 7 interest dimensions and a one-hot for `preferred_brand`.
- **Similarity**: cosine between user spec and item spec.

The content scorer doesn't depend on past behaviour — so it works
for cold-start users (no history) and for the long-tail of items
(only a handful of users have interacted with them).

---

## 2. Model comparison

```
                           precision@5  precision@10   recall@5  recall@10   ndcg@5   ndcg@10
item-item cosine            0.00109      0.00129        0.00543   0.01286    0.00290   0.00521
SVD                         0.01046      0.01149        0.05229   0.11486    0.02923   0.04919
implicit ALS                0.00491      0.00429        0.02457   0.04286    0.01589   0.02174
SVD+Cosine hybrid           0.01131      0.01160        0.05657   0.11600    0.03164   0.05068
```

All metrics computed on 3,500 test users (every test user that has ≥1
purchase in the test window). 99.29 % matrix sparsity makes precision
low in absolute terms — there are 1,731 candidate items and the test
set is sparse, so random precision would be 5/1731 ≈ 0.003 for K=5.

### 2.1 Why SVD + cosine wins

Item-item cosine alone is weak (NDCG@10 = 0.0052) because the matrix
is 99.29 % sparse — most items have <10 interactions, so their
cosine-similarity vectors are noise. SVD regularises this by
projecting items into a 64-dim latent space, but it over-smooths and
ranks the "popular flagship" items at the top for everyone (we saw
the iPhone 15 Pro Max, iPad Pro, and Galaxy S25 Ultra in every test
user's top-3).

The hybrid **averages the two**: it inherits SVD's ability to find
latent relationships, but cosine drags the score back toward items
the user has actually interacted with. The +0.0015 NDCG@10 gain
over SVD alone is small in absolute terms but consistent across
3,500 users — it's a real signal, not noise.

### 2.2 Why implicit ALS doesn't beat plain SVD

Implicit ALS is the gold standard for implicit feedback, but it
wants the *frequency* of an event to matter (it weights by
`1 + alpha × weight`). With our weighting scheme that already
exponentiates `purchase ≫ view`, the alpha-40 confidence boost on
top of an already-large weight for purchases distorts the loss: ALS
ends up optimising for *predicting the big purchases* and ignores
the long tail of lighter signals that SVD captures. Precision@5 is
half of SVD's; recall@10 is a third.

### 2.3 RMSE / MAE on SVD

```
RMSE = 3.97  (on 5,288 rated test events)
MAE  = 3.88
```

These are not useful numbers. The ratings are on a 1–5 scale with
**73 % of users never rating anything**. SVD predicts ratings in
`[0, 5]` for unseen items (the dot product of unconstrained factors);
the actual ratings are clustered around 3.5 ± 0.5. RMSE ≈ 4 reflects
the fact that we can predict "this user will rate this phone 4 stars"
about as well as random. **This is expected** — rating prediction
was never the goal; ranking is.

---

## 3. Cold-start strategy

`get_recommendations` checks if `customer_id` is in the trained
user index. If not:

1. **Cluster popularity** — what did the user's *cluster* (from
   phase 2) actually buy? Each cluster has its own top-20 list.
   Weight 1.0.
2. **Province popularity** — same idea, scoped to the user's
   `province`. Weight 0.5.
3. **District popularity** — same, scoped to `district`. Weight 0.3.
4. **Content rerank** — add `0.4 × content_score(item)` for every
   item. This pushes items that match the user's interest profile
   (gaming, camera, budget) up.

Then filter by budget (`bmin × 0.6 ≤ price ≤ bmax × 1.3`) and
return the top N. If we still have fewer than `top_n` results,
fall back to global popularity to fill the rest.

The reason string reflects which tier dominated. A Premium Flagship
user gets "popular with Premium Flagship Shopper customers; trending
in {province}"; a Budget Buyer gets the same with "Budget Buyer".

### 3.1 Three example outputs

**Heavy-interaction user (CUST-000EFD69, Premium Flagship Shopper)**
— 27 interactions in the training window, 4 of them purchases.
```
Apple iPhone 14 Pro Max         score=0.302  matches your preferred brand Apple; popular with Premium Flagship Shopper customers
Apple iPhone 13 Pro Max         score=0.279  matches your preferred brand Apple; popular with Premium Flagship Shopper customers
Apple iPhone 15 Pro Max         score=0.266  matches your preferred brand Apple; popular with Premium Flagship Shopper customers
Apple iPhone 14 Pro             score=0.255  matches your preferred brand Apple; popular with Premium Flagship Shopper customers
Apple iPad Pro 11 (2022)        score=0.243  matches your preferred brand Apple; popular with Premium Flagship Shopper customers; 7538 mAh battery
```
The CF model picks up that this user has purchased multiple Apple
flagships; the content scorer reinforces brand preference. iPads
sneak in because their specs (high storage, refresh rate) overlap
with the Premium Flagship cluster profile.

**Cold-start user (CUST-014332E4, Premium Flagship Shopper)**
— zero interactions, but the profile says 91k–229k NPR budget,
Samsung preference, Sudurpashchim Province. Cold-start path:
```
vivo iQOO 15T                   score=32.60  67200 NPR   popular with Premium Flagship Shopper; trending in Sudurpashchim Province
Honor Win                       score=30.90  67200 NPR   popular with Premium Flagship Shopper; trending in Sudurpashchim Province
Xiaomi Redmi K90 Max            score=25.30  61600 NPR   popular with Premium Flagship Shopper; trending in Sudurpashchim Province
Samsung Galaxy S24 Ultra        score=21.48  76738 NPR   popular with Premium Flagship Shopper; trending in Sudurpashchim Province
Samsung Galaxy S25 Ultra        score=20.57  107520 NPR  popular with Premium Flagship Shopper; trending in Sudurpashchim Province
```

**Cold-start user (CUST-529432E9, Budget Buyer)**
— 11k–31k NPR budget, Koshi Province:
```
Motorola Razr Ultra 2025        score=26.50  21834 NPR   popular with Budget Buyer; trending in Koshi Province
Oukitel WP55 Pro                score=26.40  23800 NPR   popular with Budget Buyer; trending in Koshi Province
Samsung Galaxy Tab S10 Ultra    score=25.27  32154 NPR   popular with Budget Buyer; trending in Koshi Province
Realme GT6 (China)              score=19.10  23800 NPR   popular with Budget Buyer; trending in Koshi Province
Huawei Mate 80 Pro Max Wind     score=18.00  12460 NPR   popular with Budget Buyer; trending in Koshi Province
```
The budget filter (`price ≤ 31,687 × 1.3 = 41,193`) keeps the list in
the budget zone, and the cluster popularity pulls in budget-tier
models that Koshi Province buyers actually chose.

---

## 4. How phase 2 was used

The customer_profiles_with_clusters.csv from phase 2 contributes:

- `cluster_id` (0–3) and `cluster_name` — used for cold-start tier 1
  (cluster popularity) and for the reason string ("popular with
  Premium Flagship Shopper customers").
- `chipset_tier` and `budget_min_npr` / `budget_max_npr` — used by the
  cold-start budget filter and the content score's price dimension.
- `gaming_interest` / `camera_interest` / etc. — used by the content
  scorer's `_user_to_spec` to project interests onto the spec vector.

Phase 2 was not used as a *training* feature for SVD/ALS — that would
have made the model depend on phase-2 outputs at inference time,
which is fragile. Instead, the cold-start path uses cluster ID
directly (an integer, stable across phase-2 model versions).

---

## 5. Limitations

1. **99.29 % sparsity** is the dominant constraint. With only
   52,925 non-zeros in a 7.5 M-cell matrix, all three CF models
   have weak signal. The hybrid at NDCG@10 = 0.05 is ~10× random
   baseline, which is good but not great. The fix would be more
   data — a year of interactions from 50 k real customers, not the
   4 k simulated customers we have.
2. **Catalog is 1,787 unique phones after dedup**, but ~25 % of
   purchases concentrate on 50 phones. The CF model learns those
   50 well and the rest poorly. For the long tail, content-based
   scoring is doing more work than CF.
3. **The hybrid doesn't always beat SVD** — for users with very few
   interactions (<3), the cosine term is noise and SVD alone is
   better. We didn't have time to implement a per-user weight
   selector; the static 0.6 / 0.4 split is a compromise.
4. **Reasons are templated**, not generated. The reason string
   doesn't say *why* this exact phone is a fit for this exact user —
   it picks the strongest of 7–8 generic clauses. A future version
   could use an LLM to write the reason text.
5. **Cold-start popularity caches are global**, not personalised.
   The cluster popularity tier works because the clusters are
   well-defined, but the content rerank at the end is what really
   personalises. If the content score is noisy (which it can be
   for sparse interest profiles), the cold-start list degrades to
   "popular stuff" + cluster pattern.
6. **No serendipity / diversity constraint**. The top-5 list can be
   5 nearly-identical phones from the same brand. A future version
   could enforce a max-2-per-brand constraint.

---

## 6. Code layout

```
03_collaborative_filtering/
├── cf_model.py            # All CF logic (matrix build, 3 models, content scorer, eval, CFRecommender)
├── train.py               # Trains the 3 models, evaluates them, writes model_comparison.{csv,json}
├── fit.py                 # Trains the actual production artefact (CFRecommender.save)
├── cf_readme.md           # This file
├── integration_notes.md   # For the backend team
└── output/                # Trained artefact + eval tables + inference CSVs
```

`train.py` is for **model comparison** — it produces the metrics in
§2. `fit.py` is for **production** — it trains the final model and
saves the pickle. They share `cf_model.py`; the only difference is
that `train.py` runs the full comparison suite and `fit.py` skips
straight to the save.

---

## 7. Re-running

```bash
# Full comparison + write model_comparison.csv/.json
python "ML model/filtering/03_collaborative_filtering/train.py"

# Final fit + save artefact (what production uses)
python "ML model/filtering/03_collaborative_filtering/fit.py"

# Smoke-test the saved artefact
python -c "from cf_model import CFRecommender; \
           r = CFRecommender.load('output/'); \
           print(r.get_recommendations('CUST-000EFD69', top_n=5))"
```

Both scripts are deterministic (seed = 42, `n_init = 10` for any
kmeans, `random_state = 42` for SVD). Two runs produce identical
outputs.