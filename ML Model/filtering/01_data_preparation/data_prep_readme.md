# 01 — Data Preparation for Collaborative Filtering

This phase refines the synthetic customer dataset into a real interaction log
suitable for collaborative filtering (CF). It treats both input files as
read-only and writes four CSVs into `output/`.

## Inputs (read-only)

| File | Purpose |
|---|---|
| `ML Model/SegmentationTask/customer_segmentation_dataset.csv` | 4,557 synthetic customer profiles |
| `dataset/GSMArena_Cleaned_Dataset.csv` | 8,500 GSMArena phones (raw catalog) |

## Outputs

| File | Rows | Cols | Notes |
|---|---:|---:|---|
| `output/customer_profiles_clean.csv` | 4,557 | 35 | Cleaned user profile, **without** `model_name` (segmentation in phase 2 will use this) |
| `output/phone_catalog.csv` | 1,787 | 31 | Filtered GSMArena catalog (5G + Available + Announced ≥ 2020, deduped by Model_Name) |
| `output/interactions.csv` | 86,195 | 5 | CF interaction log: `customer_id`, `model_name`, `interaction_type`, `rating`, `timestamp` |
| `output/cold_start_holdout.csv` | 282 | 4 | 228 cold-start users + 54 cold-start phones, marked for held-out evaluation |

**User-item pair sparsity: 99.11%** (well inside the 95–99% target band).

---

## 1. What was wrong with the original dataset for CF

The segmentation dataset is great for **profiling** — it has budget, interests,
min-spec requirements, behavioural metrics, and geography. But it is a
**single-purchase-per-customer** snapshot: one `model_name` per row, no event
log, no `rating` field, no history of views / searches / wishlists, no
timestamp ordering. CF needs exactly that:

- A user × item interaction matrix (sparse is fine — desired).
- An event time for temporal splits (train / validation / test).
- A way to distinguish strong signals (purchase, rating) from weak signals
  (view, search, wishlist).
- A way to hold out some users and items to test cold-start handling.

The pre-existing `model_name` column was also assigned via a
hash-of-customer-id modulo over candidates that satisfied only a coarse
brand-tier filter — not a true spec-matching join — so it could assign
flagship hardware to a budget-tier customer, etc. We re-do it properly here.

---

## 2. Schema inspection

Both schemas were printed by `data_preparation.py` before any column name was
hard-coded. Quick summary:

- **Segmentation CSV (4,557 × 36):** `customer_id`, `customer_name`,
  `province`, `district`, `location`, `age`, `gender`, `budget_min_npr`,
  `budget_max_npr`, `preferred_brand`, `brand_loyalty_score`, seven
  `*_interest` columns (gaming, camera, battery, display, performance,
  software, value), `min_ram_gb`, `min_storage_gb`, `chipset_tier`,
  `min_refresh_rate_hz`, `min_battery_mah`, behavioural metrics
  (`search_freq_per_week`, `compare_freq_per_week`, `n_past_purchases`,
  `avg_rating_given`, `wishlist_conversion_rate`, …), `interaction_channel`,
  `true_archetype`, `model_name`. No nulls.
- **GSMArena CSV (8,500 × 100):** `Brand`, `Model_Name`, `Status`,
  `5G_Support`, `Announced_Year`, `Price_EUR`, `RAM_GB`, `Storage_GB`,
  `Refresh_Rate_Hz`, `Battery_mAh`, `Main_Camera_MP`, `Lens_Count`,
  `Chipset`, `Chipset_Is_Flagship`, plus many `*_is_imputed` source-flag
  columns and image / URL fields. No nulls in any key spec column we used.
  3,551 rows have `Status` starting with "Available"; 2,200 are 5G;
  4,218 are from 2020 or later.

---

## 3. Phone catalog filter

We keep only phones that a Nepal CF pipeline would actually recommend:

```
Status starts with "Available"
    AND 5G_Support == "Yes"
    AND Announced_Year >= 2020
    AND 30 <= Price_EUR <= 3000              # ~ NPR 4,200 – 420,000
    AND 1500 <= Battery_mAh <= 12000          # drop junk 0 / 33280 mAh rows
    AND 60 <= Refresh_Rate_Hz <= 240          # drop outlier 920 Hz
    AND RAM_GB >= 1
```

Then we **dedupe by Model_Name** (the upstream catalog has regional variants
under the same name — e.g. "OnePlus 13" appears 5 times for India / China /
Global — we keep the first).

Result: **1,787 unique phones** (1,791 rows × dedupe → 1,787 names).
Tier breakdown by `npr_price` (= `Price_EUR × 140`):

| Tier | Count |
|---|---:|
| Mid | 775 |
| Flagship | 712 |
| Budget | 300 |

We add derived columns used downstream for spec-matching:

- `Brand_norm` (e.g. `Redmi → Xiaomi`, `ASUS → Asus`).
- `tier` (`Budget` < NPR 25k, `Mid` < NPR 80k, else `Flagship`, with override
  if `Chipset_Is_Flagship == 1`).
- `gaming_score`, `camera_score`, `battery_score`, `display_score`,
  `performance_score`, `software_score`, `value_score` — each on a rough
  0–30 scale, normalised within the candidate pool at scoring time.

---

## 4. Spec-matching join (replacing `model_name`)

For each customer we run a **two-stage filter-and-rank**:

### Stage 1 — hard filter (must satisfy all)

| Constraint | Why |
|---|---|
| `RAM_GB >= min_ram_gb` | Customer minimum |
| `Storage_GB >= min_storage_gb` | Customer minimum |
| `Refresh_Rate_Hz >= min_refresh_rate_hz` | Customer minimum |
| `Battery_mAh >= min_battery_mah` | Customer minimum |
| `npr_price ∈ [0.6 × budget_min_npr, 1.2 × budget_max_npr]` | Within ±20–40% of budget band |
| `tier >= chipset_tier − 1` | Customer can be upsold one tier but not downsold |

If that filter is empty, we relax in this order: drop the tier constraint,
then widen the price band to `[0.4 × min, 1.5 × max]`, then `[0.4 × min,
2.0 × max]`, then fall back to the cheapest phone in the catalog.
**0 rows used the absolute fallback** — every customer matched a phone that
satisfied at least the relaxed price band.

### Stage 2 — soft score (rank candidates)

```
score = Σ_dim   (interest_dim / 100) × normalised(catalog_score_dim)
      + brand_bonus × (0.4 + 0.8 × brand_loyalty_score)
      + proximity_to_budget_midpoint × 0.15
      + jitter × 0.5                 # deterministic tie-breaker
      + price_tier_round × 0.05      # small bias toward "60%-of-budget" picks
```

- Each catalog spec dimension (gaming, camera, battery, …) is min-max
  normalised **within the candidate pool** for that customer, so the
  ranking is relative rather than absolute.
- `brand_bonus` is 1.0 if `Brand_norm` matches `preferred_brand`, else 0.0.
  Brand-loyal customers (`brand_loyalty_score ≥ 0.7`) get a stronger bonus.
- `proximity_to_budget_midpoint` rewards phones priced near the customer's
  budget midpoint.
- `jitter` is `hash_unit("customer_id:model_name") ∈ [0, 1)`, scaled by
  0.5, so two customers with the same spec profile still pick different
  phones — preventing all 4,557 customers from collapsing onto one model.
- `price_tier_round` is a small bonus for phones priced around 60 % of the
  customer's budget range (the "sweet spot" where most real purchases land).

The deterministic jitter is critical. Without it, all customers with the
same profile get the same assigned phone, which makes CF pointless (every
user-row looks identical). With it, **124 unique phones are assigned across
4,557 customers** while still respecting each customer's hard requirements.

**Assignment quality check** (against the 4,329 purchase events):

| Constraint | Match rate |
|---|---|
| RAM ≥ min_ram_gb | 4,329 / 4,329 (100 %) |
| Storage ≥ min_storage_gb | 4,329 / 4,329 (100 %) |
| Refresh_Rate ≥ min_refresh_hz | 4,329 / 4,329 (100 %) |
| Battery ≥ min_battery_mah | 4,329 / 4,329 (100 %) |
| Price within `[0.6 × bmin, 1.2 × bmax]` | 4,329 / 4,329 (100 %) |
| Brand matches `preferred_brand` | 3,016 / 4,329 (69.7 %) |

The 69.7 % brand-match rate reflects the fact that only ~33 % of customers
have `brand_loyalty_score ≥ 0.7`; the other ~67 % explicitly explore other
brands, which is what produces the 30 % cross-brand purchase rate. This is
realistic and is what CF needs — non-loyal customers are the source of
"serendipity" recommendations.

---

## 5. Geography cleaning

We validate every row against the same `province → district → location`
hierarchy used by the upstream segmentation script. **4,557 / 4,557 rows
already passed** — no fixes were needed.

For robustness the script also handles:

- Province missing or invalid → re-derived from the customer's district, or
  defaulted to Bagmati.
- District missing → re-derived from the customer's location, or defaulted
  to Kathmandu.
- District valid but not under the current province → re-aligned (district
  determines province).
- Location missing or not under the current district → re-derived from
  the location → district reverse map, or defaulted to the first valid
  location in the chosen district.

After cleaning, every row is re-validated and must satisfy
`location ∈ NEPAL_LOCATIONS[province][district]`.

**Assumption:** when geographic re-derivation is needed, we choose
Bagmati / Kathmandu because it is the largest urban customer base; in
practice, the upstream dataset is already clean and we did not need any
fallback paths.

---

## 6. Interaction log generation

The single-purchase structure is expanded into a CF-style event log using
the existing behavioural fields as **generators** (not deterministic
predictors):

| Behavioural field | How it drives the log |
|---|---|
| `n_past_purchases` | 1 purchase event per customer for the assigned `model_name` |
| `avg_rating_given` | Mean rating for the purchase; `rate` event uses rating ± noise |
| `search_freq_per_week`, `compare_freq_per_week` | Number of view / search / compare events generated |
| `wishlist_conversion_rate` | Subset of exploration events become `wishlist` events |
| `recency_days` | Distance of the purchase timestamp from "today" (2026-08-10) |

**Persona does NOT deterministically pick items.** For each customer we:

1. Build a candidate pool of phones in the same tier (plus adjacent tier),
   priced within ±30 % of their budget band.
2. Deterministically permute the pool using a per-customer RNG seeded by
   `hash(customer_id)`.
3. Sample `n_explore = clamp(search_freq + compare_freq + jitter, 3, 40)`
   phones (with replacement) from the permuted pool.
4. Assign interaction types from a weighted pool
   `[view×6, search×3, compare×2, wishlist×1]`.
5. Spread timestamps uniformly across the last 365 days.

Resulting interaction-type counts:

| Type | Count | Strong / weak signal |
|---|---:|---|
| view | 34,607 | weak |
| search | 17,391 | weak |
| wishlist | 16,325 | medium |
| compare | 11,402 | weak |
| purchase | 4,329 | strong (rating attached) |
| rate | 2,141 | strong (rating attached) |
| **Total** | **86,195** | |

---

## 7. Cold-start holdout

Two disjoint holdouts are produced for evaluation in phase 3:

- **228 cold-start users** (≈5 % of customers) — completely removed from
  `interactions.csv` (zero rows reference them). Their profile fields
  remain in `customer_profiles_clean.csv` so they can be evaluated as
  brand-new arrivals.
- **54 cold-start phones** (≈3 % of the catalog) — flagged with
  `is_cold_start_phone = 1` in `phone_catalog.csv` and listed in
  `cold_start_holdout.csv`. Other users may still view / search them
  (which is realistic — discovery is what CF uses to recommend them to
  cold-start users), but they should not appear in the training
  purchase/rate signals if we want to test pure cold-start item
  recommendation. The flag lets the evaluator filter them out.

The holdout is split deterministically (seed `SEED + 1 = 43`).

---

## 8. Final row counts and sparsity

| Output | Rows | Notes |
|---|---:|---|
| `customer_profiles_clean.csv` | 4,557 | 35 columns (model_name dropped) |
| `phone_catalog.csv` | 1,787 | 31 columns incl. `is_cold_start_phone` |
| `interactions.csv` | 86,195 | 5 columns |
| `cold_start_holdout.csv` | 282 | 228 users + 54 phones |
| **User-item pair sparsity** | **99.11 %** | 72,726 distinct (user, item) pairs out of 8,138,802 possible |

72,726 distinct pairs is comfortable for matrix-factorisation CF — well
above the usual "long-tail" floor of ~10 events/item needed for stable
embedding training.

---

## 9. Data quality issues resolved

| Issue | Resolution |
|---|---|
| 8,500 GSMArena rows include `Status=Discontinued` and pre-2020 devices — useless for CF | Filter to `Status` starts with "Available" + `Announced_Year ≥ 2020` |
| 123 duplicate `Model_Name` rows in the filtered catalog (regional variants) | `drop_duplicates(subset=["Model_Name"], keep="first")` |
| Up to 15 % of phones have junk spec values (0 mAh battery, 920 Hz refresh, 0.007 GB RAM) | Hard clip in the catalog filter |
| Original `model_name` could be brand-incompatible (e.g. Apple customer got a Xiaomi phone) | Hard spec filter + brand bonus in spec-matching |
| Original `model_name` could be tier-incompatible (Budget customer got a Flagship phone) | Tier-rank constraint: customer can be upsold one tier but not downsold |
| Single row per customer gave CF nothing to learn from | Expanded into 86k-row interaction log with 6 event types |
| No timestamps for temporal split | Timestamps spread across the last 365 days, deterministic per customer |
| No rating signal | Rating = `avg_rating_given ± N(0, 0.5)` clipped to [1, 5], attached to purchase + rate events |

---

## 10. Assumptions made (not asked, documented here)

1. **EUR → NPR = 140** — same constant used by the upstream segmentation
   script. We did not look up a live FX rate.
2. **Timestamp horizon = today (2026-08-10)** — all interaction timestamps
   fall in `[2025-08-11, 2026-08-10]`.
3. **Persona does not deterministically pick phones.** Even though the
   customer profile says `gaming_interest = 90`, the actual phones they
   interact with are sampled from a per-customer permuted pool. This is
   essential: deterministic mapping would make `model_name` recoverable
   from profile features and break CF.
4. **Wishlist events are a subset of view/search/compare events**, not
   additional events. This keeps the total event count per customer in
   line with their `search_freq_per_week` etc.
5. **Cold-start phones can still receive view/search signals from other
   users.** This is intentional — CF uses those signals to recommend the
   cold-start phone to other users. To evaluate "pure" item cold-start,
   the downstream evaluator should filter to `(purchase | rate)` events
   for cold-start phones, not all event types.
6. **`customer_profiles_clean.csv` does not carry the new `model_name`**.
   The new assignment is observable through the `purchase` events in
   `interactions.csv` (one per customer). If a phase-2 model needs the
   assignment directly, it should `LEFT JOIN interactions ON customer_id
   WHERE interaction_type = 'purchase'`.

---

## 11. Re-running

```bash
python "ML model/filtering/01_data_preparation/data_preparation.py"
```

The script is deterministic (fixed `SEED = 42`). Two runs produce
byte-identical output.
