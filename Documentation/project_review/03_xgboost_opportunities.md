# 03 — Where XGBoost Can Be Incorporated (12 Ideas)

> **Current state:** XGBoost is used in **exactly one place** — predicting `AnTuTu_Score`
> from engineered phone features in `ML Model/pipeline/train.py`.
>
> **This document lists 12 places** where XGBoost would add genuine value to the project,
> with priority ranking, data requirements, and references to the suggested notebooks.

---

## Headline answer

The single sentence the supervisor wants to hear is:

> *"XGBoost is currently used as a **performance predictor** (AnTuTu regression). The
> natural next step is to use it as a **behaviour predictor** (clicks, conversions,
> churn) and a **ranker** (LambdaMART), which is what production recommenders
> actually do."*

The 12 ideas below are grouped into four buckets:

| Bucket                 | Models | Purpose                                                                |
| ---------------------- | ------ | ---------------------------------------------------------------------- |
| **A. Behaviour**       | 4      | Predict what the user will do (click, churn, convert, buy).            |
| **B. Categorisation**  | 3      | Predict the bucket a phone or user belongs to (tier, loyalty, value). |
| **C. Ranking**         | 2      | Re-rank the candidates given user features.                            |
| **D. Forecasting**     | 3      | Predict the future state of the system (anomaly, demand, LTV).         |

---

## Bucket A — Behaviour (4 models)

These are the highest-value additions because the dataset (`dataset/customer_dataset.csv`)
already has the labels.

### A1. Brand Loyalty Classifier — `xgboost_ideas/01_brand_loyalty_classifier.md`

- **Target:** `is_brand_loyal` (binary). A customer whose every purchase matches `preferred_brand`.
- **Why XGBoost:** handles categorical (`preferred_brand`, `interaction_channel`, `city`) cleanly with `enable_categorical=True`, beats logistic regression on non-linear interactions like `age × purchase_frequency`.
- **Value:** lets the ranker **boost** the user's favourite brand only when `loyalty_prob > 0.7`.

### A2. Wishlist-Conversion Classifier — `xgboost_ideas/12_wishlist_conversion_classifier.md`

- **Target:** `wishlist_conversion_rate > 0` (binary). Whether the customer ever bought from their wishlist.
- **Why XGBoost:** interpretable SHAP shows *what* drives wishlist→purchase (price, brand affinity, accessory_with_phone_count).
- **Value:** identifies high-intent customers for targeted campaigns.

### A3. Review-Rating Predictor — `xgboost_ideas/10_review_rating_predictor.md`

- **Target:** `rating` (1–5 ordinal or regression).
- **Why XGBoost:** ordinal regression is a clean XGBoost problem; SHAP exposes the feature mix that produces 5-star reviews.
- **Value:** lets the system say "users like you rated this phone 4.6/5".

### A4. Churn Predictor — `xgboost_ideas/04_churn_prediction.md`

- **Target:** `recency_days > 365 AND purchase_frequency_per_year < 1.0` (binary).
- **Why XGBoost:** rare-class imbalance handled by `scale_pos_weight`; calibrated probabilities via Platt scaling on the output.
- **Value:** enables a win-back campaign that the current segmentation hints at but doesn't act on.

---

## Bucket B — Categorisation (3 models)

These classify phones and customers into actionable buckets.

### B5. Tech-Tier Classifier — `xgboost_ideas/03_tech_tier_classifier.md`

- **Target:** `TechTier` enum from `schema.prisma`: `Budget | Reasonable | FlagshipKiller | TechSavvy | Luxurious`.
- **Why XGBoost:** multi-class with `multi:softprob`; 5 classes × 120 features is small enough to fit in 2 minutes.
- **Value:** removes the need for the current rule-based `TIER_MAP_5` in `pipeline/scoring.py`.

### B6. Camera-Tier Classifier — `xgboost_ideas/02_camera_tier_classifier.md`

- **Target:** `CameraPreference`: `Sensible | Photophile | SelfieAddict`.
- **Why XGBoost:** tree-based models beat linear baselines on `Main_Camera_MP × Selfie_Camera_MP × OIS × Sensor_Size` interactions.
- **Value:** lets the ranker detect a "camera lover" persona even before the user fills the questionnaire.

### B7. Segment Classifier — `xgboost_ideas/07_segment_classifier.md`

- **Target:** `cluster_id` (3-class from K-Means). Used **as a fallback** when the user has no purchase history.
- **Why XGBoost:** trains on `(age, gender, city, preferred_brand, preferred_category, average_spend_npr)`; classifies new users in 5 ms.
- **Value:** cold-start becomes a single `predict()` call.

---

## Bucket C — Ranking (2 models)

This is the heart of any production recommender.

### C8. Price-Value Regressor — `xgboost_ideas/05_price_value_regressor.md`

- **Target:** `Value_Score` (regression) — a model that learns what makes a phone "good value" from user behaviour.
- **Why XGBoost:** regression with monotonic constraints on `Price_EUR` (higher price → lower value) gives a calibrated, interpretable value curve.
- **Value:** the "Best Value" listing page becomes data-driven instead of hard-coded `(≤ €300, ≥ 6 GB RAM)`.

### C9. Learning-to-Rank (LambdaMART) — `xgboost_ideas/06_lambda_ranker.md`

- **Target:** pairwise rank of phones given `(user_features, phone_features, persona_weights)`.
- **Why XGBoost:** `objective='rank:pairwise'` (or `rank:ndcg`) is built into XGBoost. This is the **same algorithm** used by YouTube, Airbnb, and many production systems.
- **Value:** replaces the current weighted-sum ranker with one that learns the weights from `(query, document, relevance_label)` triplets. This is the **most impactful** addition for the viva.

---

## Bucket D — Forecasting (3 models)

### D10. Anomaly Detector — `xgboost_ideas/09_anomaly_detector.md`

- **Approach:** train an XGBoost regressor on `(phone features → AnTuTu)` and flag residuals > 3σ as anomalies.
- **Value:** catches **mis-labelled or scraped-wrong** entries in `GSMArena_Cleaned_Dataset.csv`.

### D11. Demand Forecaster — `xgboost_ideas/11_demand_forecaster.md`

- **Target:** next-month purchase count per brand per city.
- **Why XGBoost:** temporal features (`month_sin`, `month_cos`, `lag_1`, `lag_3`, `rolling_mean_3`) + brand/city categorical.
- **Value:** stocking decisions for a retailer (if this is commercial).

### D12. LTV Regressor — `xgboost_ideas/08_ltv_regressor.md`

- **Target:** `clv_12m` (12-month customer lifetime value in EUR).
- **Why XGBoost:** regression with `objective='reg:gamma'` (LTV is right-skewed); log-transformed target.
- **Value:** the **highest-leverage business metric** for the viva.

---

## Priority matrix

| ID | Model                          | Data available | Engineering effort | Defence impact | Recommended week |
| -- | ------------------------------ | -------------- | ------------------ | -------------- | ---------------- |
| A1 | Brand Loyalty Classifier       | ✅              | Low                | High           | Week 2           |
| A4 | Churn Predictor                | ✅              | Low                | Very high      | Week 4           |
| C9 | LambdaMART Ranker              | ⚠ need logs    | Medium             | **Highest**    | Week 5           |
| B5 | Tech-Tier Classifier           | ✅              | Low                | Medium         | Week 2           |
| B6 | Camera-Tier Classifier         | ✅              | Low                | Medium         | Week 2           |
| A3 | Review-Rating Predictor        | ✅              | Low                | Medium         | Week 4           |
| A2 | Wishlist-Conversion Classifier | ✅              | Low                | Medium         | Week 4           |
| D12| LTV Regressor                  | ✅              | Low                | Very high      | Week 4           |
| B7 | Segment Classifier (fallback)  | ✅              | Low                | Low            | Week 6           |
| C8 | Price-Value Regressor          | ✅              | Low                | Medium         | Week 4           |
| D11| Demand Forecaster              | ✅              | Medium             | Low            | Week 8           |
| D10| Anomaly Detector               | ✅              | Low                | Low            | Week 9           |

---

## Suggested implementation order (matches `01_project_audit.md` plan)

1. **Week 2:** A1 (Brand Loyalty), B5 (Tech Tier), B6 (Camera Tier). These three reuse the engineered 120-feature frame and train in <5 min each.
2. **Week 4:** A4 (Churn), A2 (Wishlist Conv), A3 (Rating), D12 (LTV), C8 (Price-Value).
3. **Week 5:** C9 (LambdaMART) — this needs synthetic `(query, doc, label)` triplets until you have logs.
4. **Week 6:** B7 (Segment Classifier) — fast.
5. **Week 8:** D11 (Demand) — needs time-series reshape.
6. **Week 9:** D10 (Anomaly) — uses the existing AnTuTu booster.

---

## How each model plugs into the current system

| Model           | New FastAPI route          | Existing Prisma table          | UI surface                      |
| --------------- | -------------------------- | ------------------------------ | ------------------------------- |
| Brand Loyalty   | `/predict/brand-loyalty`   | `CustomerProfile`              | "Loyalty: High" badge           |
| Churn           | `/predict/churn`           | `RecommendationHistory`        | Win-back banner                 |
| LambdaMART      | `/recommend` (replaces)    | `RecommendationEvent` (new)    | Re-ranked list                  |
| Tech Tier       | `/predict/tech-tier`       | `Phones.antutuScore` (denorm)  | Tier chip on listing            |
| Camera Tier     | `/predict/camera-tier`     | `Phones`                       | Camera tier chip                |
| Rating          | `/predict/rating`          | `RecommendationHistory.rating` | "Predicted 4.6/5" tooltip       |
| Wishlist Conv   | `/predict/wishlist-conv`   | `Wishlist`                     | Conversion-likelihood badge     |
| LTV             | `/predict/ltv`             | `CustomerProfile`              | "High-value" badge              |
| Segment         | `/predict/segment`         | `CustomerProfile`              | "Your segment" tile             |
| Price-Value     | `/predict/value`           | `Phones`                       | "Value score" on listing        |
| Demand          | `/predict/demand`          | `AdminStatsCache`              | (admin only)                    |
| Anomaly         | (internal)                 | `PhoneSpecs`                   | (admin only)                    |

---

## What the SHAP story looks like for each

| Model          | Global SHAP plot location                    | Per-prediction SHAP                  |
| -------------- | -------------------------------------------- | ------------------------------------ |
| AnTuTu         | `artifacts/shap_summary_antutu.png` (TODO)   | `Why: ["AnTuTu_Score_is_imputed=False (+12%)", ...]` (current) |
| Brand Loyalty  | `artifacts/shap_summary_brand_loyalty.png`   | "Brand-loyal because of tenure_days + age_bucket" |
| Churn          | `artifacts/shap_summary_churn.png`           | "Likely to churn because of recency_days + accessory_spend_npr" |
| LambdaMART     | partial-dependence plot per dimension        | n/a (ranker, not classifier)         |
| Tech Tier      | `artifacts/shap_summary_tech_tier.png`       | "Predicted 'Flagship' because AnTuTu + Chipset_Is_Flagship" |
| LTV            | `artifacts/shap_summary_ltv.png`             | "High-LTV because of tenure + frequency + accessory spend" |

---

## The one-sentence viva answer

> "We use XGBoost in **twelve different roles** — performance regression (AnTuTu),
> brand-loyalty classification, churn risk, learning-to-rank, tech-tier classification,
> camera-tier classification, price-value regression, wishlist-conversion prediction,
> LTV regression, segment fallback classification, demand forecasting, and anomaly
> detection — and every model has a SHAP explanation layer for interpretability."

That sentence alone moves the project from "BCT minor" to "research-grade".