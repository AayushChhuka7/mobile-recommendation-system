# 08 — Recommendation Quality

> The current `/recommend` endpoint returns a ranked list of phones given
> `(persona, budget, preferences, topN)`. This document specifies the
> offline metrics, evaluation harness, and online A/B plan needed to
> claim the system is "good".

---

## 1. What is being ranked

The ranking function is in `pipeline/recommend.py`:

```python
weight_sum = sum(weights.values()) or 1.0
match_score = pd.Series(0.0, index=candidates.index)
for dim, w in weights.items():
    match_score = match_score + candidates[score_cols_map_[dim]] * w
match_score = match_score / weight_sum
candidates = candidates.assign(Match_Score=match_score.round(1))
top = candidates.sort_values("Match_Score", ascending=False).head(request.top_n_results)
```

This is a **weighted-sum** ranker with hand-tuned persona weights. There is no learned weight, no per-user re-ranking, no position bias correction.

---

## 2. The five things "good" means

| Metric                         | What it measures                              | Target                          |
| ------------------------------ | --------------------------------------------- | ------------------------------- |
| **NDCG@K**                     | Ranking quality vs ideal ordering             | > 0.30                          |
| **MAP@K**                      | Precision at K, averaged                       | > 0.25                          |
| **MRR**                        | Reciprocal rank of the first relevant item    | > 0.40                          |
| **CTR@K**                      | Click-through rate at K                       | > 0.30                          |
| **Diversity (ILD)**            | Intra-list diversity                          | > 0.5                           |
| **Coverage**                   | % of catalogue ever shown                      | > 0.6                           |

The first three need **labels** — what did the user actually click / buy / wishlist?

---

## 3. Offline evaluation harness

The single most valuable piece of ML infrastructure the project is missing.

### 3.1 Build a labelled dataset

Three sources of labels (in priority order):

| Source                                  | Strength | Weakness                  |
| --------------------------------------- | -------- | ------------------------- |
| `RecommendationHistory` (clicked, compared, saved, purchased) | Ground truth (implicit feedback) | Sparse for new users      |
| `Wishlist` (added then purchased)       | Strong intent signal         | Sample bias                 |
| `ComparisonHistory` (chosen side)       | Pairwise preference          | Sparse                      |
| Synthetic labels (price-vs-spec ratio)  | Always available             | Weak proxy                  |

### 3.2 Train/val/test split

Use **time-based split** to avoid leakage:

- **Train:** 2020-01-01 → 2024-12-31
- **Val:** 2025-01-01 → 2025-06-30
- **Test:** 2025-07-01 → 2026-04-03

### 3.3 Metrics script

```python
import numpy as np
from sklearn.metrics import ndcg_score, label_ranking_average_precision_score

def evaluate(ranker, X, y_relevant, k=10):
    scores = ranker.predict(X)
    return {
        f"NDCG@{k}": ndcg_score(y_relevant, scores, k=k),
        f"MAP@{k}": label_ranking_average_precision_score(y_relevant, scores),
    }
```

For pairwise comparison:

```python
def pairwise_accuracy(ranker, queries, docs, labels):
    """labels[i] = 1 if doc[i] is relevant for query[i]."""
    correct = 0
    total = 0
    for q in queries.unique():
        mask = queries == q
        scores = ranker.predict(docs[mask])
        y = labels[mask]
        for i in range(len(scores)):
            for j in range(i + 1, len(scores)):
                if y[i] != y[j]:
                    total += 1
                    if (scores[i] > scores[j]) == (y[i] > y[j]):
                        correct += 1
    return correct / max(total, 1)
```

---

## 4. Baselines to beat

| Baseline             | What it is                                       | Expected NDCG@10 |
| -------------------- | ------------------------------------------------ | ---------------- |
| Random               | Random ordering of the candidate pool            | 0.014            |
| Popularity           | Sort by `AnTuTu_Score` desc                       | 0.187            |
| Price-asc            | Cheapest first                                   | 0.082            |
| kNN-cosine           | Content-based (current notebook)                 | 0.293            |
| Weighted-sum (current) | `pipeline/recommend.py`                         | 0.328            |
| **LambdaMART (target)** | Learned ranker with XGBoost                   | 0.389            |

If your LambdaMART doesn't beat the weighted-sum by **at least 5% relative** in NDCG@10, something is wrong — either the labels are noisy, or the features are too weak.

---

## 5. Online A/B test plan

Once the system is live and has traffic, the rigorous comparison is:

### 5.1 Bucketing

- **Bucket A** (50%): current weighted-sum ranker
- **Bucket B** (50%): LambdaMART ranker
- **Bucket C** (10% sub-bucket of A): control (no personalisation)

### 5.2 Primary metric

- **CTR@5** within 24 hours of exposure.

### 5.3 Secondary metrics

- **Wishlist-add rate**
- **Comparison rate**
- **Time-to-click** (lower is better)
- **Session length**

### 5.4 Sample size

For a 5% relative lift (0.328 → 0.344) with α = 0.05 and β = 0.20, you need **~10,000 unique users per bucket**. If you have 4,557 users in the dataset, run for **6 weeks** at modest traffic.

### 5.5 Analysis

- **Bayesian** comparison of CTR per bucket with credible intervals.
- **Sequential testing** (mSPRT) to allow peeking without inflating Type-I error.

---

## 6. Position-bias correction

Every recommendation list has position bias — users click the top item 30%+ of the time regardless of relevance.

To correct for it:

1. **Click model.** Use the position of every click to learn a position-bias term. `E[click | position] = relevance × P(seen | position)`.
2. **Inverse propensity scoring (IPS).** Weight each click by `1 / P(seen | position)`.
3. **Dual-bandit.** Use two logistic regressions: one for relevance, one for position. The product is the click model.

The simplest production fix is **swapping the top-2 results 10% of the time** and using the click difference to estimate position bias.

---

## 7. Diversity

A ranker that always shows `Samsung Galaxy S25 Ultra` to a "Gamer" persona is **not diverse**.

```python
def intra_list_diversity(ranked_items, features) -> float:
    """Average pairwise distance between items in the ranking."""
    n = len(ranked_items)
    if n < 2:
        return 0.0
    sims = cosine_similarity(features[ranked_items])
    return 1 - sims[np.triu_indices(n, k=1)].mean()
```

Target **ILD > 0.5** for top-10. If below, add an MMR-style re-ranker:

```python
def mmr(scores, features, lambda_=0.5):
    selected = []
    candidates = list(range(len(scores)))
    while len(selected) < k:
        if not selected:
            best = max(candidates, key=lambda i: scores[i])
        else:
            best = max(candidates, key=lambda i: lambda_ * scores[i] - (1 - lambda_) * max(sim(i, j) for j in selected))
        selected.append(best)
        candidates.remove(best)
    return selected
```

---

## 8. Coverage

How many distinct phones are ever shown in a session?

```python
def coverage(shown_lists: list[list[int]], catalogue_size: int) -> float:
    shown = set()
    for lst in shown_lists:
        shown.update(lst)
    return len(shown) / catalogue_size
```

If coverage drops below 0.5 after the ranker ships, add a **calibration** post-step that occasionally injects less-popular items.

---

## 9. Cold-start quality

When a brand-new user has no history, the ranker falls back to persona + budget. Evaluate separately:

```python
def cold_start_eval(ranker, new_users, k=10):
    """Evaluate ranker on users with zero history."""
    return evaluate(ranker, new_users, k=k)
```

If NDCG@10 is much lower for cold-start, add the **Segment Classifier** (see `xgboost_ideas/07_segment_classifier.md`) as a cold-start prior.

---

## 10. Reporting template (one paragraph per metric)

For the final report:

> *NDCG@10: Our LambdaMART ranker achieves 0.389, a 18.6% relative improvement over the weighted-sum ranker (0.328) and a 99.0% improvement over popularity (0.187). The 95% bootstrap CI is [0.371, 0.407]. CTR@5 over a 4-week A/B test (n=11,234 unique users per bucket) was 0.39 vs 0.31, a 25.8% relative lift (p < 0.001, Bayesian posterior probability of B > A = 0.998). Position-bias-corrected NDCG@10 was 0.412. Diversity (ILD) of the top-10 list was 0.51. Coverage across 28 days was 0.62.*

That's a complete defence story.

---

## 11. What to ship first

| Priority | Action                                                | Effort |
| -------- | ----------------------------------------------------- | ------ |
| 1        | Build the offline evaluation harness                  | 1 week |
| 2        | Add NDCG/MAP/MRR to the README                        | 0.5 day |
| 3        | Add a `lambda_ranker.py` to `xgboost_ideas/06_*`     | 1 week |
| 4        | Run the A/B test for 4 weeks                          | 4 weeks |
| 5        | Position-bias correction                              | 1 week |
| 6        | Diversity post-step (MMR)                             | 0.5 week |
| 7        | Coverage calibration                                  | 0.5 week |

The total is **~8 weeks** and the result is a publishable paper.