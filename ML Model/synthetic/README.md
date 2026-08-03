# Synthetic Customer Dataset Generator

Generates an **internally consistent** synthetic customer dataset for the
mobile-recommendation-system segmentation module. Each customer row is
sampled from one of **8 archetypes** whose centroid values describe a
meaningful persona, with **±10% Gaussian noise** so K-Means has work to do
but can recover the structure.

The synthetic CSV has a `true_archetype` column for validation that the
downstream segmentation notebook can compare clustering assignments
against (using Adjusted Rand Index).

---

## Quickstart

From the project root:

```bash
# 1. Generate the dataset (default: 8,000 rows)
python "ML Model/synthetic/generator.py" --n 8000 --seed 42

# 2. Validate the output
python "ML Model/synthetic/validate.py"
```

Both commands write to `ML Model/synthetic_outputs/`:

| File | Purpose |
|---|---|
| `synthetic_customers.csv` | **The dataset.** 35 columns × N rows. |
| `synthetic_customers_schema.json` | Column metadata (name, dtype, range, role). |
| `archetype_summary.csv` | Per-archetype mean of every numeric column + population counts. |
| `validation_report.json` | All internal-consistency checks (cohesion, separation, ARI). |

---

## The 8 Archetypes

Distribution matches `README_CUSTOMER_SEGMENTATION.md`. Run `python -m
synthetic.generator` for full population stats.

| Archetype | Pop. share | Defining signal |
|---|---:|---|
| **Hardcore Gamer** | 12% | `gaming_interest ≈ 92`, refresh_rate ≥ 120 Hz, Flagship chipset, ASUS/Oneplus |
| **Mobile Photographer** | 14% | `camera_interest ≈ 96`, ≥ 128 GB storage, Flagship, Google/Apple |
| **Budget Buyer** | 22% | `value_interest ≈ 85`, Budget chipset, 60 Hz, Redmi/Realme |
| **Premium Flagship User** | 10% | Flagship, brand-loyal Apple/Samsung, high `software_interest ≈ 85` |
| **Battery-Focused User** | 11% | `battery_interest ≈ 95`, ≥ 5,000 mAh, Samsung/Mid chipset |
| **Brand-Loyal Customer** | 13% | `brand_loyalty ≈ 0.95`, Apple/Samsung, balanced interests |
| **All-Round User** | 10% | All interest scores ≈ 50, balanced, exploratory |
| **Display Enthusiast** | 8% | `display_interest ≈ 95`, 144 Hz, Samsung/Oneplus |

The 5 archetypes *with* defining features (Gamer, Photographer, Budget,
Premium, Battery, Display) produce tight, separable clusters. Brand-Loyal
and All-Round sit closer to each other but are still distinguishable by
their `brand_loyalty_score` and engagement metrics.

---

## Schema — 35 Columns

| Role | Columns | Notes |
|---|---|---|
| **Identity (2)** | `customer_id`, `customer_name` | Not used in clustering |
| **Demographics (5)** | `age`, `gender`, `city`, `city_tier`, `country` | Nepal; 90 cities |
| **Budget & Brand (4)** | `budget_min_npr`, `budget_max_npr`, `preferred_brand`, `brand_loyalty_score` | NPR currency |
| **Interest Scores (7)** | `gaming_interest`, `camera_interest`, `battery_interest`, `display_interest`, `performance_interest`, `software_interest`, `value_interest` | 0–100 each. **Primary clustering axes.** |
| **Hardware (5)** | `min_ram_gb`, `min_storage_gb`, `chipset_tier`, `min_refresh_rate_hz`, `min_battery_mah` | Snap to allowed choices; consistent with interest scores |
| **Behavioural / RFM (6)** | `purchase_frequency_per_year`, `n_past_purchases`, `avg_session_minutes`, `search_freq_per_week`, `compare_freq_per_week`, `click_through_rate` | |
| **Engagement & Channel (5)** | `recency_days`, `avg_rating_given`, `interaction_channel`, `wishlist_conversion_rate`, `accessory_affinity` | Channel = Mobile App / Daraz / WhatsApp / etc. |
| **Ground Truth (1)** | `true_archetype` | **Drop before clustering.** Validate with ARI. |

**Total: 35 columns.** Clustering input = 32 (everything except the 3
identity / ground-truth columns).

---

## Internal-Consistency Rules

The generator enforces **5 invariants** so the dataset is "impossible"
in obvious ways — a row's hardware preferences must match its interest
scores. The validator checks ≥95% compliance.

| Rule | Predicate |
|---|---|
| `gaming_implies_high_refresh`     | `gaming_interest ≥ 80 → min_refresh_rate_hz ≥ 120` |
| `battery_implies_big_cell`        | `battery_interest ≥ 80 → min_battery_mah ≥ 5000` |
| `flagship_implies_enough_ram`     | `chipset_tier ∈ {Flagship, Flagship-Killer} → min_ram_gb ≥ 8` |
| `photographer_implies_storage`    | `camera_interest ≥ 85 → min_storage_gb ≥ 128` |
| `display_implies_high_refresh`    | `display_interest ≥ 80 → min_refresh_rate_hz ≥ 120` |

---

## How It Differs From Existing `customer_dataset.csv`

| Aspect | `customer_dataset.csv` (real) | This synthetic dataset |
|---|---|---|
| Rows | 16,608 transactions (4,557 unique) | 8,000 customers (long format? no — 1 row/user) |
| Ground truth | None | 8-class `true_archetype` |
| Interest scores | Must be derived from `browsing_history` JSON | Native columns, 0–100 |
| Internal consistency | Loose (no validation step) | Enforced rules + validation |
| Realism | High | Medium (Nepal context preserved) |
| Use case | Modelling production traffic | Training/validating clustering algorithms |

You can still cluster `customer_dataset.csv` (the existing notebook in
`ML Model/customer_segmentation_continuation.ipynb` already does so), but
this synthetic file is the **cleaner** input for Parts 4–6 of the
segmentation prompt (algorithm comparison + k selection).

---

## Python API

```python
from synthetic import generate, write_outputs, validate_dataset
from synthetic.feature_schema import CLUSTERING_FEATURES, INTEREST_SCORES

# Generate
df = generate(n_users=8000, seed=42)
df.to_csv("synthetic_customers.csv", index=False)

# Or use the helper that writes CSV + schema + summary
write_outputs(df, Path("synthetic_customers.csv"))

# Validate
report = validate_dataset(Path("synthetic_customers.csv"))
print(report["summary"])
# {'n_rows_ok': True, 'distribution_ok': True, 'cohesion_ok': True,
#  'separation_ok': True, 'invariants_ok': True, 'clustering_ari': 0.78,
#  'clustering_ok': True, 'all_pass': True}
```

---

## Dependencies

Already in `ML Model/requirements.txt`:
- `pandas==2.2.3`
- `numpy==1.26.4`

Optional (the validator imports it lazily; if missing, the validator falls
back to nearest-centroid accuracy):
- `scikit-learn==1.5.2`

No `faker`, no internet calls, no GPU.

---

## Files in This Module

```
ML Model/synthetic/
├── __init__.py            Public API re-exports
├── archetypes.py          The 8 archetype specs + weights + invariants
├── feature_schema.py      Column metadata (35 columns, types, ranges)
├── generator.py           generate() + write_outputs() + CLI
├── noise.py               Gaussian + weighted-choice helpers
├── validate.py            run every internal-consistency check + ARI
└── README.md              This file
```

---

## How This Feeds the Project

The synthetic CSV is a drop-in replacement for `dataset/customer_dataset.csv`
in `ML Model/customer_segmentation_continuation.ipynb`. Change the `DATA_PATH`
cell to point at `synthetic_outputs/synthetic_customers.csv`, drop the
`true_archetype` column (the notebook already drops non-feature columns via
`CLUSTERING_FEATURES`), and run. You should see silhouette scores in the
**0.30–0.50** range (vs ~0.13 on the real data) and an ARI ≥ 0.6 against
ground truth.
