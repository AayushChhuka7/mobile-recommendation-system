# 05 — Price-Value Regressor (XGBoost, regression with monotonic constraint)

> **Use case.** Predict the "value" of a phone — high specs at low price — from
> the same features the rule-based `Value_Score` uses, but learned.

---

## When to use

- Replace the current rule `Value_Ratio = Overall_Score / log1p(Price_EUR)`.
- The "Best Value" listing page becomes data-driven.

---

## Data

Train target = current `Value_Score` from `compute_scores()`. This is a
self-supervised signal — the model learns to reproduce the rule, then it can
be re-trained on user clicks later for a learned value.

---

## Features

All 120 engineered features.

---

## Model spec (key trick: monotonic constraint)

```python
import xgboost as xgb

reg = xgb.XGBRegressor(
    objective="reg:squarederror",
    enable_categorical=True,
    max_depth=6,
    n_estimators=300,
    learning_rate=0.05,
    random_state=42,
    # Monotonic: higher Price_EUR → lower Value_Score
    monotone_constraints={"Price_EUR": -1, "AnTuTu_Score": +1, "RAM_GB": +1},
)
```

The `monotone_constraints` argument tells XGBoost to never let `Price_EUR` have a positive marginal effect on `Value_Score`. This is the right business rule.

---

## Expected outcome

- **R² ≥ 0.85** on the rule-based signal (regression to the median).
- After retraining on click data: **NDCG@10 lift of 5-10%** vs the rule-based ranking.

---

## Defence value

"Monotonic constraints in tree models" is a non-trivial concept. Bringing it up unprompted will score big.