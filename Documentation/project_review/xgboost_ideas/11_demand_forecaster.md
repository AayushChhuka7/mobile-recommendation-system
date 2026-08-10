# 11 — Demand Forecaster (XGBoost, time-series)

> **Use case.** Predict next-month purchase count per brand per city.

---

## When to use

- Inventory planning.
- Marketing-campaign timing.

---

## Data

Aggregate purchases to monthly:

```python
df["purchase_month"] = df["purchase_date"].dt.to_period("M").astype(str)
monthly = df.groupby(["purchase_month", "mobile_brand_purchased", "city"]).size().reset_index(name="count")
```

Pivot to (city, brand) × month matrix:

```python
pivot = monthly.pivot_table(index=["city", "mobile_brand_purchased"], columns="purchase_month", values="count", fill_value=0)
```

---

## Features per row

- **Lag features:** `count_lag_1`, `count_lag_3`, `count_lag_12`
- **Rolling stats:** `rolling_mean_3`, `rolling_std_3`, `rolling_max_12`
- **Calendar features:** `month_sin`, `month_cos`, `quarter`, `is_holiday_month`
- **Static:** `city`, `brand`, `population` (if available)

---

## Model spec

```python
import xgboost as xgb

reg = xgb.XGBRegressor(
    objective="reg:squarederror",
    enable_categorical=True,
    max_depth=6,
    n_estimators=400,
    learning_rate=0.05,
    random_state=42,
)
```

For a probabilistic forecast, use `reg:gamma` or quantile regression with `objective="reg:quantileerror"` and `quantile_alpha=0.5`.

---

## Expected outcome

- **MAPE ≤ 30%** for monthly counts (highly variable, so 30% MAPE is reasonable).

---

## Defence value

Time-series forecasting is a separate ML sub-discipline. Combining it with
the recommendation story broadens the project.

---

## Caveat

The customer dataset only spans 2020-2026 — 6 years of monthly data per city
× brand = 90 cities × 30 brands × 72 months. The matrix is **sparse** and
**noisy**. Consider aggregating to national level first.