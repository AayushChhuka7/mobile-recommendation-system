# 02 — Camera Tier Classifier (XGBoost, multi-class)

> **Use case.** Classify a phone into `CameraPreference` (`Sensible | Photophile | SelfieAddict`)
> from its specs.

---

## When to use

- The catalog UI shows a "Camera tier" badge on every phone.
- The recommender can **boost** `Camera_Score` for users in `Camera_Lover` persona when the tier is `Photophile`.

---

## Data

Synthetic labels from the engineered features:

```python
def label_camera_tier(row):
    if row["Selfie_Camera_MP"] >= 24 and row["Selfie_Camera_MP"] > row["Main_Camera_MP"]:
        return "SelfieAddict"
    if row["Main_Camera_MP"] >= 50 and row["OIS"] == "Yes" and row["Lens_Count"] >= 3:
        return "Photophile"
    return "Sensible"
```

Apply this to `GSMArena_Cleaned_Dataset.csv`.

---

## Features

```python
features = [
    "Main_Camera_MP", "Selfie_Camera_MP", "Lens_Count",
    "Main_Aperture", "OIS", "Camera_4K_Video", "Selfie_4K_Video",
    "Sensor_Size", "Has_HDR", "Has_Panorama", "Has_Color_Spectrum",
    "Brand", "Chipset_Is_Flagship",
]
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
    max_depth=6,
    n_estimators=300,
    learning_rate=0.05,
    random_state=42,
)
```

---

## Expected outcome

- **Accuracy ≥ 0.85**, **macro-F1 ≥ 0.80** on a stratified test split.

---

## Defence value

A second **multi-class** story. The committee hears "we can do regression (AnTuTu) and multi-class classification (Camera tier)". Already stronger than 80% of comparable projects.