# 12 — Wishlist-Conversion Classifier (XGBoost, binary)

> **Use case.** Predict whether a customer who adds a phone to their wishlist
> will end up purchasing it.

---

## When to use

- Identify high-intent wishlist items → trigger a "Complete your purchase" email.
- Boost in the ranker if the user has a wishlist-conversion-prone profile.

---

## Data

```python
# Per wishlist-item:
df["wishlist_added_to_purchased"] = ...   # 1 if the same customer_id bought this model within 90 days
```

This requires joining the wishlist JSON with the purchase history.

---

## Features

- Wishlist item price
- Customer `avg_spend_npr`, `purchase_frequency_per_year`
- `preferred_brand == wishlist_brand`
- `recency_days` at wishlist-add time
- Days since wishlist added

---

## Model spec

```python
import xgboost as xgb

clf = xgb.XGBClassifier(
    objective="binary:logistic",
    eval_metric="auc",
    enable_categorical=True,
    max_depth=4,
    n_estimators=200,
    learning_rate=0.05,
    scale_pos_weight=4.0,    # wishlist→purchase is rare
    random_state=42,
)
```

---

## Expected outcome

- **AUC ≥ 0.70**.
- Top-decile precision ≥ 0.5 (half of flagged items really do convert).

---

## Defence value

"Intent prediction" is a powerful capability. Combined with the LTV model,
it enables "show me customers with high LTV AND high wishlist-conversion
probability" — a clear marketing segment.