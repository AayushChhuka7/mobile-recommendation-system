# Integration Notes — CF Recommender

These notes are for the backend engineer wiring the collaborative-filtering
recommender into the Django backend. The CF model lives in this folder as
a **self-contained module** with one public class
(`CFRecommender`) and one method (`get_recommendations`).
Nothing here is wired up yet — these notes describe the *contract* the
backend needs to honour.

---

## 1. What this module does

`CFRecommender.get_recommendations(customer_id, top_n=5)` returns up to
`top_n` phones ranked for the customer. Each result is a dict:

```python
{
    "model_name": "Apple iPhone 14 Pro Max",
    "score":      0.302,                       # hybrid score, [0, 1]
    "reason":     "matches your preferred brand Apple; popular with Premium Flagship Shopper customers"
}
```

The hybrid score blends two signals:

| signal | weight | source |
|---|---|---|
| CF score (SVD + item-cosine, z-averaged) | 0.7 | learned from `interactions.csv` |
| Content score (customer interests × phone specs) | 0.3 | learned from `customer_profiles_with_clusters.csv` + `phone_catalog.csv` |

For users with no interaction history (cold-start), the same function
falls back to **cluster popularity → province popularity → district
popularity → global popularity**, with the content score used as a final
rerank. The user never sees an empty list.

---

## 2. Files produced by `python fit.py`

After running the training script you'll have:

```
ML model/filtering/03_collaborative_filtering/output/
├── cf_recommender.pkl                       # ~150 MB pickled CFRecommender
├── phone_catalog_for_inference.csv          # 1,787 phones with normalised spec cols
├── customer_profiles_for_inference.csv      # 4,557 customers (subset of columns)
├── model_comparison.csv                     # P@K / R@K / NDCG@K comparison
└── model_comparison.json
```

The `pkl` file holds the trained matrices (item-item cosine, SVD
factors, ALS model, content scorer, popularity caches). Everything
needed to serve predictions is inside it. The two CSVs are convenience
files used by the reason-generator — the recommender can rebuild the
reason text from the in-pickle content scorer, but loading them as
plain CSV at startup avoids a chicken-and-egg if you want to inspect
the catalog / profiles from Python.

---

## 3. Expected input / output contract

### Input

- `customer_id: str` — the same `customer_id` format as
  `01_data_preparation/output/customer_profiles_clean.csv`
  (e.g. `"CUST-014332E4"`).
- `top_n: int` — defaults to 5, max effective ~50 (the model only
  ranks 200 candidates internally).
- `exclude_models: set[str] | None` — optional list of `model_name`s
  to skip (useful if the frontend already shows some other phones
  and you don't want to repeat them).

If `customer_id` is unknown to **both** the interaction log AND the
profiles (a brand-new visitor who has never registered), the
recommender returns global popularity. This is the only path that
requires zero prior data.

### Output

A `list[dict]` of length ≤ `top_n`, sorted by descending `score`.
`reason` is a human-readable string with up to 3 semi-colon-separated
clauses drawn from:

- "matches your preferred brand {brand}"
- "fits your budget"
- "popular with {cluster_name} customers"
- "{Main_Camera_MP} MP main camera"
- "{Battery_mAh} mAh battery"
- "{Refresh_Rate_Hz}Hz refresh display"
- "strong gaming performance"
- "trending in {province}"
- "popular in Nepal right now"

---

## 4. Recommended wiring in the Django backend

### Option A — inference service (recommended)

Keep the CF model **out of the Django process**. Run a small HTTP
service alongside Django:

```
[ Django (gunicorn) ] --HTTP--> [ cf_service.py ] --pickle--> [ cf_recommender.pkl ]
```

Why: loading the 150 MB pickle into every Django worker costs ~3s of
RAM per worker × N workers. A single inference service loads it once
and serves all workers.

Skeleton (FastAPI, but Flask works too):

```python
# cf_service.py
from fastapi import FastAPI
from cf_model import CFRecommender

app = FastAPI()
_rec: CFRecommender | None = None

@app.on_event("startup")
def _load():
    global _rec
    _rec = CFRecommender.load("output/")

@app.get("/recommend")
def recommend(customer_id: str, top_n: int = 5):
    return {"results": _rec.get_recommendations(customer_id, top_n)}
```

Django then calls:

```python
import requests
results = requests.get(
    "http://localhost:9001/recommend",
    params={"customer_id": request.user.customer_id, "top_n": 5},
    timeout=0.5,
).json()["results"]
```

Set a 500 ms timeout — the in-process recommender returns in ~30 ms.

### Option B — Django management command (simpler, slower)

If you don't want a second service, load the recommender lazily on
first use and cache it on the module:

```python
# recommendations/cf.py
from cf_model import CFRecommender
from django.conf import settings

_RECOMMENDER = None

def get_recommender() -> CFRecommender:
    global _RECOMMENDER
    if _RECOMMENDER is None:
        _RECOMMENDER = CFRecommender.load(settings.CF_MODEL_DIR)
    return _RECOMMENDER
```

Then in a view:

```python
from recommendations.cf import get_recommender

def my_view(request):
    recs = get_recommender().get_recommendations(request.user.customer_id)
    ...
```

The first request after `gunicorn` boot pays the ~3 s load cost; every
subsequent request is ~30 ms.

---

## 5. Where to plug into the existing content-based recommender

The project already has a content-based recommender in `ML Model/pipeline/`.
When you wire CF in, the cleanest design is to **add a hybrid layer that
combines them**, not to replace. The existing content-based recommender
already runs in production; CF should sit alongside it, weighted in.

Suggested contract:

```python
def hybrid_recommend(customer_id, top_n=5):
    content_recs = content_based_recommender(customer_id, top_n=20)  # existing
    cf_recs = get_recommender().get_recommendations(customer_id, top_n=20)  # new
    return rerank(content_recs, cf_recs, top_n)
```

Where `rerank` merges the two lists. A reasonable rule: items appearing
in **both** lists go first (highest confidence); items only in CF come
next (better for long-tail discovery); items only in content-based come
last.

---

## 6. Retraining

The model should be retrained when:

- New interaction data has accumulated (~quarterly is fine; the dataset
  is 86 k events and the model saturates around 50 k events).
- A new phone is added to the catalog — re-run `python fit.py` so the
  SVD item-factors and content spec vector include it.
- The cluster definitions from phase 2 change — the cold-start path
  uses `cluster_id`/`cluster_name`, so a re-cluster invalidates the
  cluster_pops cache.

Retraining takes ~2 minutes on a laptop CPU. The script is:

```bash
python "ML model/filtering/03_collaborative_filtering/fit.py"
```

After retraining, the inference service must be restarted to load the
new `cf_recommender.pkl`. (Pickle in-process cache means in-process
loading requires a process restart; this is by design.)

---

## 7. Known operational notes

- **Latency**: ~30 ms per call once warm. The bottleneck is the
  full-cosine-matrix scan in `_cf_score` — for >5 k users consider
  precomputing per-user factor projections.
- **Memory**: ~250 MB working set (model + SVD factors + content
  scorer). Do not load more than once per process.
- **Concurrency**: the recommender is read-only after `load()` and
  thread-safe — pickle the loaded object across worker forks if you
  want to share memory.
- **Empty input list**: `get_recommendations` always returns a list of
  length `top_n`, even for unknown users. The fallback chain ensures
  this.
- **Versioning**: if you bump `cf_model.py` schema, bump a
  `MODEL_VERSION` constant in the pickle so old pickles can be
  detected and rejected.