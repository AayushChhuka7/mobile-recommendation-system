# ML Model / filtering — Customer Segmentation Pipeline

This folder is the **collaborative-filtering + customer-segmentation** side
of the Smart Phone Hybrid Recommendation System. It does **not** touch the
existing content-based recommender in `ML Model/pipeline/`. Instead it
adds a new, separately-trained layer on top: it clusters the synthetic
customers, learns user × phone interactions, and ships a single trained
artefact (`cf_recommender.pkl`) that can return personalised recommendations
for any customer — including cold-start users with no history.

The folder is laid out as a 3-phase pipeline:

```
01_data_preparation/   02_segmentation/   03_collaborative_filtering/
```

Each phase has its own `*_readme.md` with full method details, design
decisions, and evaluation. This top-level README gives the short version of
each phase and — most importantly — describes how to plug the result into
the existing Node + React project.

---

## TL;DR — what was done

| Phase | What it produces | Status |
|---|---|---|
| `01_data_preparation` | A cleaned **86 k-row interaction log** from the 4,557 synthetic customers × 1,787 GSMArena phones, plus a deduplicated phone catalog and a cold-start holdout | ✅ Done |
| `02_segmentation` | A **KMeans (k=4)** clustering of customers: `Hardcore Gamer`, `Mainstream Mid-Range Shopper`, `Premium Flagship Shopper`, `Budget Buyer`. Saved as `kmeans_model.joblib` | ✅ Done |
| `03_collaborative_filtering` | A **SVD + item-cosine + content hybrid** trained on the interaction log. Best NDCG@10 = **0.0507** (~10× random). Saved as `cf_recommender.pkl` | ✅ Done |

A single inference call:

```python
from cf_model import CFRecommender
rec = CFRecommender.load("output/")
rec.get_recommendations("CUST-000EFD69", top_n=5)
# -> [{"model_name": "Apple iPhone 14 Pro Max", "score": 0.302,
#      "reason": "matches your preferred brand Apple; ..."}, ...]
```

---

## What each phase did (short version)

### Phase 1 — `01_data_preparation/data_preparation.py`

**Problem.** The existing `ML Model/SegmentationTask/customer_segmentation_dataset.csv`
is one-purchase-per-customer — great for **profiling**, useless for CF.
CF needs a user × item event log with timestamps and multiple event types.

**Fix.** A deterministic spec-matching join re-assigns each customer to a
real GSMArena phone that satisfies their hard minimums (RAM, storage,
refresh, battery, budget band, tier-rank). Then 86,195 synthetic events are
generated across 6 types (`view`, `search`, `compare`, `wishlist`,
`purchase`, `rate`) spread over the last 365 days.

**Outputs (in `01_data_preparation/output/`):**

| File | Rows | Purpose |
|---|---:|---|
| `customer_profiles_clean.csv` | 4,557 | 35-col profile, **no `model_name`** |
| `phone_catalog.csv` | 1,787 | Filtered GSMArena catalog (5G, Available, ≥2020, dedup) |
| `interactions.csv` | 86,195 | CF event log: `customer_id, model_name, interaction_type, rating, timestamp` |
| `cold_start_holdout.csv` | 282 | 228 cold-start users + 54 cold-start phones |

User-item sparsity: **99.11 %** (in the target 95–99 % band).

### Phase 2 — `02_segmentation/segmentation.py`

**Problem.** We want **discovered** behavioural segments, not the brittle
8-archetype rule-based labels from phase 1.

**Fix.** KMeans on the 4,557 × 61 feature matrix (25 z-scored numerics + 36
one-hot categoricals). `k = 4` chosen by peak silhouette score
(0.1718 at k=4 vs ≤ 0.108 for k=5–10).

**Cluster names** (rule-based labeler on top of KMeans):

| Cluster | Size | Profile |
|---|---:|---|
| 0 — Hardcore Gamer (Flagship) | 382 (8.4 %) | High gaming + display interest, Flagship tier, 92 k NPR budget |
| 1 — Mainstream Mid-Range Shopper | 2,641 (58.0 %) | Average interests, Mid tier, 67 k NPR budget |
| 2 — Premium Flagship Shopper | 1,192 (26.2 %) | Apple-loyal, 185 k NPR budget, 256 GB+ storage, 120 Hz |
| 3 — Budget Buyer | 342 (7.5 %) | Cheapest tier, 26 k NPR budget, minimal specs |

**Adjusted Rand Index vs `true_archetype` = 0.1503.** KMeans recovers
100 % of Hardcore Gamer, 100 % of Budget Buyer, 88 % of Premium Flagship;
the remaining archetypes collapse into the Mainstream cluster, which is
the data-driven truth (the rule-based labeler was over-fragmenting).

**Outputs (in `02_segmentation/output/`):**

| File | Purpose |
|---|---|
| `customer_profiles_with_clusters.csv` | 4,557 rows + `cluster_id` + `cluster_name` |
| `kmeans_model.joblib` | Trained KMeans — loadable to predict cluster for a new customer |
| `cluster_profiles.csv`, `cluster_profiles.png`, `pca_scatter.png`, `contingency_heatmap.png` | Sanity / defence-deck artefacts |

### Phase 3 — `03_collaborative_filtering/cf_model.py`

**Problem.** Even with cluster info, recommending to a brand-new user
needs an actual model that learns from behaviour.

**Fix.** Three CF models compared on a time-based 90-day test split:

| Model | Precision@10 | Recall@10 | **NDCG@10** |
|---|---:|---:|---:|
| Item-item cosine | 0.0013 | 0.0129 | 0.0052 |
| SVD (64 factors) | 0.0115 | 0.1149 | 0.0492 |
| Implicit ALS | 0.0043 | 0.0429 | 0.0217 |
| **SVD + cosine hybrid (winner)** | **0.0116** | **0.1160** | **0.0507** |

The hybrid combines `0.6 × z(SVD) + 0.4 × z(cosine)` then mixes with a
content score (`0.7 × CF + 0.3 × content`). RMSE/MAE on SVD is ~3.9 stars
and meaningless — only 27 % of users have a rating, so the rating column
is sparse enough that NDCG (ranking) is the only useful metric.

**Cold-start** is solved with a 4-tier fallback: cluster popularity →
province popularity → district popularity → global popularity, then
reranked by the content score and filtered by budget. The user never sees
an empty list.

**Outputs (in `03_collaborative_filtering/output/`):**

| File | Size | Purpose |
|---|---:|---|
| `cf_recommender.pkl` | ~15 MB | The trained `CFRecommender` — single inference method `get_recommendations(customer_id, top_n)` |
| `phone_catalog_for_inference.csv` | 569 KB | Catalog with normalised spec columns |
| `customer_profiles_for_inference.csv` | 649 KB | Profiles (subset) used by the reason-generator |
| `model_comparison.csv` / `.json` | < 2 KB | Per-model metrics table |

---

## How to integrate this into our project

The CF model is **self-contained** — it does not import from
`ML Model/pipeline/` and the Node backend does not import from it
directly. The clean way to integrate it is to:

1. **Serve it as a small HTTP sidecar** (FastAPI, port 9001) alongside
   the existing FastAPI recommender (port 8002) and the Node backend.
2. **Call it from the Express backend** for the existing recommendation
   endpoints, then merge its results with the content-based list.
3. **Surface its output in the React frontend** the same way the existing
   recommendations are surfaced.

Below is what each side needs to do.

---

## 1. Backend integration (Node + Express + Prisma)

### 1a. Add the cluster and recommendation history to the database

The CF model needs to know the cluster of every customer (so it can do
the cluster-popularity cold-start fallback), and the recommender needs a
place to log what it served. Two new Prisma models:

```prisma
// backend/prisma/schema.prisma — append at the bottom

model CustomerCluster {
  id           Int      @id @default(autoincrement())
  userId       Int      @unique
  clusterId    Int      // 0..3 from kmeans_model.joblib
  clusterName  String   // "Hardcore Gamer (Flagship)", ...
  assignedAt   DateTime @default(now())
  user         Users    @relation(fields: [userId], references: [id])
}

model CfRecommendationLog {
  id          Int      @id @default(autoincrement())
  userId      Int
  modelNames  String   // JSON array of the served model_names
  scores      String   // JSON array of parallel scores
  reasons     String   // JSON array of parallel reason strings
  isColdStart Boolean  @default(false)
  servedAt    DateTime @default(now())
  user        Users    @relation(fields: [userId], references: [id])
}
```

Then:

```bash
cd backend
npx prisma migrate dev --name add_customer_cluster_and_cf_log
```

### 1b. Cluster every user at registration / first login

The cluster ID is needed before the CF model can serve cold-start
recommendations. There are two reasonable times to assign it:

- **At registration**, after the user answers the 4 cold-start onboarding
  questions (so we already have the profile fields KMeans needs).
- **Lazily on first `/recommend` call** if the cluster is missing.

Add a new service: `backend/src/services/clusterService.mjs`.

```js
// backend/src/services/clusterService.mjs
import { spawnSync } from "node:child_process";
import path from "node:path";

const PYTHON = process.env.PYTHON || "python";

/**
 * Spawns the Python helper that loads kmeans_model.joblib and assigns
 * a cluster to one customer. Returns { clusterId, clusterName }.
 */
export function assignCluster(profile) {
  // profile = the fields the Python script expects (see below)
  const script = path.resolve(
    process.cwd(),
    "../ML Model/filtering/03_collaborative_filtering/output/assign_cluster.py",
  );
  const result = spawnSync(PYTHON, [script], {
    input: JSON.stringify(profile),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}
```

Write the matching Python helper
(`03_collaborative_filtering/output/assign_cluster.py`) — a ~30-line
script that loads `kmeans_model.joblib` + the same `StandardScaler` used
during training and prints JSON. It must apply **the same preprocessing**
as `02_segmentation/segmentation.py` or the cluster IDs will not match.

### 1c. Start the CF inference service

Add a `Dockerfile.cf` and a service to `docker-compose.yml`:

```yaml
# docker-compose.yml — add alongside ml-service (port 8002)
cf-service:
  build:
    context: .
    dockerfile: ML Model/filtering/03_collaborative_filtering/Dockerfile.cf
  ports:
    - "9001:9001"
  volumes:
    - ./ML Model/filtering/03_collaborative_filtering/output:/app/output:ro
  environment:
    - CF_PORT=9001
```

```dockerfile
# ML Model/filtering/03_collaborative_filtering/Dockerfile.cf
FROM python:3.11-slim
WORKDIR /app
COPY 03_collaborative_filtering/cf_model.py .
COPY 03_collaborative_filtering/output/ ./output/
RUN pip install fastapi uvicorn pandas scikit-learn numpy joblib implicit
EXPOSE 9001
CMD ["uvicorn", "cf_service:app", "--host", "0.0.0.0", "--port", "9001"]
```

And the `cf_service.py` itself (kept alongside `cf_model.py`):

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

### 1d. Call CF from the existing recommend controller

The current `backend/src/controller/recommendController.mjs` already has
`postRecommend` and `getAutoRecommend`. Add a CF layer **alongside** the
existing content-based pipeline — do **not** replace it.

In `recommendService.mjs`, where the current pipeline returns
`{ results: [...] }`, merge the CF list:

```js
// backend/src/services/recommendService.mjs

const CF_BASE_URL = process.env.CF_BASE_URL || "http://127.0.0.1:9001";

// Fetch the top 20 from each side, then merge to top N.
async function fetchCF(userId, topN = 20) {
  try {
    const res = await fetch(
      `${CF_BASE_URL}/recommend?customer_id=${encodeURIComponent(userId)}&top_n=${topN}`,
      { signal: AbortSignal.timeout(500) },
    );
    if (!res.ok) throw new Error(`CF ${res.status}`);
    const json = await res.json();
    return json.results;
  } catch (err) {
    console.warn("[recommend] CF service unavailable:", err.message);
    return [];   // fall back to content-based only
  }
}

// Merge rule: items in BOTH lists → top; CF-only → middle; content-only → bottom.
function mergeLists(contentList, cfList, topN) {
  const scoreByName = new Map();
  for (const r of contentList)
    scoreByName.set(r.model_name, { ...r, contentRank: r._rank ?? 1 });
  for (const r of cfList)
    scoreByName.set(r.model_name, {
      ...(scoreByName.get(r.model_name) || r),
      ...r,
      cfRank: r._rank ?? 1,
    });
  return [...scoreByName.values()]
    .sort((a, b) => {
      const aBoth = a.contentRank && a.cfRank ? -1 : 0;
      const bBoth = b.contentRank && b.cfRank ? -1 : 0;
      if (aBoth !== bBoth) return aBoth - bBoth;
      return (b.score ?? 0) - (a.score ?? 0);
    })
    .slice(0, topN);
}

// Inside the existing getAutoRecommendations / getRecommendations flow:
const cfResults = await fetchCF(userId, 20);
results = mergeLists(results, cfResults, topN);
```

### 1e. Add a new route for explicit CF (optional)

For the cold-start investigation page on the admin dashboard you may
also want an explicit `GET /recommend/cf?top_n=10` route that returns the
CF-only list (bypassing the merge). Wire it through
`backend/src/routes/recommendRoutes.mjs`:

```js
import { getCfRecommend } from "../controller/recommendController.mjs";
recommendRoutes.get("/cf", getCfRecommend);
```

And in the controller:

```js
export const getCfRecommend = catchAsync(async (req, res) => {
  const userId = req.user.id;        // or req.user.customerId, whichever you use
  const topN = Number(req.query.top_n) || 10;
  const cfResults = await fetchCF(`CUST-${userId}`, topN);
  res.json(new ApiResponse(200, { results: cfResults }));
});
```

(The `CUST-` prefix matches the synthetic dataset convention — adjust if
your real `customer_id` schema is different.)

### 1f. Env vars to add to `backend/.env`

```bash
CF_BASE_URL=http://127.0.0.1:9001
PYTHON=python
```

---

## 2. Frontend integration (React + Vite)

The frontend does not need to know that there are two recommendation
models. It just calls the same `getAutoRecommendations()` it already
calls — the backend merges the two lists transparently. But you have
three small additions to make:

### 2a. Surface the CF "reason" string

The CF model returns a per-item `reason` field ("matches your preferred
brand Apple; popular with Premium Flagship Shopper customers"). The
existing recommendation cards don't render this. In
`frontend/src/components/PhoneListing.jsx` (or wherever the rec cards
live — search for where `getAutoRecommendations` is consumed), add a small
"why this phone" line below the card subtitle:

```jsx
{rec.reason && (
  <p className="rec-card__reason" title={rec.reason}>
    {rec.reason}
  </p>
)}
```

(Add the `.rec-card__reason` class to the matching CSS file with a
muted-colour, small-font style.)

### 2b. Optionally show the user's cluster on the profile page

Once `CustomerCluster` is populated, you can show it on
`AdminCustomerDetail.jsx` (and/or the user's own profile). Add a new
service call:

```js
// frontend/src/services/profile.js — add this
export async function getMyCluster() {
  const res = await api.get("/profile/cluster");
  return res.data?.data;     // { clusterId, clusterName, assignedAt }
}
```

And a new backend route (no big lift — just a SELECT):

```js
// backend/src/routes/ownProfileRoutes.mjs — add
ownProfileRoutes.get("/cluster", requireAuth, async (req, res) => {
  const row = await prisma.customerCluster.findUnique({
    where: { userId: req.user.id },
  });
  res.json(new ApiResponse(200, row));
});
```

In `AdminCustomerDetail.jsx`, render the cluster as a tag:

```jsx
{customer.cluster && (
  <span className={`cluster-tag cluster-tag--${customer.cluster.clusterId}`}>
    {customer.cluster.clusterName}
  </span>
)}
```

Style each of the 4 cluster tags with a distinct accent colour
(orange for Hardcore Gamer, green for Budget Buyer, blue for Premium,
grey for Mainstream) so admins can scan a customer list quickly.

### 2c. Add an admin "recommend with CF" view (optional)

If the backend exposes `GET /recommend/cf`, an admin debugging page can
call it directly to inspect what the CF model alone would serve. Add a
new tab in `AdminCustomerList.jsx`:

```jsx
<Tab label="CF only">
  {selectedCustomer && (
    <CfOnlyList customerId={selectedCustomer.id} topN={10} />
  )}
</Tab>
```

And a tiny new component:

```jsx
// frontend/src/components/CfOnlyList.jsx
import { useEffect, useState } from "react";
import api from "../services/api";

export default function CfOnlyList({ customerId, topN = 10 }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    api.get(`/recommend/cf?top_n=${topN}`).then((r) => {
      setRows(r.data?.data?.results ?? []);
    });
  }, [customerId, topN]);

  return (
    <ul className="cf-only">
      {rows.map((r) => (
        <li key={r.model_name}>
          <strong>{r.model_name}</strong>
          <span className="score">{(r.score ?? 0).toFixed(3)}</span>
          <p>{r.reason}</p>
        </li>
      ))}
    </ul>
  );
}
```

This is the single most useful debugging tool while tuning weights —
seeing the CF list next to the merged list tells you whether CF is
adding useful serendipity or just duplicating what content-based already
returned.

### 2d. Log CF-related user events (optional but recommended)

If you want to retrain the CF model on **real** interaction data later,
the frontend already logs events through `useEventLogger`. Verify that
these event types are covered: `view_phone`, `search`, `compare`,
`add_wishlist`, `remove_wishlist`, `purchase`. They all already flow into
the backend `Event` table (see `backend/src/services/eventController.mjs`).

If any are missing, add them to
`frontend/src/services/events.js` and to the
`backend/src/validation/eventValidation.mjs` allowed-types enum.

---

## 3. End-to-end integration checklist

```
[ ] 1. Write ML Model/filtering/03_collaborative_filtering/output/assign_cluster.py
[ ] 2. Add CustomerCluster + CfRecommendationLog to backend/prisma/schema.prisma
[ ] 3. Migrate the database
[ ] 4. Add backend/src/services/clusterService.mjs
[ ] 5. Call assignCluster() from registration + first /recommend
[ ] 6. Write ML Model/filtering/03_collaborative_filtering/cf_service.py
[ ] 7. Add ML Model/filtering/03_collaborative_filtering/Dockerfile.cf
[ ] 8. Add cf-service to docker-compose.yml (port 9001)
[ ] 9. Wire fetchCF() into backend/src/services/recommendService.mjs
[ ] 10. Add CF_BASE_URL + PYTHON to backend/.env
[ ] 11. (optional) GET /recommend/cf route in recommendRoutes.mjs
[ ] 12. (optional) GET /profile/cluster route in ownProfileRoutes.mjs
[ ] 13. Surface rec.reason on the phone cards in PhoneListing.jsx
[ ] 14. (optional) Show cluster tag on AdminCustomerDetail.jsx
[ ] 15. (optional) CfOnlyList.jsx debugging component for admins
[ ] 16. Verify event types logged from FE cover view/search/compare/wishlist/purchase
```

When all of those are ticked, the hybrid recommender is live:
content-based provides the **baseline**, KMeans + cluster popularity
provides the **cold-start fallback**, and CF provides the **long-tail
serendipity** that pure content similarity misses.

---

## 4. Re-running the ML pipeline

The pipeline is deterministic (seed 42) and byte-stable:

```bash
# 1. Clean interactions + phone catalog
python "ML Model/filtering/01_data_preparation/data_preparation.py"

# 2. Cluster customers
python "ML Model/filtering/02_segmentation/segmentation.py"

# 3a. Train all 4 models + write comparison table
python "ML Model/filtering/03_collaborative_filtering/train.py"

# 3b. Train only the production artefact (skips the comparison metrics)
python "ML Model/filtering/03_collaborative_filtering/fit.py"
```

After step 3b, **restart the `cf-service` Docker container** so it
reloads the new `cf_recommender.pkl`.

---

## 5. Where the details live

| For… | Read |
|---|---|
| Spec-matching join + 86 k event log + interaction weighting | `01_data_preparation/data_prep_readme.md` |
| KMeans choice, silhouette, cluster names, ARI sanity check | `02_segmentation/segmentation_readme.md` |
| CF model comparison, NDCG, hybrid weights, cold-start examples | `03_collaborative_filtering/cf_readme.md` |
| Recommended wiring of CF into the backend | `03_collaborative_filtering/integration_notes.md` |
| Existing hybrid-recommender architecture (the layer CF merges into) | `/HYBRID_RECOMMENDATION_README.md` |
| Project-wide status & architecture | `/README_Project_Flow_A_to_Z.md` |