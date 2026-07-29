# 04 — Explainability & XAI

> The project already has SHAP for **one** model (the AnTuTu regressor).
> This document specifies the full XAI stack that should be in place by defence time.

---

## 1. What already exists

- `shap.TreeExplainer` is built lazily in `MobileRecommendationPipeline._get_explainer`.
- `predict()` returns SHAP values implicitly through `explain()`.
- `serve.py` has `/explain/{model_name}` and `/predict` that return top-N SHAP pairs.
- `recommendService.mjs` forwards the `Why` array of strings to the frontend.

The wiring is correct; the **breadth** is not.

---

## 2. The five layers of XAI the project should have

### 2.1 Global feature importance

| Method                     | Output                              | Where it goes                |
| -------------------------- | ----------------------------------- | ---------------------------- |
| **SHAP summary plot**      | Beeswarm of all features            | `Documentation/shap/01_<model>_summary.png` |
| **SHAP bar plot**          | Mean absolute SHAP per feature      | Same folder                  |
| **Permutation importance** | Holdout-set importance              | `artifacts/<model>_perm.json` |
| **XGBoost built-in `plot_importance`** | Gain, weight, cover     | `Documentation/xgb/01_<model>_importance.png` |
| **Partial Dependence (PDP)** | Marginal effect of one feature    | `Documentation/shap/01_<model>_pdp_<feature>.png` |

### 2.2 Local explanation (per prediction)

| Method                     | Output                              | Use case                      |
| -------------------------- | ----------------------------------- | ----------------------------- |
| **SHAP force plot**        | Single row's push from base value   | Tooltip on a phone card       |
| **SHAP waterfall**         | Step-by-step feature contributions   | Admin debug view              |
| **SHAP decision plot**     | Per-tree path through the booster    | Notebook only                 |
| **LIME**                   | Local linear surrogate              | A/B test vs SHAP              |
| **Counterfactual**         | "What would have to change to flip the prediction?" | "Show me a cheaper phone with the same prediction" |

### 2.3 Global behaviour summary

| Method                     | Output                              |
| -------------------------- | ----------------------------------- |
| **SHAP interaction values** | Pairwise SHAP interactions          |
| **Tree surrogate**         | Distill XGBoost into a single decision tree (1-2 levels deep) |
| **Spurious-correlation audit** | SHAP + adversarial samples     |

### 2.4 Counterfactual & contrastive

| Method                     | Output                              |
| -------------------------- | ----------------------------------- |
| **DiCE**                   | Diverse counterfactual explanations |
| **Anchors**                | High-precision if-then rules        |
| **SHAP contrastive**       | "Why this phone and not that one?"  |

### 2.5 Fairness & robustness

| Method                     | Output                              |
| -------------------------- | ----------------------------------- |
| **Demographic parity**     | P(prediction | group) across `gender`/`city`/`age_bucket` |
| **Equalised odds**         | TPR/FPR across groups                |
| **SHAP distribution per group** | Beeswarm split by `gender`        |
| **Adversarial perturbation** | Robustness check                   |

---

## 3. Where each layer should live in the codebase

| Layer                   | Python module (suggested)                  | FastAPI route        |
| ----------------------- | ------------------------------------------ | -------------------- |
| Global feature importance | `ml_models/<model>/explain/global.py`    | `/explain/global/<model>` |
| Local explanation       | `pipeline/model.py:explain()` (current)    | `/explain/{model_name}` (current) |
| PDP                     | `ml_models/<model>/explain/pdp.py`         | `/explain/pdp/<model>` |
| Counterfactual          | `ml_models/<model>/explain/counterfactual.py` | `/explain/counterfactual/<model>` |
| Fairness                | `ml_models/<model>/explain/fairness.py`    | `/explain/fairness/<model>` |

The `shap_tooltip_builder.py` example in `example_code/` shows how to render the SHAP pairs as a frontend tooltip.

---

## 4. Suggested human-evaluation study

Even a small study adds enormous defence value:

1. Recruit 15 users.
2. Show each user 10 recommendations **with** SHAP and **without** SHAP.
3. Ask: "Which explanation is more useful? Which one do you trust more? Which one would make you buy?"
4. Measure: Likert 1-5 on usefulness, trust, persuasiveness.
5. Report: mean ± std, paired t-test, win-rate.

The cost is one afternoon. The defence value is **enormous**.

---

## 5. Concrete SHAP additions for the existing AnTuTu model

In addition to the current top-N SHAP, add:

- `artifacts/shap_summary_antutu.png` — beeswarm
- `artifacts/shap_bar_antutu.png` — mean |SHAP|
- `artifacts/shap_pdp_antutu.png` — PDP on top 3 features
- `artifacts/shap_interaction_antutu.png` — interaction values for top 2
- `artifacts/shap_force_antutu_<phone>.png` — force plot per brand tier

These are **30 lines of code** using `shap.summary_plot`, `shap.plots.bar`, `shap.partial_dependence_plot` etc.

See `example_code/shap_explainer_factory.py` for a reusable helper.

---

## 6. SHAP for ranking models (LambdaMART)

When you add the LambdaMART model (see `xgboost_ideas/06_lambda_ranker.md`), the SHAP story is different — rankers don't have a single output to explain. Use:

- **Tree SHAP** with `interventional` feature perturbation: gives a feature attribution per `query × document` pair.
- **NDCG-explanation**: For each document, compute the SHAP value of moving it up by one rank.
- **Group SHAP**: Aggregate SHAP values by query to see "what makes a query rank well".

This is **state-of-the-art** in 2025 IR literature and would be the headline result of a paper.

---

## 7. LIME vs SHAP: when to use which

| Use SHAP                          | Use LIME                          |
| --------------------------------- | --------------------------------- |
| Tree models (XGBoost, LightGBM)   | Black-box models (Neural Nets, KNNs) |
| When you need **consistency**     | When you need **speed**            |
| When global + local both matter   | When only local explanations matter |
| When features are not too many    | When features are high-dimensional (text, images) |

For this project (XGBoost on tabular), SHAP is the right default. LIME is included for the human-evaluation A/B test.

---

## 8. ELI5

`eli5` has `explain_prediction_xgboost` that produces the same info as SHAP force plot but with a slightly different UI. Useful as a **second opinion** during development, not for production.

---

## 9. Counterfactual generation (DiCE)

For the `/recommend` endpoint, after returning a ranked list, also return for the **top phone**:

```json
{
  "counterfactual": {
    "phone_A": "iPhone 16 Pro Max",
    "flip_to": "iPhone 15 Pro Max",
    "feature_changes": ["-100 EUR", "−6 GB RAM", "−1 yr newer"],
    "predicted_score_change": "+0.0 (still top-1)"
  }
}
```

Implementation: `dice-ml` (Microsoft) or a manual perturbation loop. See `example_code/counterfactual.py` (TODO if you want to add it).

---

## 10. Anchors

`alibi` has `AnchorTabular` that produces high-precision if-then rules:

> "If `AnTuTu_Score > 800000` AND `Chipset_Is_Flagship = 1` AND `5G_Support = 'Yes'`, then this phone is 'Premium' with 95% precision."

These are **extremely persuasive** in a viva. "The model says Premium because of three rules, and the rules are correct 95% of the time."

---

## 11. Checklist for the defence

- [ ] SHAP summary for every XGBoost model
- [ ] PDP for the top 3 features of every model
- [ ] One SHAP force plot for each of the 9 personas
- [ ] Counterfactual example for at least one persona
- [ ] LIME vs SHAP comparison on 5 examples
- [ ] Fairness audit across `gender` and `city`
- [ ] Human-eval study (15 users, 10 recommendations)
- [ ] All plots in `Documentation/shap/` and referenced in the final report

Even **half** of these is more than 90% of comparable BCT projects.