# 03 — Tech Tier Classifier (XGBoost, multi-class)

> **Use case.** Classify a phone into `TechTier` (`Budget | Reasonable | FlagshipKiller | TechSavvy | Luxurious`).

---

## When to use

- Replace the rule-based `TIER_MAP_5` in `pipeline/scoring.py` with a learned classifier.
- The catalog shows a tech-tier chip that drives discovery.

---

## Data

Synthetic labels:

```python
def label_tech_tier(row):
    if row["Price_EUR"] >= 1000 and row["AnTuTu_Score"] >= 900000:
        return "Luxurious"
    if row["AnTuTu_Score"] >= 700000 and row["Chipset_Is_Flagship"] == 1:
        return "TechSavvy"
    if row["AnTuTu_Score"] >= 500000 and row["Price_EUR"] < 500:
        return "FlagshipKiller"
    if row["AnTuTu_Score"] >= 300000:
        return "Reasonable"
    return "Budget"
```

---

## Features

All 120 engineered features (`enable_categorical=True` makes this trivial).

---

## Model spec

```python
import xgboost as xgb

clf = xgb.XGBClassifier(
    objective="multi:softprob",
    num_class=5,
    eval_metric="mlogloss",
    enable_categorical=True,
    max_depth=6,
    n_estimators=400,
    learning_rate=0.05,
    random_state=42,
)
```

---

## Expected outcome

- **Accuracy ≥ 0.80**, **macro-F1 ≥ 0.75** on stratified test.

---

## Defence value

5-class classification on 120 features with native categorical handling is a textbook XGBoost story.