# 08 — Customer Lifetime Value Regressor (XGBoost, regression, gamma loss)

> **Use case.** Predict each customer's 12-month total spend in EUR.

---

## When to use

- Marketing spend allocation.
- "VIP customer" badge on the dashboard.
- Budget prioritisation for the win-back campaign.

---

## Data

```python
df["clv_12m"] = df["avg_purchase_amount_npr"] * df["purchase_frequency_per_year"] * (1 / 150)
df["clv_12m_log"] = np.log1p(df["clv_12m"])
```

This is a **synthetic target** because we don't have a 12-month forward window.
With real data, compute `clv_12m` from the next 12 months of purchases.

---

## Features

All per-customer features (20 numeric + 6 categorical).

---

## Model spec (gamma loss for right-skewed target)

```python
import xgboost as xgb

reg = xgb.XGBRegressor(
    objective="reg:gamma",     # gamma is appropriate for LTV (right-skewed, positive)
    eval_metric="rmse",
    enable_categorical=True,
    max_depth=4,
    n_estimators=200,
    learning_rate=0.05,
    random_state=42,
)
```

Log-transform the target for stability:

```python
y_log = np.log1p(df["clv_12m"])
reg.fit(X, y_log)
pred = np.expm1(reg.predict(X_test))
```

---

## Expected outcome

- **Spearman ρ ≥ 0.65** between predicted and actual LTV (rank correlation is what matters for marketing allocation).
- Decile analysis: top-decile customers have ≥ 3× the spend of bottom-decile.

---

## Defence value

"LTV prediction" is the **most business-impactful** ML problem in any retail context. Bringing it up turns the project from "academic" to "industry-relevant".