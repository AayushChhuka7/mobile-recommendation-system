# Project Review — Customer Segmentation & Intelligent Mobile Recommendation System

> **Scope.** This folder is a **read-only review** of the project at
> `F:\sus transfer\BCT resources\6th semester\Minor_Project\mobile-recommendation-system`.
> No file in the existing project was modified, overwritten, or refactored.
> Everything here is suggestion, template, or example only.

---

## 0. What is in this folder

```
project_review/
├── README.md                       <- you are here
├── 00_executive_summary.md         <- one-page TL;DR for the supervisor
├── 01_project_audit.md             <- what the project is, what is good, what is missing
├── 02_architecture_review.md       <- ML + backend + frontend review
├── 03_xgboost_opportunities.md     <- 12 places XGBoost can be added (the headline ask)
├── 04_explainability_xai.md        <- SHAP, LIME, ELI5, anchor, counterfactuals
├── 05_mlops_production_readiness.md<- testing, CI, drift, registry, monitoring
├── 06_research_paper_extensions.md <- what would make this a publishable paper
├── 07_dataset_quality_report.md    <- gaps, leakage risks, label noise
├── 08_recommendation_quality.md    <- offline metrics, ranking eval, A/B plan
├── 09_segmentation_improvements.md <- beyond K-Means: GMM, SOM, RFM, LTV
├── 10_frontend_ux_review.md        <- trust, SHAP display, segment display
├── 11_security_compliance.md       <- PII, GDPR, OWASP, secrets
├── 12_thesis_defense_checklist.md  <- viva questions + how to answer them
│
├── diagrams/                       <- Mermaid / ASCII architecture & flow diagrams
│   ├── 01_current_system.mmd
│   ├── 02_target_system.mmd
│   ├── 03_ml_lifecycle.mmd
│   ├── 04_recommendation_flow.mmd
│   ├── 05_xgboost_taxonomy.md
│   ├── 06_segmentation_pipeline.mmd
│   └── 07_data_lineage.mmd
│
├── notebooks/                      <- copy-paste-ready Jupyter notebooks (templates only)
│   ├── 01_xgb_classifier_brand_loyalty.ipynb.template.md
│   ├── 02_xgb_classifier_camera_tier.ipynb.template.md
│   ├── 03_xgb_ranker_lambda.ipynb.template.md
│   ├── 04_xgb_churn_prediction.ipynb.template.md
│   ├── 05_xgb_classifier_tech_tier.ipynb.template.md
│   ├── 06_xgb_price_value_regression.ipynb.template.md
│   └── 07_shap_dashboard.ipynb.template.md
│
├── example_code/                   <- runnable example Python modules (templates only)
│   ├── README.md
│   ├── xgb_brand_loyalty_classifier.py
│   ├── xgb_lambda_ranker.py
│   ├── xgb_churn_model.py
│   ├── xgb_camera_tier.py
│   ├── xgb_ltv_regression.py
│   ├── shap_explainer_factory.py
│   ├── shap_tooltip_builder.py
│   ├── drift_detector.py
│   ├── fairness_audit.py
│   └── segment_feature_drift.py
│
├── sql/                            <- Prisma + raw SQL suggestions (NOT to be applied)
│   ├── README.md
│   ├── 01_segment_table.sql
│   ├── 02_segment_membership.sql
│   ├── 03_recommendation_log.sql
│   ├── 04_model_registry.sql
│   ├── 05_drift_log.sql
│   └── 06_user_recommendation_pre_agg.sql
│
├── reports/                        <- blank report templates you can fill in
│   ├── model_card_template.md
│   ├── data_card_template.md
│   ├── ab_test_plan_template.md
│   └── fairness_report_template.md
│
└── xgboost_ideas/                  <- the 12 ideas, one file per idea
    ├── README.md
    ├── 01_brand_loyalty_classifier.md
    ├── 02_camera_tier_classifier.md
    ├── 03_tech_tier_classifier.md
    ├── 04_churn_prediction.md
    ├── 05_price_value_regressor.md
    ├── 06_lambda_ranker.md
    ├── 07_segment_classifier.md
    ├── 08_ltv_regressor.md
    ├── 09_anomaly_detector.md
    ├── 10_review_rating_predictor.md
    ├── 11_demand_forecaster.md
    └── 12_wishlist_conversion_classifier.md
```

---

## 1. How to read this review

There are three audiences:

| If you are a…               | Read these files                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| Supervisor / examiner       | `00_executive_summary.md`, `12_thesis_defense_checklist.md`, `03_xgboost_opportunities.md`                |
| Project team / co-authors   | `01_project_audit.md`, `02_architecture_review.md`, `09_segmentation_improvements.md`                      |
| Future you (after the viva) | `05_mlops_production_readiness.md`, `06_research_paper_extensions.md`, `08_recommendation_quality.md`     |

Everything in this folder is **proposal-grade**. None of it is applied to the live project.

---

## 2. High-level takeaways

1. **The project is already well-engineered for a BCT minor.** The XGBoost-on-AnTuTu pipeline is clean (R² ≈ 0.85, 5-fold CV), SHAP is wired in, and there is a real persona-based recommender. That is above-average for the course.
2. **XGBoost is currently used in exactly one place** — predicting `AnTuTu_Score` from phone specs. There are **at least 12 natural places** where an XGBoost model would add value (see `xgboost_ideas/`).
3. **Interpretability is half-done.** SHAP is used to explain AnTuTu predictions, but no other model has any explanation layer. There is also no fairness audit, no drift monitor, no model registry, no A/B test harness.
4. **The segmentation notebook produces artefacts but never wires them back.** There is no Prisma migration, no Node route, no React page that reads `cluster_profiles.json`.
5. **For a thesis defence, the project can be re-framed** as a four-layer system (data → XGBoost predictors → K-Means segmentation → SHAP explainability) instead of "one model + one clustering". The re-framing alone improves the viva.

The detailed analysis lives in the numbered markdown files in this folder.