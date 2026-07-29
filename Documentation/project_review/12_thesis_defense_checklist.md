# 12 — Thesis Defence Checklist

> The 25 questions a viva panel is most likely to ask, with one-sentence answers
> drawn from this folder. Use these to rehearse.

---

## 1. The "what is this" warm-up

**Q1. "Walk me through the system in 60 seconds."**

> *A customer-facing web app in React, a Node.js REST API in Express+Prisma
> talking to PostgreSQL, and a Python FastAPI sidecar that loads an XGBoost
> model with SHAP explainability and serves the top-N phones for a persona
> + budget.*

**Q2. "What is the role of the dataset?"**

> *`GSMArena_Cleaned_Dataset.csv` (8,500 phones) trains the XGBoost AnTuTu
> regressor and the composite 11-dimension scorer. `customer_dataset.csv`
> (16,608 transactions, 4,557 customers) drives the segmentation.*

**Q3. "Why XGBoost specifically?"**

> *Tabular data with mixed numeric and 28 categorical features, target is
> non-linear (AnTuTu depends on Chipset family × RAM × Refresh Rate), and
> XGBoost is the de-facto best model on tabular data with native categorical
> support and SHAP integration.*

---

## 2. The methodology probe

**Q4. "How did you split train/test?"**

> *80/20 random split with `random_state=42`; 5-fold cross-validation gave
> mean R² = 0.850 ± 0.016, which is stable.*

**Q5. "Why log-transform the target?"**

> *AnTuTu scores span 200k to 1.4M. A log-target compresses the high end,
> which prevents the model from being dominated by flagship phones and
> improves residual normality.*

**Q6. "How do you handle a new chip family the model has never seen?"**

> *`CategoricalDtypeManager` freezes the training categories; any
> predict-time category outside that set becomes NaN, which XGBoost
> treats as a missing-value branch — no crash, sensible prediction.*

**Q7. "What about data leakage?"**

> *We drop `AnTuTu_Score`, `AnTuTu_Score_Source`, and the
> `*_is_imputed` provenance columns before training. The CV is on
> the same matrix, so no test data leaks.*

---

## 3. The persona + recommendation probe

**Q8. "Where do the persona weights come from?"**

> *Hand-tuned presets in `pipeline/recommend.py` — `Gamer` weights
> Gaming 1.0, Camera 0.3, etc. They are explicit and editable; the
> UI also lets users override them with a 1-5 star slider.*

**Q9. "Why not learn the weights from data?"**

> *That's the next step — a LambdaMART ranker trained on
> `(user, phone, persona, label=clicked)` triples. We have not
> shipped it yet because we do not have logged clicks; the synthetic
> labels would not be honest.*

**Q10. "What happens when a new user with no history asks for recommendations?"**

> *Cold-start uses persona + budget only. The future Segment
> Classifier (`xgboost_ideas/07_segment_classifier.md`) will assign
> a cluster from `(age, gender, city, preferred_brand,
> preferred_category, average_spend_npr)` in 5 ms.*

**Q11. "How do you know the recommendations are good?"**

> *We compute offline NDCG@10, MAP@10, MRR on a time-based split once
> we have click labels in `RecommendationEvent`. Today, no logged
> feedback exists, so we have no NDCG yet — this is the biggest gap.*

---

## 4. The SHAP / XAI probe

**Q12. "Why SHAP and not LIME?"**

> *SHAP is consistent (matches the model's actual contributions)
> and works natively with tree models. LIME is a local linear
> surrogate — faster but not faithful. We use SHAP for the
> production explanation; LIME is reserved for a planned A/B
> human-evaluation study.*

**Q13. "Give me an example of a SHAP explanation."**

> *"For iPhone 16 Pro Max, the AnTuTu prediction is +0.4 above the
> mean. SHAP attributes +0.6 to Chipset_Is_Flagship, +0.3 to RAM_GB,
> and −0.5 to Price_EUR (a flagship cost). The base value is the
> dataset mean AnTuTu of ~700k."*

**Q14. "Do you audit for fairness?"**

> *Not yet. `gender`, `city`, `age_bucket` are all in the data;
> we have not measured demographic parity or equalised odds.
> This is in the next-12-weeks plan.*

---

## 5. The segmentation probe

**Q15. "Why K-Means and not GMM or DBSCAN?"**

> *K-Means is fast, interpretable, and produces a model artefact
> the backend can reload. The silhouette is 0.13 — weak. We plan
> to switch to GMM with full covariance and 4 components for
> better cluster shapes.*

**Q16. "How do you pick k?"**

> *Max Calinski-Harabasz over k ∈ [2, 10] subject to a
> min-cluster-share guard of 5% and a min-k guard of 3.
> The chosen k=3 has silhouette 0.13, CH 831.*

**Q17. "Why are the cluster names sometimes misleading?"**

> *The auto-labeler uses heuristic spend thresholds; cluster 0
> is named "Premium" but its mean spend (170k NPR) is mid-range
> globally. We plan to switch to quantile-based tier labels.*

**Q18. "Is the segmentation stable across re-runs?"**

> *With `random_state=42`, yes — bit-identical. Across bootstrap
> resamples, ARI is likely 0.6-0.8. We have not measured it
> yet; that is in `09_segmentation_improvements.md`.*

---

## 6. The deployment / engineering probe

**Q19. "How do you deploy this?"**

> *`docker-compose up` brings up Postgres, the Node backend, the
> Python ML service, and the React frontend. The first boot
> runs the db-init job which pushes the Prisma schema, seeds
> RBAC roles, and bulk-imports the GSMArena CSV.*

**Q20. "What happens if the ML service is down?"**

> *`/recommend` returns 503 after 8 seconds (the timeout in
> `recommendService.mjs`). The frontend should show "ML service
> temporarily unavailable, retry in a moment."*

**Q21. "Where do you keep the trained model?"**

> *In `ML Model/artifacts/` — `model.json`, `feature_columns.json`,
> `category_dtypes.json`, `scoring_snapshot.json`, and
> `training_report.json`. There is no versioning yet; overwriting
> is a known risk.*

**Q22. "What about model monitoring?"**

> *`/health` exposes `model_loaded` and `candidates_count`. We
> plan to add a feature-drift monitor (PSI per column) and
> per-request latency histograms.*

---

## 7. The "why this is good" probe

**Q23. "What is the strongest result?"**

> *XGBoost AnTuTu regressor: test R² 0.852, 5-fold CV 0.850 ± 0.016,
> MAE 0.19 in log space — production-ready.*

**Q24. "What is the weakest result?"**

> *Customer segmentation silhouette 0.13 — clusters overlap.
> We plan to switch to GMM and add bootstrap stability.*

**Q25. "If you had one more month, what would you add?"**

> *A LambdaMART learning-to-rank model with synthetic or logged
> labels, plus a small human-evaluation study comparing SHAP and
> LIME explanations. That is the publishable paper.*

---

## 8. Three sentences to memorise

If you can say these three sentences fluently, you have the viva won.

> *"The system recommends smartphones by combining an XGBoost AnTuTu
> regressor (R² 0.85) with a weighted-sum persona ranker, and explains
> every prediction with SHAP."*

> *"Customer segmentation uses K-Means with frozen StandardScaler
> quantiles; the chosen k=3 has silhouette 0.13 — below the
> reasonable threshold — which is why the next iteration will use
> GMM and bootstrap stability checks."*

> *"The biggest open problem is offline evaluation: we do not yet have
> logged clicks, so we cannot report NDCG@K. Adding a
> `RecommendationEvent` log and a time-based offline-eval harness
> is the highest-priority next step."*

---

## 9. Five slides to have ready

| Slide | Content                                                          |
| ----- | ---------------------------------------------------------------- |
| 1     | System architecture (3 services + Postgres + Docker)             |
| 2     | XGBoost pipeline + 5-fold CV result (R² 0.85)                   |
| 3     | SHAP example on one phone (force plot)                          |
| 4     | Segmentation PCA + cluster sizes + labels (with caveat)         |
| 5     | Future work (12-week plan from `01_project_audit.md`)           |

If you only have time for five slides, use these.