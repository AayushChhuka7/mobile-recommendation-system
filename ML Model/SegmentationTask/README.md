# Customer Segmentation Dataset

This module creates a single, internally-consistent customer-row dataset that links three previously disconnected sources into one table suitable for customer segmentation and downstream recommendation.

## Files in this folder

- `customer_segmentation_dataset.csv` — final dataset, **4,557 rows, 36 columns** (one row per real customer)
- `dataset_summary.md` — descriptive statistics (province, archetype, brand, min/mean/max of every numeric column, top assigned phones)
- `generation_script.py` — single self-contained Python script (pandas + numpy). Deterministic: same inputs → same output.
- `verify.py` — runs all verification checks (identity preservation, schema, geography hierarchy, phone existence, internal-consistency rules, etc.)

## Why this new dataset was created

The project had three datasets that did not share keys:

| File | Rows | Customer identity | Purpose |
|---|---:|---|---|
| `dataset/customer_dataset.csv` | 16,608 transactions | Real `customer_id` + `customer_name` used by the backend | Transactional history |
| `ML Model/synthetic_outputs/synthetic_customers.csv` | 8,000 customers | Synthetic IDs (`syn_u_00000`...) | Segmentation features + `tue_archetype` |
| `dataset/GSMArena_Cleaned_Dataset.csv` | 8,500 phones | — | Phone catalog for recommendations |

Because the synthetic dataset had no overlap with the real customer IDs, the planned pipeline `Customer → Customer Segmentation → Recommendation` could not join segmentation results back to the real customer records. The new dataset fixes that: it is one CSV that any segmentation model can train on, and any recommender can index by `customer_id`.

## How it differs from the previous synthetic dataset

| Aspect | Old `synthetic_customers.csv` | New `customer_segmentation_dataset.csv` |
|---|---|---|
| Customer ID | `syn_u_00000` … | Real `CUST-XXXXXXXX` (4,557 unique) |
| Customer name | Synthetic (e.g. "Anjali Adhikari") | Real names from the backend |
| Geography | Single `city` + `city_tier` | `province` + `district` + `location` (Nepal hierarchy) |
| Current phone | None | `model_name` from GSM Arena |
| Archetype column name | `tue_archetype` (typo) | `true_archetype` (typo fixed on output) |
| Synthetic column used as | Direct copy | Values source only; not copied |

## How it keeps compatibility with the backend

- **`customer_id` and `customer_name` are taken verbatim** from `dataset/customer_dataset.csv` after collapsing transactions to one row per customer (using the same latest-wins rule the backend's `backend/prisma/imports/customer-csv/customerGrouper.mjs` already uses).
- The dataset is **read-only with respect to existing files** — the customer CSV, the synthetic CSV, the phone CSV, the backend, and the existing recommendation pipeline are not modified.
- `model_name` values are guaranteed to exist in `dataset/GSMArena_Cleaned_Dataset.csv` (the same phone catalog the existing recommender uses).

## Why customer IDs remain unchanged

- The backend imports `customer_dataset.csv` and creates `users` rows keyed on `customer_id` (with `email = ${customer_id}@import.local`). Any future segmentation-aware recommendation must be able to join on this key.
- Changing customer IDs would orphan every existing `user`, `user_profile`, `user_preference`, `customer_profile`, `payment_history`, `browsing_history`, and `search_history` row in the production database.
- All 4,557 unique `customer_id` values from the real dataset are preserved exactly.

## Why `model_name` was added

The customer's current phone is required for three of the recommendation scenarios in the segmentation prompt:

1. **Cold Start Recommendation** — for a brand-new customer we have no browsing history, but we do know what phone they currently own. We can recommend accessories, trade-in upgrades, or "phones people like you also bought" based on the current model.
2. **Brand Switching Recommendation** — if a brand-loyal customer owns a Samsung A series and we want to suggest Apple, we need to know the current model to estimate the price tier and feature gap.
3. **Upgrade Recommendation** — for a customer who bought their current phone 2+ years ago, we can recommend the natural upgrade path within the same brand or across brands.

Assignment is **hybrid**:
1. The customer's most recent `mobile_model_purchased` is normalized and looked up in GSM Arena. If matched, that exact model is used.
2. If not matched (e.g. a fictional model name like "iPhone 17 Pro Max"), the script falls back to rule-based assignment: brand-loyal customers (`brand_loyalty_score >= 0.7`) bias toward their `preferred_brand`; the catalog is filtered by the customer's budget band and dominant interest (gamer → high RAM + Flagship + 120 Hz; photographer → high MP; battery → ≥5000 mAh; display → ≥90 Hz); a deterministic hash picks the final model.

The result: **100% of assigned `model_name` values exist in GSM Arena**, spread across **1,393 unique phones**.

## Why geography was added

The new `province` → `district` → `location` hierarchy is a forward-looking feature. It will support:

- **Location-based popularity** — different districts may favor different brands (e.g. Madhesh favors Xiaomi/Realme; Bagmati favors Samsung/Apple).
- **Regional availability** — certain phones (especially 5G flagships) may not be readily available in remote districts.
- **Festival offers** — Dashain/Tihar promotions differ by region; location-aware segmentation can target them.
- **Nearby service centres** — recommended phones can be filtered by service-centre proximity.
- **Regional purchasing trends** — average spend, preferred payment method, and seasonality all vary by district.

Geography is **always re-sampled** (the original `city` field is dropped) and the distribution follows Nepal's real population skew (Bagmati 21%, Madhesh 20%, Lumbini 17%, Koshi 17%, Gandaki 10%, Sudurpashchim 9%, Karnali 6%) with extra weight for urban districts and city locations. The hierarchy integrity is guaranteed by construction: every location is selected from within the chosen district, and every district from within the chosen province. All 4,557 rows pass the hierarchy check.

## How this dataset supports customer segmentation

- **31 numeric/categorical features** (interests, hardware minimums, behaviour metrics, demographics) per customer.
- **`true_archetype` ground-truth label** (8 archetypes matching the synthetic generator): `Hardcore Gamer`, `Mobile Photographer`, `Battery-Focused User`, `Display Enthusiast`, `Premium Flagship User`, `Brand-Loyal Customer`, `Budget Buyer`, `All-Round User`. This is a **supervised** target; segmentation models can use it for ARI evaluation, or it can be dropped for unsupervised K-Means / DBSCAN.
- **Internal-consistency rules preserved** from the synthetic generator: `gaming_interest ≥ 80 → min_refresh_rate_hz ≥ 120` and `chipset_tier = Flagship` and `min_ram_gb ≥ 8`; `battery_interest ≥ 80 → min_battery_mah ≥ 5000`; `camera_interest ≥ 85 → min_storage_gb ≥ 128`; `display_interest ≥ 80 → min_refresh_rate_hz ≥ 120`. All rules are validated by `verify.py`.

## How it will later support recommendation

The new `model_name` + geography columns extend the existing recommender in `ML Model/pipeline/recommend.py` (which already uses `PERSONA_PRESETS` for `Gamer`, `Camera_Lover`, `Battery_Focused`, `All_Rounder`, `Business_User`):

- **Cold Start**: when a new user has no interaction history, the system can use the segmentation features + current `model_name` to jump-start recommendations.
- **Brand Switching**: compare `preferred_brand` (from segmentation) vs the brand of `model_name` (current phone) to identify switch opportunities.
- **Upgrade**: `n_past_purchases` + `recency_days` + `model_name`'s release year identify upgrade candidates.
- **Regional**: `province`/`district`/`location` enable location-aware popularity boosts and service-centre filtering.
- **Festival & regional offers**: hook the location columns into seasonal promotion logic.

## Running the pipeline

```bash
# 1. Generate the dataset
python "ML Model/SegmentationTask/generation_script.py"

# 2. Verify
python "ML Model/SegmentationTask/verify.py"
```

The script is deterministic. Running it twice produces byte-identical output.

## Verification summary

All 15 checks pass (`verify.py`):

- 4,557 unique customers, no duplicates, identity preserved
- 36-column schema, no `tue_archetype` typo
- 0 NaN values in any column
- 100% of `model_name` values exist in GSM Arena (1,393 unique phones)
- 100% of geography entries respect `province → district → location` hierarchy
- All 322 hardcore gamers have `min_refresh_rate_hz ≥ 120`
- All 304 battery-focused users have `min_battery_mah ≥ 5000`
- All 257 camera-focused users have `min_storage_gb ≥ 128`
- Top 2 provinces (Madhesh + Bagmati) account for 41.7% of customers
- `budget_min_npr ≤ budget_max_npr` for every row
- All interest scores in [0, 100]
- Budget Buyers have median `budget_max_npr` = 26,418 NPR
- Hardcore Gamers all have `min_ram_gb ≥ 8`
