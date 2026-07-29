# 01 — Brand Loyalty Classifier (XGBoost, binary)

> **Use case.** Predict whether a customer is loyal to a brand (`mobile_brand_purchased`
> matches `preferred_brand` for every transaction).

---

## When to use

- The recommender wants to **boost** a user's preferred brand when loyalty probability is high.
- Marketing wants to **target** loyal customers with brand-specific campaigns.

---

## Data

`dataset/customer_dataset.csv` after per-customer aggregation:

```python
features = [
    "age", "gender", "city",
    "n_purchases", "total_spend_npr", "avg_purchase_amount_npr",
    "purchase_frequency_per_year", "avg_rating",
    "recency_days", "tenure_days",
    "accessory_count", "accessory_spend_npr",
    "browsing_count", "wishlist_count",
    "interaction_channel", "payment_method", "warranty_opted",
]
target = "brand_loyal"  # already computed in customer_segmentation_continuation.ipynb
```

---

## Model spec

```python
import xgboost as xgb

clf = xgb.XGBClassifier(
    objective="binary:logistic",
    enable_categorical=True,
    tree_method="hist",
    max_depth=4,
    n_estimators=200,
    learning_rate=0.05,
    subsample=0.8,
    colsample_bytree=0.8,
    reg_lambda=2.0,
    scale_pos_weight=2.0,   # brand_loyal is imbalanced
    random_state=42,
    early_stopping_rounds=20,
)
```

---

## Expected outcome

- **AUC ≥ 0.80**, given the strong signal in `n_purchases`, `tenure_days`, and `preferred_brand`-derived features.
- SHAP top features: `n_purchases`, `tenure_days`, `interaction_channel`, `wishlist_count`.

---

## FastAPI integration

```python
# /predict/brand-loyalty
@app.post("/predict/brand-loyalty")
def predict_brand_loyalty(req: BrandLoyaltyRequest):
    df = pd.DataFrame([req.features])
    proba = brand_loyalty_model.predict_proba(df)[0, 1]
    shap_pairs = brand_loyalty_model.explain_one(df)
    return {"loyalty_probability": proba, "top_features": shap_pairs}
```

## Prisma integration

Add a column:

```sql
ALTER TABLE customer_profile ADD COLUMN brand_loyalty_prob DECIMAL(5, 4);
```

Or compute on demand.

---

## Notebook template

See `notebooks/01_xgb_classifier_brand_loyalty.ipynb.template.md`.

---

## Defence value

A clean **classification** story complements the regression story. The committee will ask "you only have one model — show me you can do classification too". This is the answer.