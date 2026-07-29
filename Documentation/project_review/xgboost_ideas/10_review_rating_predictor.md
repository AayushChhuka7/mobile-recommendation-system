# 10 — Review Rating Predictor (XGBoost, ordinal regression)

> **Use case.** Predict the rating (1–5) a customer will give to a phone
> before they purchase it.

---

## When to use

- The "Predicted 4.6/5 ★" badge on a phone card.
- A signal in the ranker.

---

## Data

Use the customer's **historical** rating for the same brand / category:

```python
df["avg_rating_for_brand"] = df.groupby(["customer_id", "mobile_brand_purchased"])["rating"].transform("mean")
df["avg_rating_for_category"] = df.groupby(["customer_id", "preferred_category"])["rating"].transform("mean")
```

Target = the actual rating given to this purchase (1-5).

---

## Model spec

Ordinal regression with XGBoost:

```python
import xgboost as xgb

reg = xgb.XGBRegressor(
    objective="reg:squarederror",
    enable_categorical=True,
    max_depth=4,
    n_estimators=200,
    learning_rate=0.05,
    random_state=42,
)
# Clip predictions to [1, 5]
pred = np.clip(reg.predict(X_test), 1, 5)
```

For a true ordinal classifier, use:

```python
clf = xgb.XGBClassifier(
    objective="multi:softprob",
    num_class=5,
    enable_categorical=True,
)
```

---

## Expected outcome

- **MAE ≤ 0.6 stars** (1-5 scale).
- Within ±1 star: ≥ 90% of the time.

---

## Defence value

"This phone gets 4.6 stars from users like you" is a powerful UX claim. It's also a clean regression story.