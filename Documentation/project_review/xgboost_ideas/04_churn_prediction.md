# 04 — Churn Predictor (XGBoost, binary, imbalanced)

> **Use case.** Predict which customers are at risk of churning (no purchase
> in the last 365 days AND low purchase frequency).

---

## When to use

- The CRM dashboard shows "At Risk" customers.
- Marketing runs a win-back campaign with a coupon.

---

## Data

```python
df["churn"] = ((df["recency_days"] > 365) & (df["purchase_frequency_per_year"] < 1.0)).astype(int)
print(df["churn"].mean())  # expect ~30-40% positive class
```

---

## Features

All per-customer behavioural features (20 numeric + 6 categorical).

---

## Model spec

```python
import xgboost as xgb

clf = xgb.XGBClassifier(
    objective="binary:logistic",
    eval_metric="aucpr",          # PR-AUC is more informative for imbalanced
    enable_categorical=True,
    max_depth=4,
    n_estimators=200,
    learning_rate=0.05,
    scale_pos_weight=(1 - y.mean()) / y.mean(),   # auto-balance
    random_state=42,
    early_stopping_rounds=20,
)
```

After fitting, **calibrate** with Platt scaling:

```python
from sklearn.calibration import CalibratedClassifierCV
calibrated = CalibratedClassifierCV(clf, method="sigmoid", cv=5)
calibrated.fit(X_train, y_train)
```

This makes the predicted probability interpretable (e.g., "70% likely to churn").

---

## Expected outcome

- **PR-AUC ≥ 0.60**, **calibrated Brier score ≤ 0.20**.

---

## SHAP story

The most important SHAP features for churn:

- `recency_days` (positive contributor)
- `purchase_frequency_per_year` (negative contributor)
- `tenure_days` (negative — long-tenured customers don't churn)
- `interaction_channel == "WhatsApp"` (mixed signal)

This gives a marketing team a **debug tool**: "Why is this customer flagged? Because they haven't purchased in 800 days and only buy 0.8 times/year."

---

## Defence value

Imbalanced binary classification with calibrated probabilities is a real-world ML problem. The committee will be impressed by the framing.