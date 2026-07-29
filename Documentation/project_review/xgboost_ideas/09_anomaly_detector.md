# 09 — Anomaly Detector (XGBoost residual analysis)

> **Use case.** Find phones whose AnTuTu score is wildly different from what
> the model predicts — likely scraping errors or mis-labels.

---

## When to use

- Data-quality dashboard.
- Catches wrong entries in the GSMArena CSV before they pollute training.

---

## Method

Train the AnTuTu regressor as normal. Compute residuals on a held-out set:

```python
y_pred = booster.predict(X_test)
residuals = y_test - y_pred
mean = residuals.mean()
std = residuals.std()

# Flag anomalies
df_test["anomaly_score"] = (residuals - mean) / std
df_test["is_anomaly"] = (df_test["anomaly_score"].abs() > 3).astype(int)
```

Or train a one-class XGBoost:

```python
from sklearn.svm import OneClassSVM
# or
from sklearn.ensemble import IsolationForest

iso = IsolationForest(contamination=0.05, random_state=42)
labels = iso.fit_predict(X)
df["is_anomaly"] = (labels == -1).astype(int)
```

---

## Expected outcome

- 5% of phones flagged.
- Manual inspection shows: scraped-with-error (AnTuTu 0 but AnTuTu_Is_Imputed=False), missing price, etc.

---

## Defence value

"Data-quality via residual analysis" is a real engineering pattern. The committee will appreciate the rigour.