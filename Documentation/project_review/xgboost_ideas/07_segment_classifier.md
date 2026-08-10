# 07 — Segment Classifier (XGBoost, multi-class, cold-start fallback)

> **Use case.** When a brand-new user has no purchase history, classify them
> into a K-Means cluster using only the questionnaire answers.

---

## When to use

- Cold-start path in `/recommend`.
- Saves the "no history → default persona" fallback.

---

## Data

Train on the 4,557 labelled customers:

```python
features = ["age", "gender", "city", "preferred_brand", "preferred_category",
            "interaction_channel", "payment_method", "avg_spend_npr",
            "purchase_frequency_per_year"]
target = "cluster_id"   # 3 classes from K-Means
```

---

## Model spec

```python
import xgboost as xgb

clf = xgb.XGBClassifier(
    objective="multi:softprob",
    num_class=3,
    eval_metric="mlogloss",
    enable_categorical=True,
    max_depth=4,
    n_estimators=150,
    learning_rate=0.1,
    random_state=42,
)
```

---

## Expected outcome

- **Accuracy ≥ 0.70** for the top-1 cluster.
- **Top-2 accuracy ≥ 0.90**.

This is fine because we don't need perfect assignment — we just need a reasonable prior.

---

## Defence value

"Cold-start handling with a learned fallback" is a known problem in
recommender systems. Solving it with a small XGBoost classifier is the
textbook answer.