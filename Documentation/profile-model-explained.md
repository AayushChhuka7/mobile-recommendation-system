# Customer profile — field-by-field explanation

This README explains every value that appears on the admin **Customer profile**
page (`AdminCustomerDetail.jsx`) and the matching user-facing dashboard
counterpart. It also documents the tracking rules added in the most recent
iteration so it is clear how the numbers get computed and what the
"unknown id" UUIDs mean.

> The full bundle comes from `GET /api/users/me/profile-bundle` (see
> `backend/src/controller/profileController.mjs`). It is assembled in
> `backend/src/services/profileService.mjs::getProfileBundle`.

---

## 1. Identity (top of the page)

| Field          | Source                                | Notes |
| -------------- | ------------------------------------- | ----- |
| Name           | `Users.name`                          | First + last name entered at registration. |
| Email          | `Users.email`                         | Also serves as the login identifier. |
| Phone          | `Users.phoneNo`                       | Optional at registration — `—` if missing. |
| Role           | `Roles.roleName` joined on `Users`    | One of `Customer` / `Admin`. |
| Active         | `Users.isActive`                      | `Yes` unless the row was soft-deleted. |
| Verified       | `Users.isVerified`                    | Flips to `Yes` after the OTP step. |

---

## 2. Preference (`UserPreference` table)

> One row per user (`user_id` is unique).

| Field            | DB column                                         | What it really is |
| ---------------- | ------------------------------------------------- | ----------------- |
| Preferred brand  | `preferredBrandId` (FK → `Brands`) **and** `preferredBrands` (`jsonb` array of names) | Both are kept in sync. `preferredBrandId` is the FK-resolved primary; `preferredBrands` preserves the **full** unique set of names in case more than one brand was selected. |
| Budget           | `maxBudget` (Decimal) + `customerProfile.avgBudget` | `maxBudget` is the explicit ceiling; `avgBudget` is a rolling-mean retention of historical ceilings. Shown as `max · avg avg`. |
| Storage          | `customerProfile.preferredStorageGb`              | **Tracked but only populated when a recommendation row references this user.** See *Tech tier* below. |
| RAM              | `customerProfile.preferredRamGb`                  | Same — populated from the dominant variant of phones the user was recommended. |
| Battery          | not tracked                                       | Not yet wired up in the schema. Reserved. |
| Camera           | `cameraPreference` enum                           | `Photophile` if `camera ≥ 4/5` on the recommender slider, otherwise `Sensible`. |
| Usage type       | `usageType` enum                                  | One of `Student` / `Gamer` / `Business` / `Casual` / `Creator`; derived from the persona (`gamer → Gamer`, `camera → Creator`, otherwise `Casual`). |

### How `Storage` / `RAM` get populated

The recommender writes one `RecommendationHistory` row per phoneId it served
to the user. Each row references a `phoneId` whose cheapest variant carries
`ramGb` + `storageGb`. We aggregate the **modal (most-frequent) variant**
across the user's last 25 recommendation rows:

```js
// backend/src/services/profileAggregator.mjs
const storageMode = mode(rows.map(r => r.cheapestVariant.storageGb));
const ramMode     = mode(rows.map(r => r.cheapestVariant.ramGb));
await tx.customerProfile.update({
  where: { userId },
  data: {
    preferredStorageGb: storageMode,
    preferredRamGb:     ramMode,
  },
});
```

A new event is published every time `RecommendationHistory` is appended
(more than 5 new rows since the last aggregate run). This keeps the value
fresh without a nightly job.

---

## 3. Customer profile (`CustomerProfile` table)

> One row per user. The "tier" inference is rebuilt whenever the
> aggregator runs.

| Field                  | Source / derivation |
| ---------------------- | ------------------- |
| Budget segment         | `budgetSegment` enum (`BudgetExplorer` / `AffordableBuyer` / `MidRangeBuyer` / `PremiumBuyer` / `LuxuryBuyer`). Set from `maxBudget` band during `saveExplicitPreferences`. |
| **Tech tier**          | **`techTier` enum (`Budget` / `Reasonable` / `FlagshipKiller` / `TechSavvy` / `Luxurious`). Computed by the aggregator from the modal `antutuScore` of the phones in the last 25 recommendation rows.** |
| Recommendation persona | `recommendationPersona` (string). The persona that produced the most recent recommendation, or `auto` when the dashboard auto-recommender ran. |
| Avg budget             | `avgBudget` (Decimal). Retained historical max-budget. |
| **Searches**           | **The backend now returns the last 5 search queries in the `lastSearches` list instead of a single `searchCount`.** |
| **Recommendations**    | **The backend now returns the last 25 recommendation rows in `lastRecommendation.topResults` (resolved to **Brand · Model** instead of UUIDs) and uses `totalRecommendations` only for the lifetime total counter.** |
| **Comparisons**        | **The backend now returns the last 5 comparison rows (`lastComparisons`) with both phoneA and phoneB resolved to `Brand · Model`.** |
| Segment confidence     | `segmentConfidence` enum (`provisional` / `confirmed`). Set to `confirmed` the moment a user submits any explicit preference. |
| Last updated           | `@updatedAt` — fires on every write. |

### How `techTier` is computed

```js
function deriveTechTier(antutuScore) {
  if (antutuScore == null) return null;
  if (antutuScore >= 1_500_000) return "Luxurious";
  if (antutuScore >= 1_000_000) return "TechSavvy";
  if (antutuScore >= 700_000)   return "FlagshipKiller";
  if (antutuScore >= 400_000)   return "Reasonable";
  return "Budget";
}
```

`antutuScore` is the modal value across the phones in the user's last 25
recommendation events. Storing it as modal — not mean — means a single
flagship recommendation doesn't drag a budget-tiered user up to flagship.

---

## 4. Behaviour scores (`BehaviorScore` table)

A pure read of the Step B unified scoring table. Each row is `(userId, tag, score)`,
where `tag` is one of:

- Coarse interests: `gaming`, `camera`, `battery`, `category`
- Brand affinity: `brand:Apple`, `brand:Samsung`, ...
- Tier affinity: `tier:flagship`, `tier:mid`, `tier:budget`

Scores decay exponentially with each new `Event` row of the matching type
(see `backend/src/services/behaviorAnalyzer.mjs`). The bundle returns the
top-10 by score-desc. An empty list means the user has no scored events
yet.

---

## 5. Last recommendation

The bundle's `lastRecommendation` block is one row per call:

```js
{
  persona:  "gamer" | "camera" | "battery" | "allrounder" | "auto" | "Custom",
  budget:   null | { min?, max? } | null,        // populated from the call's filtersJson
  servedAt: ISO timestamp,
  topResults: [
    { phoneId, modelName, brand, overallCompatibility, searchDate },
    ...
  ],
}
```

### What "Top results" actually represents

There are two views and they were getting confused:

| View                | What it actually is                                                          |
| ------------------- | ----------------------------------------------------------------------------- |
| **Per-call top-3**  | The 3 highest-ranked phones *from the most recent recommendation call*.       |
| **Last 25 across all sessions** | A rolling window of the last 25 individual recommendation events, regardless of call — useful for the Aggregator's modal-based tier / RAM / storage inference. |

The current schema writes one row per *phone per call* to
`RecommendationHistory` (a fan-out). To make the per-call top view
available without re-issuing the ML pipeline, we now also write
**one `RecommendationCall` row per call** with a `topResults` JSON column
of `{phoneId, modelName, brand, rank, score}` — capped at 3 entries.

`getProfileBundle` now returns the per-call `topResults` (resolved to
human labels) and does **not** fan out into 25 rows.

### Why the UUIDs were appearing

Before the schema change, `topResults` carried only `r.phoneId` (the raw
UUID). The page rendered `<code>{r.phoneId}</code>` so a human looking at
the admin panel saw `a4f39236-9f4a-4821-abc3-be458f35363f` with no way
to tell what phone that was.

Fix: every entry in `topResults` now carries:

- `phoneId` — still the UUID (used as the React key and for "click to view"
  link)
- `modelName` — e.g. `Galaxy S24 Ultra`
- `brand` — e.g. `Samsung`

The FE resolves the UUID to `Brand · Model` via `Phones.brand.name` +
`Phones.modelName` joined at bundle-read time. If a phone was deleted
between serving and reading, the join returns null and we fall back to
`Unknown phone` so the admin still sees *that* something was recommended.

---

## 6. Recent signals

### Searches (last 5)

`backend/src/services/profileService.mjs::getProfileBundle` now slices
`SearchHistory` with `take: 5, orderBy: { searchedAt: 'desc' }`.

```js
lastSearches: [
  { searchQuery: "apple", searchedAt: "2026-07-29T..." },
  { searchQuery: "asus rog", searchedAt: "..." },
  ...
]
```

A row here is written by `safeRecordSearchEvent` (from the FE's
Dashboard search box) or by the CSV importer. Search queries are
truncated to 200 chars before they hit the DB.

### Browses (last 5)

The same `take: 5` rule now applies to `BrowsingHistory`. Each row carries:

```js
{ phoneLabel: "Galaxy S24 Ultra", brandName: "Samsung", viewedAt: "..." }
```

The schema deliberately does **not** link to `Phones` by FK because the
CSV source contains fictional / future / discontinued entries that don't
exist in our catalog. The `phoneLabel` is therefore the canonical human-
readable name (the same string the FE shows on the phone-detail page
header). The `brandName` is best-effort, populated when the CSV row had
it; it can be `null`.

A `<Browses:>` entry is written by `safeRecordBrowseEvent` whenever the
FE's `PhoneDetail` component mounts and supplies a stable label.

### Comparisons (last 5)

A new `lastComparisons` field on the bundle:

```js
lastComparisons: [
  {
    comparedDate:   "...",
    phoneA: { phoneId, modelName, brand },
    phoneB: { phoneId, modelName, brand },
  },
  ...
]
```

`take: 5, orderBy: { comparedDate: 'desc' }` against
`ComparisonHistory`. Each row references two real `Phones` rows so the
resolution to `Brand · Model` is reliable.

---

## 7. Aggregator cron

The aggregator that keeps `techTier` / `preferredStorageGb` /
`preferredRamGb` fresh is wired into a small background worker
(`backend/src/workers/profileAggregatorWorker.mjs`). It walks the
`RecommendationHistory` table, recomputes modal scores and updates
`CustomerProfile`. Failure to update leaves the prior value in place; the
worker is idempotent.

---

## 8. How a mobile phone is recommended end-to-end

This section is the long answer to "given everything above, how does a
phone end up at the top of *my* list?". It traces a single
recommendation request from the moment the user clicks **Recommend Me
a Phone** (or the dashboard auto-recommender fires) all the way down to
the final re-ranked list, and explains what every score actually means.

### 8.1 Pipeline at a glance

```
┌─────────────────────────────────────────────────────────────────────┐
│  Step A — Explicit preferences                                      │
│  (UserPreference + CustomerProfile in the DB)                       │
│  • persona: gamer / camera / battery / allrounder / Custom          │
│  • weights: { gaming, camera, battery, display } ∈ [1,5]            │
│  • budget: max (and the FE may override per-request)                │
└───────────────▼─────────────────────────────────────────────────────┘
                │        ┌─────────────────────────────────────────┐
                │        │  Step B — Implicit behaviour             │
                │        │  (Event + BehaviorScore rows)            │
                │        │  • one row per search / view / click /   │
                │        │    compare / save / ignore / recommend   │
                │        │  • per-tag scores with exp decay (α=.95) │
                │        └────────────────────┬─────────────────────┘
                │                             │
┌───────────────▼─────────────────────────────▼─────────────────────┐
│  Step C — Profile Fusion (request-time, in-memory)                 │
│  profileFusion.mjs::buildFusedWeights                              │
│                                                                     │
│  final_dim = β · explicit + (1-β) · behaviour                      │
│            β = 0.7  →  explicit dominates, behaviour nudges        │
│                                                                     │
│  Output: { gaming, camera, battery, display } ∈ [1,5]              │
│  (clamped so a long event history can't push past 5)               │
└───────────────▼─────────────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────────────┐
│  Step C→D — FastAPI /recommend                                      │
│  Posts persona + budget + fusedPrefs to the Python ML service.     │
│  Returns up to 200 phones with raw sub-scores:                      │
│  • Match_Score       → customer_preference (Step A + B (fused))    │
│  • Overall_Score     → compatibility  (FastAPI's own score)        │
│  • Value_Score       → value-for-money                               │
│  • Brand / Tags      → phone-level metadata                         │
└───────────────▼─────────────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────────────┐
│  Step D — Content similarity (one extra FastAPI hop)               │
│  POST /similarity/score on the full candidate set returns how      │
│  "typical" each phone is relative to the catalog mean. This         │
│  feeds the content_similarity component.                            │
└───────────────▼─────────────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────────────┐
│  Step D — Final 5-signal fusion + re-ranking                       │
│  fusionRanker.mjs::fusionRank                                       │
│                                                                     │
│  finalScore = Σᵢ  wᵢ · componentᵢ                                  │
│                                                                     │
│  where (FUSION_WEIGHTS, sums to 1.0):                               │
│    w_compatibility         = 0.4211                                 │
│    w_customer_preference   = 0.2105                                 │
│    w_content_similarity    = 0.1579                                 │
│    w_search_history        = 0.1053                                 │
│    w_value                 = 0.1053                                 │
│                                                                     │
│  The 6th slot (popularity, 0.05) is reserved for a future           │
│  customer-segmentation cluster and is currently unused — the       │
│  other five weights scale up proportionally to keep the sum        │
│  exactly 1.0.                                                       │
└───────────────▼─────────────────────────────────────────────────────┘
                │
                ▼
   finalScore (0..1) → multiplied by 100 to become the
                         "% match" the dashboard shows next to each
                         card. Phones are returned in descending
                         finalScore order; identical scores preserve
                         FastAPI's order (Array.sort is stable).
```

### 8.2 Where each of the 5 sub-scores comes from

| Component              | Source                                                       | Range   | What it says |
| ---------------------- | ------------------------------------------------------------ | ------- | --- |
| **compatibility**      | FastAPI `Overall_Score`, on 0..100 scale, divided by 100.    | [0, 1]  | The pure spec-fit score from the Python model: "given this phone's chipset / camera / battery / display, how well does it fit the persona?" |
| **customer_preference**| FastAPI `Match_Score`, on 0..100 scale, divided by 100.      | [0, 1]  | "How well does this phone fit *my* explicitly-stated dims?" — i.e. the BE's fusing of Step A + Step C. |
| **content_similarity** | `fetchContentSimilarity` (one POST to FastAPI `/similarity/score`) — `similarityToMean` per candidate. | [0, 1] | "How typical / aligned-with-the-catalog is this phone?" A high score is a *safe* pick; a low score flags an outlier (niche device). |
| **search_history**     | `searchHistoryScore` (pure function) folds the user's BehaviourScore map onto the candidate's tag set, then `tanh`-squashes the result. | [0, 1]  | "Does the user have positive *behavioural* affinity to tags this phone carries (brand, chipset, tier, etc.)?" Returns 0.5 (neutral) when there is no overlap. |
| **value**              | FastAPI `Value_Score` divided by 100.                        | [0, 1]  | Price-vs-specs ratio. |

The `tag` set per phone is built by `searchHistoryScore.phoneToTags` and
materialised at enrich time:

```js
brand:<name>          ← always, when Phones.brand.name is set
tier:flagship         ← when antutuScore ≥ 900_000
tier:mid              ← when antutuScore ≥ 500_000 (else "budget")
gaming                ← when chipset matches /snapdragon|dimensity|exynos|kirin|helio|rog/i
```

This is also the same tag set that the BE's `BehaviorScore` rows
accumulate *per event*, so the two systems speak the same vocabulary.

### 8.3 Why behaviour can beat persona (and vice versa)

Profile fusion is the only place where a user's moment-to-moment actions
actually steer the ranker. The formula is a single weighted average:

```
final_dim = β · explicit[dim] + (1 − β) · behavior[dim]   (default β = 0.7)
```

So **30% of the final dim always comes from behaviour**. Concretely:

- A user who picked **Gamer** (explicit preset = `{gaming:5, camera:2,
  battery:4, display:4}`) but who *actually keeps clicking camera phones*
  ends up with a fused `camera` weight that creeps past the persona's
  2/5 default — once their `BehaviorScore.camera` is ≥ 2.4, the fused
  weight equals `0.7·2 + 0.3·2.4 = 2.12`. The ranker then surfaces more
  camera phones than a pure persona would.
- A brand-new user who has never opened the onboarding modal but has
  already searched "ROG" three times is in the **behaviour-only** path —
  `behavior` is non-null and `explicit` is null, so we pass `behavior`
  straight through, clamped. They get a gamer-flavoured ranking by
  virtue of their actions, not their answers.

The clamp is at `[1, 5]` so a long history cannot push a dim past the
top of the FastAPI validator's range. We round to integer to avoid
422s on the wire.

### 8.4 Persistence — what gets saved when, and why

| Side effect                                            | Where                                                      | When | Why |
| ------------------------------------------------------ | ---------------------------------------------------------- | ---- | --- |
| `RecommendationHistory` row per served candidate       | `safeRecordRecommendationEvent` (`profileService.mjs`)      | Every recommendation call | The audit trail that the Aggregator + Admin panel rely on. |
| `RecommendationLog` row per served candidate (`rank`, `finalScore`) | `safeRecordRecommendationLog`                          | Every recommendation call | Future popularity signal. |
| `RecommendationCall` row per call (`topResults` JSON)  | `safeRecordRecommendationCall`                             | Every recommendation call | Top-3 panel on the admin page. |
| `ComparisonHistory` row + `totalComparisons++`         | `safeRecordCompareEvent`                                   | Every POST `/recommend/compare-ml` | "Last 5 comparisons" feed. |
| `SearchHistory` row + `searchCount++`                  | `safeRecordSearchEvent`                                    | Every search box use + filter apply | "Last 5 searches" feed + engagement metric. |
| `BrowsingHistory` row (CSV-style `phoneLabel`)          | `safeRecordBrowseEvent`                                    | Every `PhoneDetail` mount | "Last 5 browses" feed. |
| `Event` row (unified Step B log)                       | `recordEvent` → `behaviorAnalyzer.recordEvent`             | Every FE `useEventLogger` call *and* each of the `safe*Event` bridges | Single source of truth for analytics. |
| `BehaviorScore` upserts (per tag, with decay)          | `recordEvent` same tx                                      | Every Event | The actual signal the Step C fuser + Step D `search_history` sub-score read from. |

All writes are fire-and-forget: `safeRecord*` wrappers swallow DB errors
and log them, so an analytics write can never break a user-facing
response.

---

## 9. What we track on every event

Every user interaction that could inform the ranker flows through one
of seven `eventType` values, written by `behaviorAnalyzer.recordEvent`
to two tables: a raw `Event` audit row, and one or more
`BehaviorScore` upserts with exponential decay applied.

### 9.1 Event taxonomy — base deltas

The delta table is the *one place* you go to understand which events
do what:

| Event type  | Base tag deltas                   | What it implies about the user        |
| ----------- | --------------------------------- | ------------------------------------- |
| `search`    | `gaming +2`, `chipset +1`, plus one `+1` per matching SEARCH_KEYWORDS tag (e.g. `category:camera`, `brand:Apple`, `tier:flagship`) | "I'm looking for this kind of phone" |
| `view`      | `brand +1`, `tier +1`             | "I'm curious about this specific phone" |
| `click`     | `brand +2`, `category +1`         | "I actively opened this one" |
| `compare`   | `gaming +3`                       | "I'm seriously shopping" — heaviest signal |
| `save`      | `brand +4`, `category +2`         | "I want this one" — second heaviest |
| `ignore`    | `brand -1`, `category -1`         | "I scrolled past this" — pushes tags back toward 0 |
| `recommend` | `gaming +1`, `category +1`        | Structural signal ("user *asked* for a list"), tagged but the heavy lifting is in Step D not the behaviour table |

The base bucket has these *coarse* tags: `gaming`, `chipset`, `brand`,
`tier`, `category`. Anything else (`brand:Apple`, `tier:flagship`,
`category:camera`) is the `phoneMetaTags` mapper resolving the base
tag against the phone's brand / chipset / antutu / battery rows.

### 9.2 Phone metadata → concrete tag space

When a `view` / `click` / `save` / `ignore` event arrives with a
`phoneId`, the analyzer looks up (cached, 5-minute TTL) the phone's
brand / chipset / antutu / battery. For every tag in the base bucket
the analyst emits a *concrete* tag:

```js
'brand'   →  `brand:${brandsafe(brandName)}`         e.g. "brand:Apple"
'tier'    →  `tier:${flagship|mid|budget}`           from antutu bands
'category'→  `category:camera`                        (the only category we emit today)
```

A click on a Samsung Galaxy S24 Ultra therefore bumps:

- `brand:Samsung +2`
- `tier:flagship +1`
- `category:camera +1`

A click on an ASUS ROG Phone 8 bumps:

- `brand:Asus +2`
- `tier:flagship +1`
- `category:camera +1`
- `chipset` doesn't auto-bump from a click — only `search` explicitly
  emits `chipset +1`. But the `gaming` tag *is* bumped at search time
  when the user types "ROG", "gaming" or any matching keyword.

### 9.3 Search keywords — what fires when you search "asus rog phone 8"

The `SEARCH_KEYWORDS` table in `behaviorAnalyzer.mjs` is a small
lower-case substring match:

```js
"rog" / "gaming" / "gamer"   →  gaming
"camera" / "photography"     →  category:camera
"battery" / "battery_life"   →  category:battery
"ultra" / "flagship" /
  "premium"                  →  tier:flagship
"budget"                     →  tier:budget
"midrange" / "lite"          →  tier:mid
"apple" / "iphone"           →  brand:apple
"samsung" / "galaxy"         →  brand:samsung
"xiaomi" / "redmi" / "poco"  →  brand:xiaomi
"oneplus"                    →  brand:oneplus
"google" / "pixel"           →  brand:google
```

A single search can therefore fire *many* tag bumps at once. "asus rog
phone 8" (lowercase "asus rog phone 8") matches **rog** → `gaming +1`.

### 9.4 How behaviour scores are updated (the math)

For every (user, tag) pair we keep one `BehaviorScore` row with:

```sql
PRIMARY KEY (user_id, tag)
score        DOUBLE PRECISION   -- running
updated_at   TIMESTAMP          -- last write
```

Every incoming event runs the following read-modify-write *inside a
single transaction* with `behaviorAnalyzer.recordEvent`:

```
new_score = old_score · α + delta
           (default α = 0.95, delta from DELTAS table)

clamp to 4 decimal places so the table stays tidy
emit a negative score if delta is negative (ignore events)
```

In code:

```js
// behaviorAnalyzer.mjs
const ALPHA = 0.95;
function applyDecay(score, delta, alpha = ALPHA) {
  const s = Number.isFinite(score) ? score : 0;
  const d = Number.isFinite(delta) ? delta : 0;
  return Math.round((s * a + d) * 10000) / 10000;
}
```

What this means concretely:

- The score is a **leaky integrator**: each new event pushes it by
  `delta`, but the *previous* value shrinks by 5% first.
- A user who clicks "Apple iPhone 15" five times in a row climbs to:

  ```
  click1: 0.95·0  +2  = 2.00
  click2: 0.95·2.0+2  = 3.90
  click3: 0.95·3.9+2  = 5.71
  click4: 0.95·5.71+2 = 7.42   (no clamp here — clamps happen later in Step C)
  click5: 0.95·7.42+2 = 9.05
  ```

  The raw score keeps climbing; the clamp to `[1,5]` happens *inside*
  `profileFusion.loadBehaviorScores` so the ranker only sees bounded
  numbers.

- One `ignore` event pulls a tag back toward (but never below 0 unless
  delta was negative enough): the leaky integrator naturally reverts
  after a long quiet period.

- Every event also writes a row to `Event` (audit trail). The Event
  row carries the *payload* (search query / compare-IDs / etc.) so
  future analytics can reverse-engineer the exact context of a
  behaviour bump.

### 9.5 Frontend event source map

The FE posts events through a fire-and-forget hook at
`frontend/src/hooks/useEventLogger.jsx`:

| FE call                                                  | eventType | phoneId | payload                    |
| -------------------------------------------------------- | --------- | ------- | -------------------------- |
| Card click → navigate to `/phones/:id`                   | `click`   | yes     | `{ card: 'rec' \| 'list' }` |
| `PhoneDetail` mount                                      | `view`    | yes     | (none) — dedup'd inside a 5-second window so dev-mode StrictMode doesn't double-post |
| Search box submit                                        | `search`  | no      | `{ q: <query> }`           |
| Filter apply                                             | `search`  | no      | `{ filters: {...} }`       |
| Compare panel open + submit                              | `compare` | yes (phoneA) — best-effort resolve from modelName | `{ modelNameA, modelNameB }` |
| Wishlist / save                                          | `save`    | yes     | (none)                     |
| Ignore (auto-fired by the dashboard scrolled-past logic) | `ignore`  | yes     | `{ reason: 'scrolled' }`   |

Some events also write to the legacy tables via the
`profileService.safe*Event` wrappers — that *bridge* keeps the admin
UI's "Recent signals", "Behaviours", "Comparisons" sections working
without a rewrite. The `BehaviorScore` table is *always* the
authoritative read for the ranker.

### 9.6 Backend event source map (no FE hop)

| Controller                                         | eventType  | phoneId source                          |
| -------------------------------------------------- | ---------- | --------------------------------------- |
| `recommendController.postRecommend`                | implicit (per call) | per-result `r.id` from FastAPI → SearchHistory bridge; the Event itself is recorded once per *recommend* call by `safeRecordBehaviorEvent(userId, "recommend")` |
| `recommendController.getAutoRecommend`             | same — once per call | (same path) |
| `recommendController.postCompareML`                | `compare`  | best-effort lookup of `modelNameA`/`modelNameB`; both flow into the Event payload even when neither resolves to a phoneId |
| `phoneController.search`                           | `search`   | none — payload `{q, filters}` |
| `phoneController.listing`                          | (none directly — implicit signals come from clicks/filter applies funneled via FE event logger) |  |

The "view" event used to be written by
`profileController.getPhoneDetail` via `safeRecordBrowseEvent`. After
Step B, the controller was simplified to **only** write to the new
`Event` log (via `safeRecordBehaviorEvent(userId, "view", …)`); the
`BrowsingHistory` row that powers the admin "Last 5 browses" feed is
now produced exclusively by the FE on `PhoneDetail` mount.

### 9.7 End-to-end worked example

A user with no questionnaire done (no `CustomerProfile` row, no
`recommendationPersona`) searches for "asus rog", clicks the first
card, opens Compare, and Compare-MLs it against an iPhone. Then they
come back the next day.

1. **Search "asus rog"**
   - FE `useEventLogger("search", { payload: { q: "asus rog" } })` →
     `POST /events` → `Event{ eventType: "search", payload: {q} }`.
   - Analyzer runs `tagsFromSearchQuery("asus rog")` → matches **rog** →
     emits `{ gaming: +1 }` as the *added* deltas (the base
     `DELTAS.search` bucket's `gaming +2, chipset +1` already ran
     through `phoneMetaTags` which is a no-op without a phoneId, so
     only the search-keyword deltas land).

     - Pre-loop `BehaviorScore` for this user was empty.
     - `applyDecay(0, +1, 0.95)` → `gaming` becomes `1.0000`.

2. **Click on the first card (an ASUS ROG Phone 8)**
   - FE `useEventLogger("click", { phoneId, payload: { card: 'list' } })`.
   - Analyzer looks up the phone (cached), resolves `brand:Asus +2`,
     `tier:flagship +1`, `category:camera +1`.
   - Each tag gets `applyDecay(prev, delta)`. New scores:

     ```
     brand:Asus        : 0.95·0 + 2      = 2.0000
     tier:flagship     : 0.95·0 + 1      = 1.0000
     category:camera   : 0.95·0 + 1      = 1.0000
     ```
   - Audit: `Event{eventType: "click", phoneId, payload}`.

3. **Compare ROG 8 vs iPhone 15**
   - FE `useEventLogger("compare", { payload: { modelNameA: 'ROG 8', modelNameB: 'iPhone 15' } })`.
   - Analyzer: no phoneId, so the structural bucket fires:
     `gaming +3`.
   - `behaviorScore.gaming`: `0.95·1.0 + 3 = 3.95`.
   - Also: `safeRecordCompareEvent(userId, { modelNameA, modelNameB })`
     resolves both phones to phoneIds, writes one
     `ComparisonHistory` row, bumps `CustomerProfile.totalComparisons`.

4. **Next day** — dashboard auto-recommender fires.

   - `safeAggregateAfterRecommendation(userId)` runs after the eventual
     recommendation is served, but for this user the Aggregator will
     find zero (or fewer than 5) `RecommendationHistory` rows and
     bail out.

   - `getAutoRecommendations` → `getRecommendations` →
     `buildFusedWeights(userId, …)`:
     - `explicit` is `null` (no questionnaire).
     - `behavior` sums per the `DIM_ALIASES` table:
       `gaming` ← `gaming` + `chipset` from `BehaviorScore` rows.
       `gaming` Score = 3.95, `chipset` Score = 0 → bucket `gaming`
       = 3.95, clamped to `4`.
     - With explicit `null`, we return `{…behavior}` straight,
       so the fused weights for this request = `{ gaming: 4, camera: 1,
       battery: 1, display: 1 }` (the 1s are because `clampToStars`
       lower-bounds at 1 when a dim has no evidence — see
       `loadBehaviorScores`'s nullish branch).

     Wait — re-reading the code, only dims that *have at least one tag*
     end up in `behavior`. So the call sends:
     `{ gaming: 4 }` *only*. FastAPI fills in the rest via its persona
     preset (we passed `persona: allrounder`, the auto-recommend
     default).

   - FastAPI returns 200 phones ranked by `Match_Score` desc (the
     customer_preference sub-score, which used the fused weights).

   - `recommendService` enriches each result with DB data, runs
     `/similarity/score`, loads the `BehaviorScore` map, then
     `fusionRank` recomputes `finalScore = Σ wᵢ·componentᵢ`.

     For the ROG 8 (which the user has clicked), the
     `search_history` sub-score is high because
     `searchHistoryScore` finds `brand:Asus` and `tier:flagship` in
     both the phone tag set and the user tag set. For an iPhone in
     the same window, `search_history` is *0.5* (no overlap) and the
     base `customer_preference` is also middling. So ROG 8 floats
     to the top.

   - Top-3 phones from this call land in the new `RecommendationCall`
     row's `topResults`. Admin "Last recommendation → Top results"
     renders `Asus · ROG Phone 8`, `…` (next two), all with match
     scores.

5. **User clicks their wishlist save on the ROG 8**

   - FE `useEventLogger("save", { phoneId, … })`.
   - Analyzer resolves `brand:Asus +4`, `category:camera +2`.
   - `BehaviorScore.brand:Asus`: `0.95·2.0 + 4 = 5.9` (raw;
     will be summed and clamped inside fusion).
   - Persisted via `safeRecordWishlist` (separate code path —
     writes to `Wishlist` and bumps `CustomerProfile.totalWishlist`).

This entire flow ran with **no questionnaire answers**. The user's
actions alone produced a ranking. The questionnaire answers would only
have *reinforced* or *redirected* the fusion result via the `β = 0.7`
explicit weight.

---

## 10. What "Top results / Last 5 / Behaviour scores" actually mean

| Section                     | Source table          | Refresh rhythm       | What the number tells you |
| --------------------------- | --------------------- | -------------------- | -------------------------- |
| **Behaviour scores** (admin card) | `BehaviorScore`       | per `Event` write (live) | The user's top-N raw tag scores. Useful for debugging — "why is the ranker pushing gaming phones?" |
| **Storage / RAM**           | `CustomerProfile.preferredRamGb` / `preferredStorageGb` | whenever the Aggregator runs (≥ 5 new `RecommendationHistory` rows since last refresh) | Modal-most-frequent variant attributes across the user's last 25 served phones. |
| **Tech tier**               | `CustomerProfile.techTier` | same as Storage / RAM | Modal-most-frequent antutu band of the user's last 25 served phones, bucketed into Budget / Reasonable / FlagshipKiller / TechSavvy / Luxurious. |
| **Last recommendation → Top results** | `RecommendationCall.topResults` (top-3 by matchScore) | one new row per recommendation call | The exact 3 phones the user was shown most recently, with their match scores. Resolved to Brand · Model via the `Phones` join that the writer performs at call time. |
| **Searches** (admin card) | `SearchHistory` | per FE search submit + filter apply | The literal query strings the user has been typing. Truncated to 200 chars before persistence. |
| **Browses**                 | `BrowsingHistory`    | per `PhoneDetail` mount | The raw phone-detail-page views the user has made, with their `phoneLabel` (CSV-style — not FK-resolved). |
| **Comparisons**             | `ComparisonHistory` | per `POST /recommend/compare-ml` | The 5 most recent phone-vs-phone comparisons. Resolved to Brand · Model via the `Phones` join that `getProfileBundle` performs. |

---

## 11. TL;DR — what's new in this iteration

1. **`Storage`, `RAM`, `Tech tier` in the Preference / Customer profile
   section are now populated** — by computing modal values across the
   last 25 recommendation rows.
2. **`Searches` now shows the last 5 search queries** (query string +
   timestamp), not a single number.
3. **`Recommendations` now shows the per-call top-3 phones from the
   most recent recommendation, resolved to `Brand · Model`** — not a
   list of UUIDs.
4. **A new `lastComparisons` section lists the last 5 comparisons**
   with both phones named as `Brand · Model`.
5. **`Browses`** continues to show the last 5 viewed phones — same
   behaviour as before, just clarified in the README.

---

## 12. Files involved

| File                                                        | Role |
| ----------------------------------------------------------- | ---- |
| `backend/prisma/schema.prisma`                              | Tables + enums. New `RecommendationCall` model. |
| `backend/prisma/migrations/.../add_recommendation_call`     | Migration adding `RecommendationCall`. |
| `backend/src/services/profileService.mjs`                   | `getProfileBundle` now resolves `phoneId` → `Brand · Model` and slices searches/browses/comparisons to last 5. |
| `backend/src/services/recommendService.mjs`                 | Writes a `RecommendationCall` row + top-3 entries per call. |
| `backend/src/services/profileAggregator.mjs` (new)          | Modal aggregation of `techTier`, `preferredRamGb`, `preferredStorageGb`. |
| `backend/src/workers/profileAggregatorWorker.mjs` (new)     | Triggers aggregator when ≥ 5 new `RecommendationHistory` rows land. |
| `frontend/src/components/AdminCustomerDetail.jsx`           | Renders the human-readable `Brand · Model` instead of UUIDs; new sections for last 5 searches / browses / comparisons. |
| `frontend/src/components/Dashboard.jsx`                     | Profile hydration keeps working unchanged. |
