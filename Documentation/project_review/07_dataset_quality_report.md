# 07 — Dataset Quality Report

> The two datasets — `customer_dataset.csv` (16,608 rows) and `GSMArena_Cleaned_Dataset.csv`
> (8,500 rows) — drive every model. This document identifies the quality gaps
> and the leakage risks.

---

## 1. Shape and schema

```
customer_dataset.csv     16,608 rows × 24 columns
GSMArena_Cleaned_Dataset  8,500 rows × 100 columns
```

The customer dataset is **transaction-level** (4,557 unique `customer_id`s, average ~3.6 transactions per customer).
The phone dataset is **spec-level** (one row per phone model, even across variants).

---

## 2. Missingness audit

### 2.1 Customer dataset

```
column                       missing
─────────────────────────────────
(after literal inspection)    0 in every column
```

The notebook reported `isna().sum() == 0` for every column. **However**, this is misleading:

- `wishlist` and `browsing_history` are **strings** containing JSON-like arrays.
- Empty arrays (`[]`) are not `NaN` but are *semantically* missing.
- The notebook handles this by `safe_parse_list(s, default=[])` — but the `accessories_purchased` for **all** customers in the snippet we read is empty.

**Implication:** the `accessory_count`, `accessory_spend_npr`, `accessory_with_phone_count` features are **constant 0** for nearly every customer. Including them in K-Means is harmless (zero variance) but including them in an XGBoost model may be **misleading** — they look informative but carry no signal.

**Action.** Filter zero-variance features before K-Means. Use `VarianceThreshold(threshold=0.01)`.

### 2.2 Phone dataset

The notebook reports `100% non-null on 8,500 rows`. But:

- `Flash_Type` is `7,645 non-null` — **855 missing values** (~10%).
- `AnTuTu_Score_Source`, `GeekBench_Score_Source`, `GPU_Source`, etc. — `unfilled` for any row without a scraped value.
- Many `*_is_imputed` boolean columns are `True` for missing values.

**Implication.** `AnTuTu_Score` is missing for many phones; the training script correctly filters `AnTuTu_Score_is_imputed == False` (3744 of 8500 phones have real AnTuTu). But this is a **survivor bias** — the model only learns from phones that someone cared to benchmark.

**Action.** For a research paper, add a "training set coverage" section: "We trained on N=3,744 phones where AnTuTu was measured; the remaining N=4,756 are scored by the model."

---

## 3. Label leakage risks

### 3.1 Direct leakage

- `AnTuTu_Score` is the target. `AnTuTu_Score_Source`, `AnTuTu_Score_is_imputed` are leakage columns and must be **dropped before training**. The current `train.py` correctly drops `AnTuTu_Score` and `AnTuTu_Score_Source` but does **not** drop `AnTuTu_Score_is_imputed`. (Actually it does, indirectly via the suffix `_is_imputed` filter at line 64.) ✅ Verified safe.
- `Chipset` → `Chipset_Brand` → `Chipset_Is_Flagship`. The latter is a derived flag from the former. They are correlated but **not** leakage. ✅ Safe.
- `CustomerProfile.recommendationPersona` mirrors `cluster_id` from the segmentation. If you use this as a feature for a future "predict cluster" model, that's leakage. ⚠ Note for the Segment Classifier idea.

### 3.2 Temporal leakage

The customer dataset has purchase dates from **2020-01-01 to 2026-04-03**. There is **no future-data leakage** because we don't predict the future. **But**:

- For a **churn** model (`recency_days > 365`), the label is defined with respect to the *latest* purchase date. If you split train/test **without** `time`, you get data leakage (a 2023 customer with `recency_days = 1095` is "churned" relative to 2026, but at training time the split would put them in train and the model would learn to predict their label correctly using the same date).
- **Action.** For churn, use a **time-based split**: train on transactions up to 2025-01-01, test on 2025-01-01 to 2026-04-03.

### 3.3 Customer-level leakage

The customer dataset has **multi-row customers** (12,051 of 16,608 rows are duplicates by `customer_id`). If you split train/test by row, you may put one customer's earlier transaction in train and their later one in test.

**Action.** Use **GroupKFold** with `customer_id` as the group.

---

## 4. Class imbalance

### 4.1 Customer categories

- `preferred_category` distribution: skewed toward `Battery-focused` and `Mid-range`.
- `preferred_brand` distribution: Xiaomi dominates, followed by Apple, Samsung.

For an XGBoost classifier on `preferred_category`, use `sample_weight = 1 / class_count` or `scale_pos_weight` for binary problems.

### 4.2 Phone status

`Status_Category` is heavily skewed toward `Discontinued` (most phones are old). For a "is purchasable" classifier, use **stratified sampling**.

---

## 5. Currency and locale

- Customer dataset is **NPR (Nepalese Rupee)**.
- `Content_Based_Recommendation.ipynb` hard-codes `npr_to_eur = 1 / 150`.
- The FastAPI service receives `budget` as **EUR**.
- The phone dataset `Price_EUR` is EUR.

**Implication.** The cluster centroid of `avg_purchase_amount_npr` is in NPR, but the model uses EUR throughout. **Inconsistent units everywhere**.

**Action.**
1. Convert all customer spend to EUR in a `customer_dataset_eur.csv` step.
2. Update the segmentation notebook to read EUR.
3. Remove the `1 / 150` hack from `Content_Based_Recommendation.ipynb`.

---

## 6. PII and GDPR

The customer dataset contains **personally identifiable information**:

- `customer_name` (full name)
- `city` (geo, ~90 distinct cities in Nepal)
- `purchase_date`, `last_active_at` (timestamps)
- `browsing_history` (could be sensitive)
- `accessories_purchased` (could be sensitive)

**For a public GitHub repo, this is a problem.** Either:
- Hash `customer_id` with SHA-256 and drop `customer_name` and `city` from any published CSV.
- Use synthetic data (e.g., `Faker` library).
- Document that the dataset is private and not redistributable.

---

## 7. Data drift risks

| Drift type            | Risk                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| **Schema drift**       | A 2027 phone has `Chipset_Family = 'Snapdragon_X4'` not in training  | Mitigated by `CategoricalDtypeManager` (NaN handling) |
| **Distribution drift** | New phones have higher RAM, faster chips                              | Mitigated by `_clip_norm` (clips to frozen quantiles) but loses signal |
| **Concept drift**      | User preferences shift (e.g., folding phones become mainstream)       | Mitigated by quarterly re-training with active-learning labels |
| **Label drift**        | `preferred_category` is a 6-bucket self-report — buckets may shift   | Mitigated by re-clustering customer segments quarterly |

---

## 8. Suggested data-quality pipeline (script outline)

```python
import pandas as pd
from great_expectations import expectation_suite

def run_quality_checks(df: pd.DataFrame) -> list[str]:
    issues = []
    # 1. Schema
    expected_cols = {...}
    if set(df.columns) != expected_cols:
        issues.append("schema mismatch")
    # 2. Missingness
    null_frac = df.isna().mean()
    for col, frac in null_frac.items():
        if frac > 0.05:
            issues.append(f"{col} has {frac:.1%} nulls")
    # 3. Cardinality
    for col in df.select_dtypes(include="object"):
        if df[col].nunique() == len(df):
            issues.append(f"{col} has 1:1 cardinality (likely ID)")
    # 4. Duplicates
    dup = df.duplicated().sum()
    if dup > 0:
        issues.append(f"{dup} exact duplicates")
    # 5. Type checks
    if df["age"].max() > 100 or df["age"].min() < 0:
        issues.append("age out of range")
    # 6. Class balance
    if df["preferred_category"].value_counts(normalize=True).max() > 0.6:
        issues.append("preferred_category is imbalanced")
    return issues
```

Run this on every training dataset; fail the CI if any issue.

---

## 9. Concrete data-card (template)

```
data_card:
  name: GSMArena_Cleaned_Dataset
  source: scraped from gsmarena.com (Jun-Jul 2024)
  rows: 8500
  columns: 100
  numeric: 24
  categorical: 51
  boolean: 14
  text: 51 (high-cardinality categorical treated as text)
  missing: Flash_Type 10%, others < 1%
  duplicates: 0
  date_range: 2009 to 2024
  brands: Apple, Samsung, Xiaomi, ... (47 total)
  PII: none (phone-level, no customer info)
  license: personal/educational use only
  known_issues:
    - AnTuTu missing for 56% of phones
    - Price_EUR is the only price; no USD, NPR
  contact: <team lead>
  last_updated: 2024-07
```

---

## 10. Summary

| Risk                              | Severity | Mitigation                                          |
| --------------------------------- | -------- | --------------------------------------------------- |
| PII in customer_dataset.csv       | High     | Hash, drop, or synthesize before publishing        |
| Zero-variance features            | Medium   | `VarianceThreshold`                                 |
| Temporal leakage in churn models  | High     | Time-based split                                    |
| Customer-level leakage in CV      | Medium   | `GroupKFold(customer_id)`                            |
| Currency mismatch                 | Medium   | Standardise on EUR in `customer_dataset_eur.csv`     |
| Concept drift                     | Low      | Quarterly re-train                                  |
| Missing AnTuTu on 56% of phones   | Low      | Document coverage; consider semi-supervised learning |

Addressing **PII** and **temporal leakage** alone would prevent the most embarrassing mistakes at the viva.