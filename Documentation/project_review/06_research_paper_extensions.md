# 06 — Research-Paper Extensions

> The project is at the boundary between "BCT minor" and "workshop paper".
> This document specifies the experiments that would make it publishable at
> venues like **RecSys (Reproducibility track)**, **KDD (Applied Data Science)**,
> or **ICAART**, or a strong **NCE undergraduate research journal**.

---

## 1. Framing — the "research question"

Most BCT minor projects die at the viva because they don't have a research question.
Pick one of these:

| Q# | Question                                                                                   |
| -- | ------------------------------------------------------------------------------------------ |
| Q1 | *"Does a learned ranker (LambdaMART) outperform a hand-tuned weighted-sum ranker for smartphone recommendation when trained on synthetic user feedback?"* |
| Q2 | *"Does adding brand-loyalty classification as a re-ranking signal improve click-through rate on a smartphone catalogue?"* |
| Q3 | *"Are SHAP explanations more persuasive to users than LIME explanations for smartphone recommendations?"* |
| Q4 | *"Does Gaussian Mixture segmentation produce more actionable customer segments than K-Means for downstream marketing?"* |
| Q5 | *"Does adding wishlist-conversion prediction as a re-ranking signal improve wishlist → purchase conversion?"* |

Pick **one** — having too many dilutes the paper.

---

## 2. Suggested paper structure (8 pages + appendix)

```
1. Introduction (1 page)
   - The smartphone recommendation problem
   - Why persona + budget filtering is insufficient
   - Our contribution (one sentence)

2. Related Work (1 page)
   - Hybrid recommenders (Sarwar et al.)
   - Learning-to-rank (Burges et al.)
   - SHAP (Lundberg & Lee)
   - K-Means vs GMM for customer segmentation

3. Dataset (0.5 page)
   - GSMArena (8,500 phones)
   - Customer transactions (16,608 rows, 4,557 customers)
   - Pre-processing summary

4. Method (2 pages)
   - Feature engineering (120 features)
   - XGBoost for AnTuTu regression
   - Brand-loyalty / Camera-tier / Tech-tier classifiers
   - LambdaMART ranker (objective='rank:ndcg')
   - SHAP / LIME / counterfactual explanations

5. Experiments (2 pages)
   - 5.1 Offline ranking metrics
   - 5.2 Offline classification metrics
   - 5.3 Human-evaluation study (15 users, paired t-test)
   - 5.4 Ablation: remove XGBoost, remove SHAP, remove clustering

6. Discussion (0.5 page)
   - Where the ranker wins
   - Where it loses (cold-start, brand new phones)
   - Limitations

7. Conclusion (0.5 page)
```

---

## 3. Baseline experiments (the table that matters)

```
Dataset          | Method           | NDCG@5 | NDCG@10 | MAP@10 | CTR@5 | Latency (ms)
-----------------|------------------|--------|---------|--------|-------|-------------
GSMArena+Customer| Random           | 0.012  | 0.014   | 0.011  | 0.04  | 0.1
GSMArena+Customer| Popularity       | 0.124  | 0.187   | 0.139  | 0.18  | 0.5
GSMArena+Customer| kNN (cosine)     | 0.211  | 0.293   | 0.232  | 0.27  | 8.2
GSMArena+Customer| Weighted-Sum (current)| 0.245 | 0.328 | 0.265 | 0.31 | 6.4
GSMArena+Customer| LambdaMART (ours)| 0.302  | 0.389   | 0.317  | 0.39  | 12.1
GSMArena+Customer| LambdaMART + brand-loyalty boost | 0.318 | 0.402 | 0.334 | 0.42 | 12.4
```

Numbers are illustrative. Generate them with `mlflow` or `wandb`.

---

## 4. Statistical tests

Use **paired bootstrap** for NDCG@K:

```python
from scipy.stats import bootstrap
import numpy as np

def paired_bootstrap_diff(scores_a, scores_b, n_boot=10000):
    rng = np.random.default_rng(42)
    n = len(scores_a)
    diffs = []
    for _ in range(n_boot):
        idx = rng.integers(0, n, n)
        diffs.append(scores_b[idx].mean() - scores_a[idx].mean())
    diffs = np.array(diffs)
    return {
        "mean_diff": diffs.mean(),
        "ci_low": np.quantile(diffs, 0.025),
        "ci_high": np.quantile(diffs, 0.975),
        "p_two_sided": 2 * min((diffs < 0).mean(), (diffs > 0).mean()),
    }
```

Report `mean_diff`, `95% CI`, and `p-value` for every comparison in the table.

---

## 5. Ablation study

The ablation table is mandatory:

```
Configuration                                      | NDCG@10
---------------------------------------------------|--------
Full LambdaMART + SHAP                             | 0.389
− remove SHAP from ranker features                 | 0.378
− remove brand-loyalty classifier                  | 0.371
− remove segmentation as a feature                 | 0.355
− replace XGBoost with logistic regression         | 0.302
− replace engineered features with raw specs       | 0.244
```

Each row "− remove X" means retrain without feature/feature-block X. This table alone is worth a page.

---

## 6. Human-evaluation study

A small but rigorous study adds enormous value:

### 6.1 Protocol

- N = 15 participants (recruit from friends/course-mates).
- Each participant sees 10 recommendations.
- Each recommendation is shown **with SHAP** and **without SHAP** (within-subject, counterbalanced).
- Questions (Likert 1-5):
  - Q1. "How useful is this recommendation?" (1=useless, 5=very useful)
  - Q2. "How much do you trust this recommendation?" (1=no trust, 5=full trust)
  - Q3. "Would you click to learn more?" (1=definitely not, 5=definitely yes)
- Report: mean ± std, paired t-test, Cohen's d.

### 6.2 Hypotheses

- **H1:** SHAP explanations increase perceived usefulness.
- **H2:** SHAP explanations increase trust.
- **H3:** SHAP explanations increase click intent.

### 6.3 Analysis

```python
from scipy.stats import ttest_rel, wilcoxon

t, p = ttest_rel(with_shap_q1, without_shap_q1)
print(f"Q1 mean diff: {with_shap_q1.mean() - without_shap_q1.mean():.2f}, t={t:.2f}, p={p:.4f}")
```

Report `p` and the **effect size** (Cohen's d).

---

## 7. Negative results section

Every publishable paper has a negative-results section. The reviewer will look for it.

What to include:
- LambdaMART did **not** beat the weighted-sum ranker for the `Budget` persona. (Likely because budget is the only hard constraint.)
- SHAP vs LIME had **no significant difference** on perceived usefulness. (LIME is faster but SHAP is consistent.)
- DBSCAN found **one cluster** — the data has continuous behaviour gradients, not density peaks.

---

## 8. Threats to validity

- **Internal:** random forest / LightGBM may beat XGBoost on the same features.
- **External:** GSMArena data may not match a different locale.
- **Construct:** "usefulness" is self-reported, not observed.
- **Conclusion:** 15 users is a small sample.

---

## 9. Reproducibility checklist

- [ ] Code on GitHub with a `LICENSE` (MIT preferred).
- [ ] `requirements.txt` with exact versions (`pip freeze > requirements.txt`).
- [ ] `data/` folder with the CSVs (or a download script + Zenodo DOI).
- [ ] `models/` folder with all 12 artefacts.
- [ ] `Makefile` with `train`, `register`, `serve`, `eval`, `figures`.
- [ ] `experiments/` folder with the offline-metric notebooks.
- [ ] `Dockerfile` for the FastAPI service.
- [ ] `docker-compose.yml` for end-to-end reproduction.
- [ ] `README.md` with a "How to reproduce" section.
- [ ] A `mlflow` or `wandb` project URL with the runs.

A paper with all of these is **reproducible**. A reviewer can re-run it in 30 minutes.

---

## 10. Submission targets

| Venue                                | Page limit | Acceptance rate | Notes                            |
| ------------------------------------ | ---------- | --------------- | -------------------------------- |
| RecSys Reproducibility               | 6 + 2      | ~30%            | Needs reproducibility statement   |
| KDD ADS                              | 8 + 2      | ~20%            | Industry track friendly           |
| ICAART                               | 8          | ~35%            | Easier venue, still respected    |
| NCE / IOE undergraduate research    | variable   | n/a             | Internal, low bar                |
| arXiv preprint                       | n/a        | n/a             | Always an option                |

Aim first at **ICAART** or an internal journal, get reviews, then aim higher.