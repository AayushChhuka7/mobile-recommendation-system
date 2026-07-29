# 05 — MLOps & Production Readiness

> The project runs locally with `docker-compose up`. This document specifies what
> is missing for production-grade deployment and how to add it incrementally.

---

## 1. The 12-point MLOps checklist

| # | Item                                 | Current state | Target                                             |
| - | ------------------------------------ | ------------- | -------------------------------------------------- |
| 1 | **Versioned artefacts**              | ❌              | `models/antutu/2026-07-28-r12/model.json`          |
| 2 | **Train → register → serve pipeline**| ❌              | `make train && make register && make serve`         |
| 3 | **CI on every push**                 | ❌              | GitHub Actions: lint + pytest + schema-check        |
| 4 | **Reproducible training**            | ⚠ `random_state=42` but no `poetry.lock` | `pip freeze` committed, Docker image with hash     |
| 5 | **Model card**                       | ❌              | `reports/model_card_antutu.md` (template in this folder) |
| 6 | **Data card**                        | ❌              | `reports/data_card_phones.md`                      |
| 7 | **Drift monitor**                    | ❌              | PSI > 0.2 on any feature → alert                    |
| 8 | **Performance monitor**              | ❌              | Live NDCG@10 on recent clicks vs baseline           |
| 9 | **Rollback plan**                    | ❌              | `models/registry.json` keeps last 5 versions        |
| 10| **A/B test harness**                 | ❌              | `/recommend?experiment=A|B` route, logged events    |
| 11| **On-call runbook**                  | ❌              | `RUNBOOK.md` with the top-5 alerts                  |
| 12| **Cost tracking**                    | ❌              | Per-request ms + $ on each `/recommend` response   |

---

## 2. Versioned artefacts

Today, `artifacts/model.json` is overwritten on every train. The fix is a tiny script:

```python
import datetime, shutil, pathlib
src = pathlib.Path("artifacts")
dst = pathlib.Path(f"models/antutu/{datetime.date.today().isoformat()}-r12")
dst.mkdir(parents=True, exist_ok=True)
for f in src.iterdir():
    shutil.copy(f, dst / f.name)
```

Append to `models/registry.json`:
```json
{ "antutu": { "current": "2026-07-28-r12", "previous": "..." } }
```

The FastAPI service reads `models/registry.json` at startup and loads `current`.

---

## 3. Train → register → serve pipeline

`Makefile`:

```makefile
.PHONY: train register serve test

train:
	python -m ml_models.antutu_regressor.train

register:
	python scripts/register.py --model antutu

serve:
	uvicorn pipeline.serve:app --port 8002

test:
	pytest -q ml_models tests
```

---

## 4. CI

`.github/workflows/ci.yml`:

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: pip install -r requirements.txt
      - run: pytest -q
      - run: ruff check ml_models pipeline
```

For the Node side, add a parallel job that runs `npm test` (once tests exist).

---

## 5. Drift monitor

A simple drift detector on every `/predict` request:

```python
# example_code/drift_detector.py
from collections import deque

class FeatureDriftMonitor:
    def __init__(self, baseline: dict[str, tuple[float, float]], window: int = 1000):
        self.baseline = baseline       # col → (mean, std)
        self.recent = {c: deque(maxlen=window) for c in baseline}

    def update(self, row: dict[str, float]) -> dict[str, float]:
        psi = {}
        for col, (mu_b, sd_b) in self.baseline.items():
            x = row.get(col)
            if x is None or sd_b == 0:
                continue
            self.recent[col].append(x)
            if len(self.recent[col]) < 30:
                continue
            mu_r = sum(self.recent[col]) / len(self.recent[col])
            sd_r = (sum((x - mu_r) ** 2 for x in self.recent[col]) / len(self.recent[col])) ** 0.5
            psi[col] = abs(mu_r - mu_b) / (sd_b + 1e-9)
        return psi
```

A simple version uses PSI; a more robust version uses the Kolmogorov-Smirnov test. Add an alert when `psi > 0.2` for any column.

---

## 6. Performance monitor

Once `/recommend` logs `(user_id, returned_ids, clicked_id, timestamp)` to `RecommendationEvent`, you can compute offline:

- **NDCG@10** per day, per persona, per cluster
- **Click-through rate** at K = 1, 3, 5, 10
- **Wishlist-add rate** at K = 1, 3, 5

A weekly cron job emits these to a Slack channel or a Grafana dashboard.

---

## 7. Rollback plan

The `models/registry.json` keeps the last 5 versions. The `/admin/rollback?model=antutu&to=2026-07-21-r11` route:

1. Updates `registry.json`.
2. Reloads the model in the running process (FastAPI hot-swap via a global `pipeline` variable guarded by a lock).
3. Logs the rollback to `models/audit.json`.

The lock is critical: two simultaneous rollbacks corrupt state.

---

## 8. A/B test harness

A minimal logged-only A/B test:

```
GET /recommend?persona=gamer&budget=500&experiment=A
```

The route:
1. Reads the `experiment` cookie (or assigns 50/50 if absent).
2. Calls `ranker_A.predict(...)` or `ranker_B.predict(...)` based on the bucket.
3. Logs `(user_id, experiment_bucket, returned_ids, ts)` to `RecommendationEvent`.
4. Returns the list.

After 1,000 events, compute CTR per bucket. After 10,000, do a Bayesian comparison.

---

## 9. On-call runbook

`RUNBOOK.md` with the top-5 alerts:

1. **`/health` returns 503.** Check `model_loaded` and `load_error` fields. If `load_error` mentions a missing column, re-train and re-register.
2. **Latency p95 > 800 ms.** Check the candidate pool size — if it grew past 20k, switch from `apply()` to vectorised numpy.
3. **NDCG@10 drops 5% week-over-week.** Check the data drift monitor; if a feature has PSI > 0.2, retrain.
4. **`/recommend` returns empty list.** Check the budget filter — if `budget.max < 100`, almost no phones pass.
5. **Auth 401 spike.** Check the session table — it may have hit the cleanup threshold.

---

## 10. Cost tracking

Each `/recommend` response includes:
```json
{
  "results": [...],
  "meta": {
    "model_version": "antutu:2026-07-28-r12",
    "inference_ms": 18.4,
    "candidate_pool_size": 8500,
    "ranker_version": "weighted-sum-v3"
  }
}
```

A nightly job aggregates these to a `metrics/cost_daily.csv`.

---

## 11. Tests (concrete examples)

`tests/test_antutu_regressor.py`:

```python
import pytest, pandas as pd
from ml_models.antutu_regressor.predict import load_model, predict

@pytest.fixture(scope="module")
def model():
    return load_model("models/antutu/2026-07-28-r12")

def test_predict_shape(model):
    df = pd.DataFrame([{"Brand": "Apple", "Chipset_Brand": "Apple", ...}])
    out = predict(model, df)
    assert len(out) == 1
    assert out[0] > 0

def test_categorical_unknown_does_not_crash(model):
    df = pd.DataFrame([{"Brand": "BrandFromYear2099", ...}])
    out = predict(model, df)
    assert out[0] is not None   # NaN handling works
```

---

## 12. Production-readiness scorecard

| Pillar        | Score (out of 10) | Note                                                 |
| ------------- | ----------------- | ---------------------------------------------------- |
| Code quality  | 8                 | Pipeline is clean; some FastAPI bugs (dead code)     |
| Reproducibility | 6               | random_state set; no `poetry.lock`; no Docker image  |
| Observability | 2                 | `/health` only; no metrics, no traces, no logs       |
| Testing       | 2                 | `test_pipeline.py` only; no unit tests on features   |
| Model governance | 3              | Single version in `artifacts/`; no card, no registry |
| Drift & feedback | 1              | No monitor; no A/B                                    |
| Security      | 6                 | OTP, sessions, RBAC; CORS=* is the weak spot         |
| Documentation | 9                 | README is excellent; FUTURE_WORK is honest           |

Average: **4.6 / 10** — typical for a minor project. Reaching **7/10** is realistic in 12 weeks with the plan in `01_project_audit.md`.