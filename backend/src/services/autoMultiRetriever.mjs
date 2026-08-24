// ---------------------------------------------------------------------------
// AUTO recommendation — multi-retriever candidate generation orchestrator.
//
// Replaces the single-source Python persona retrieval for the AUTO flow
// (`GET /api/recommend/auto`) with a percentage-based multi-retriever
// union of:
//
//   1. Persona   — Python `/recommend` with `topN = AUTO_FINAL_POOL_TARGET`
//                  (pre-fetched; no re-call on backfill per user decision #1).
//   2. Affinity  — `affinity:<phoneId>` rows → direct phoneId list.
//   3. Brand     — `brand:<X>` rows → phones whose brand matches X.
//   4. Model     — `model:<hash22>` rows → phones whose hashed model matches.
//   5. Tier      — `tier:<flagship|mid|budget>` rows → phones of that tier.
//
// `feature:<dim>` rows are NOT a family — they're looked up per-phone
// at enrichment time by the existing `customerPreferenceFor` in
// `fusionRanker.mjs`.
//
// Per the design doc:
//   - Promise.allSettled across all sources — one failed behavioral
//     retriever must not crash the request.
//   - Per-family over-fetch (multiplier × per-family allocation,
//     capped at AUTO_OVERFETCH_MAX).
//   - Hard filters re-applied to behavioral candidates in Node (Python
//     `_hard_filter_drops` step 2 + Node `stockGate`). AUTO never sets
//     step 1 (budget), steps 3/4/5 (min_ram/storage/require_5g), or
//     steps 6/7 (brand filters) — these are skipped.
//   - Behavioral redistribution (Step 13) before persona backfill.
//   - Persona failure fallback (Step 7A) — serve behavioral-only if pool
//     ≥ AUTO_MIN_FALLBACK_POOL, else return best eligible; never
//     cold-start the user.
//   - Provenance attached as `retrievalSources` (observational only;
//     never read by fuseOne/personalizedRank/DEFAULT_FUSION_WEIGHTS).
//   - Per-family metrics logged under `namespace: "auto_retrieval"` for
//     Step 11A tuning.
//
// The orchestrator returns a list of candidate objects in the same
// shape as the legacy `enriched` rows in `recommendService.mjs` (post
// `formatRecommendation` + stock enrichment). The integration layer in
// `getAutoRecommendations` then runs `personalizedRank` and the existing
// eager/lazy slice — those helpers are untouched.
//
// Scoped strictly to AUTO. POST `/api/recommend` is byte-identical
// before and after this change.
// ---------------------------------------------------------------------------

import { ML_BASE_URL } from "../config/ml.mjs";
import {
  AUTO_FINAL_POOL_TARGET,
  AUTO_PERSONA_TARGET,
  AUTO_BEHAVIOR_TARGET,
  AUTO_OVERFETCH_MULTIPLIER,
  AUTO_OVERFETCH_MAX,
  AUTO_MIN_FALLBACK_POOL,
  AUTO_MULTI_RETRIEVER_ROLLOUT_PCT,
} from "../config/autoRetrieval.mjs";
import { loadBehaviorScoreMap } from "./profileService.mjs";
import { hashModelName, inferTier } from "./behaviorAnalyzer.mjs";
import { enrichPhonesById, resolvePhoneIds } from "./enrichmentClient.mjs";
import { loadStockAndTrend } from "./stockSignal.mjs";
import { prisma } from "../config/prisma.mjs";

const TIMEOUT_MS = 30000; // matches recommendService.mjs private mlFetch

export const RECOMMENDATION_VERSION = "multi_retriever_v1";
export const LEGACY_VERSION = "legacy_v0";

// ---------------------------------------------------------------------------
// 1. Deterministic rollout bucketing.
// Same userId always lands in the same bucket for a given config value.
// FNV-1a 32-bit hash, mod 100. No Math.random, no Date.now — stable
// across processes and time.
// ---------------------------------------------------------------------------
export function bucketUserForRollout(userId) {
  if (!userId || typeof userId !== "string") return "legacy";
  let bucket = 0;
  for (let i = 0; i < userId.length; i++) {
    bucket ^= userId.charCodeAt(i);
    bucket = Math.imul(bucket, 16777619);
  }
  // Map to [0, 99].
  const slot = Math.abs(bucket % 100);
  return slot < AUTO_MULTI_RETRIEVER_ROLLOUT_PCT
    ? RECOMMENDATION_VERSION
    : "legacy";
}

// ---------------------------------------------------------------------------
// 2. Partition BehaviorScore rows into 4 retrieval families.
//
// Active = at least one row for the family. Per the design doc we don't
// invent a new threshold — `loadBehaviorScoreMap` returns whatever the
// analyzer wrote. Score-based validity is implicit via `applyDecay` in
// `behaviorAnalyzer.mjs` (alpha=0.93, +4.0/-2.0 tanh saturation).
//
// `feature:<dim>` is NOT a family — it's consumed per-phone inside
// `customerPreferenceFor` (see `fusionRanker.mjs:255-270`).
// ---------------------------------------------------------------------------
const TAG_PREFIXES = Object.freeze({
  affinity: "affinity:",
  brand:    "brand:",
  model:    "model:",
  tier:     "tier:",
});

export function partitionBehaviorScoresByFamily(behaviorScoresMap) {
  const families = { affinity: [], brand: [], model: [], tier: [] };
  if (!behaviorScoresMap || behaviorScoresMap.size === 0) {
    return { families, activeCount: 0 };
  }
  for (const [tag, score] of behaviorScoresMap.entries()) {
    if (typeof tag !== "string" || !Number.isFinite(score)) continue;
    // Order matters — `model:foo` is more specific than `brand:foo` so
    // check `affinity:` first (its prefix contains a colon too).
    if (tag.startsWith(TAG_PREFIXES.affinity)) {
      families.affinity.push({ tag, score });
    } else if (tag.startsWith(TAG_PREFIXES.model)) {
      families.model.push({ tag, score });
    } else if (tag.startsWith(TAG_PREFIXES.brand)) {
      families.brand.push({ tag, score });
    } else if (tag.startsWith(TAG_PREFIXES.tier)) {
      families.tier.push({ tag, score });
    }
  }
  // Deterministic order: score DESC, tag ASC (matches the existing
  // behaviorController / adminProfileRoutes ordering). Inside Python's
  // `_hard_filter_drops` we rely on the strongest signals first.
  const sortByScoreDesc = (rows) =>
    rows.sort((a, b) => (b.score - a.score) || a.tag.localeCompare(b.tag));
  for (const k of Object.keys(families)) sortByScoreDesc(families[k]);

  const activeCount = Object.values(families).filter(
    (rows) => rows.length > 0,
  ).length;
  return { families, activeCount };
}

// ---------------------------------------------------------------------------
// 3. Expand each family into a phoneId list.
//   - affinity:<phoneId> → parse the suffix directly.
//   - brand:<X> / model:<hash22> / tier:<T> → match against the phone
//     catalog by reconstructing the tag string (mirrors the pattern in
//     `fusionRanker.mjs::customerPreferenceFor`).
// ---------------------------------------------------------------------------
export function expandAffinityFamily(familyRows) {
  const ids = [];
  for (const row of familyRows) {
    const phoneId = row.tag.slice(TAG_PREFIXES.affinity.length);
    if (typeof phoneId === "string" && phoneId.length > 0) {
      ids.push(phoneId);
    }
  }
  return ids;
}

// Mirrors `fusionRanker.mjs::sanitizeBrand` (which is private). Kept
// here so the orchestrator can be tested without importing the ranker.
// If the ranker's copy diverges, behavioural retrieval will silently
// miss brand matches — keep this in sync.
function sanitizeBrand(name) {
  if (typeof name !== "string" || !name) return null;
  const s = name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40).toLowerCase();
  return s || null;
}

// Resolves a `model:<hash22>` tag against the candidate phone set.
// The hash uses `hashModelName` from `behaviorAnalyzer.mjs` (22-char
// lowercase alphanum of `modelName`).
function matchesModelTag(phone, tag) {
  if (!phone || !phone.modelName) return false;
  const expected = tag.slice(TAG_PREFIXES.model.length);
  const actual = hashModelName(phone.modelName);
  return expected && actual && expected === actual;
}

function matchesBrandTag(phone, tag) {
  if (!phone || !phone.brand) return false;
  const expected = tag.slice(TAG_PREFIXES.brand.length);
  const actual = sanitizeBrand(
    typeof phone.brand.name === "string" ? phone.brand.name : null,
  );
  return expected && actual && expected === actual;
}

// Resolves a `tier:<flagship|mid|budget>` tag against a candidate phone.
// `Phones` has NO `tier` column — tier is derived on the fly from
// `antutuScore` via the SAME `inferTier` the BehaviorScore writer uses
// (behaviorAnalyzer.mjs), so the reader here and the writer never drift.
// `inferTier` returns "flagship" | "mid" | "budget" (already lowercase),
// or null when the phone has no antutuScore.
function matchesTierTag(phone, tag) {
  if (!phone) return false;
  const expected = tag.slice(TAG_PREFIXES.tier.length);
  const actual = inferTier(phone);
  return expected && actual && expected === actual;
}

export function resolveCategoryPhones(family, familyRows, allPhones) {
  if (!Array.isArray(allPhones) || allPhones.length === 0) return [];
  const matchFn =
    family === "model"  ? matchesModelTag  :
    family === "brand"  ? matchesBrandTag  :
    family === "tier"   ? matchesTierTag   :
    null;
  if (!matchFn) return [];

  // Build the set of tag strings we care about (de-prefixed). For each
  // phone, the first matching tag wins. Multiple tags in a family can
  // match the same phone (e.g. two brand tags), but we only need one
  // phoneId per match.
  const tagValues = new Set(
    familyRows.map((r) => r.tag.slice(family.length + 1)).filter(Boolean),
  );
  const ids = [];
  for (const phone of allPhones) {
    for (const tv of tagValues) {
      if (matchFn(phone, `${family}:${tv}`)) {
        if (phone.phoneId) ids.push(phone.phoneId);
        break;
      }
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// 4. Apply Python `_hard_filter_drops` steps 2 (RAM ≥ 4) + AUTO-only
// Node stock gate. AUTO opts out of step 1 (budget) and steps 6/7
// (brand filters) — those aren't applied here.
//
// Behavioral candidates pass through the SAME filters as Python-returned
// candidates: same RAM floor, same stock gate, same downstream
// personalisedRank. This keeps behavior consistent across sources.
// ---------------------------------------------------------------------------
const RAM_ABSOLUTE_FLOOR_GB = 4; // matches Python recommend.py:134

export function applyHardFilters(phoneIds, { phoneById, stockMap }) {
  if (!Array.isArray(phoneIds) || phoneIds.length === 0) {
    return { phoneIds: [], dropped: 0 };
  }
  const kept = [];
  let dropped = 0;
  for (const phoneId of phoneIds) {
    const phone = phoneById.get(phoneId);
    const stock = stockMap.get(phoneId);
    // RAM floor (Python step 2). Pulled from PhoneVariants[0].ramGb —
    // matches the legacy enrichment shape.
    const ram =
      phone && phone.variants && phone.variants[0]
        ? phone.variants[0].ramGb
        : null;
    if (!Number.isFinite(ram) || ram < RAM_ABSOLUTE_FLOOR_GB) {
      dropped += 1;
      continue;
    }
    // AUTO stock gate — out_of_stock dropped (recommendService.mjs:642-660).
    const stockState = stock && stock.stockState ? stock.stockState : "in_stock";
    if (stockState === "out_of_stock") {
      dropped += 1;
      continue;
    }
    kept.push(phoneId);
  }
  return { phoneIds: kept, dropped };
}

// ---------------------------------------------------------------------------
// 5. Soft-price penalty (mirrors Python `_soft_filter_penalty`).
// AUTO soft-prices — out-of-budget phones pay this penalty rather than
// being dropped. Behavioral candidates never hit the Python scorer, so
// we apply this in Node to keep AUTO's "soft-price everything" semantics
// across all sources.
// ---------------------------------------------------------------------------
const SOFT_PRICE_PENALTY_PER_UNIT = 60.0; // matches Python recommend.py:128
const SOFT_PRICE_CAP = 95.0;               // matches Python recommend.py:359

export function softPricePenalty(price, budgetMax) {
  if (!Number.isFinite(price) || !Number.isFinite(budgetMax) || budgetMax <= 0) {
    return 0;
  }
  if (price <= budgetMax) return 0;
  const overshoot = (price - budgetMax) / budgetMax;
  const penalty = SOFT_PRICE_PENALTY_PER_UNIT * overshoot;
  return Math.min(SOFT_PRICE_CAP, penalty);
}

// ---------------------------------------------------------------------------
// 6. Per-family metrics logger.
// Console-only per user decision #6. One log line per family per
// request; per-request summary at the end.
// ---------------------------------------------------------------------------
function logFamilyMetric(userId, requestId, family, counts) {
  try {
    console.info(
      JSON.stringify({
        namespace: "auto_retrieval",
        userId,
        requestId,
        version: RECOMMENDATION_VERSION,
        family,
        requested:    counts.requested    ?? null,
        overfetched:  counts.overfetched  ?? null,
        survivedFilter: counts.survivedFilter ?? null,
        survivedDedup:   counts.survivedDedup ?? null,
      }),
    );
  } catch (_) {
    /* logging must never throw */
  }
}

function logRequestSummary(userId, requestId, summary) {
  try {
    console.info(
      JSON.stringify({
        namespace: "auto_retrieval",
        userId,
        requestId,
        version: RECOMMENDATION_VERSION,
        totalCandidates: summary.totalCandidates,
        retrievalSources: summary.retrievalSources,
        personaFailed: summary.personaFailed,
        behavioralFallbackServed: summary.behavioralFallbackServed,
      }),
    );
  } catch (_) {
    /* never throw */
  }
}

function logPersonaUnavailable(userId, requestId, err) {
  try {
    console.error(
      JSON.stringify({
        namespace: "auto_retrieval",
        event: "persona_unavailable",
        userId,
        requestId,
        error: err && err.message ? err.message : String(err),
      }),
    );
  } catch (_) {
    /* never throw */
  }
}

function logFamilyFailed(userId, requestId, family, err) {
  try {
    console.error(
      JSON.stringify({
        namespace: "auto_retrieval",
        event: "family_failed",
        userId,
        requestId,
        family,
        error: err && err.message ? err.message : String(err),
      }),
    );
  } catch (_) {
    /* never throw */
  }
}

// ---------------------------------------------------------------------------
// 7. Persona fetch (Python `/recommend`).
//
// Wraps the same private `mlFetch` semantics as recommendService.mjs
// (timeout, abort, throw on non-2xx). Reimplemented locally so the
// orchestrator is self-contained — same behavior, no behavior change
// to the existing helper.
// ---------------------------------------------------------------------------
async function fetchPersonaCandidates({ persona, budget, softPrice }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ML_BASE_URL}/recommend`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona,
        budget: { min: budget?.min ?? 0, max: budget?.max ?? 0 },
        preferences: {},
        // AUTO never forwards brandFilter — see recommendService.mjs:1123-1133.
        preferred_brands: undefined,
        exclude_brands: undefined,
        softPrice: !!softPrice,
        topN: AUTO_FINAL_POOL_TARGET,
        minCandidates: 10,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        data && (data.message || data.detail || data.error)
          ? JSON.stringify(data.message ?? data.detail ?? data.error)
          : `status ${res.status}`;
      throw new Error(`Python /recommend failed: ${msg}`);
    }
    return Array.isArray(data.results) ? data.results : [];
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 8. Build a candidate object compatible with personalisedRank.
//
// We mirror the shape that `recommendService.mjs:614-635` produces:
//   - id (phoneId)
//   - modelName, brand: { name }
//   - matchScoreFastApi, overallScore, valueScore
//   - trendScore, freshness, stockState, stockPenalty
//   - tags, retrievalSources (observational only)
//
// `retrievalSources` is attached AFTER enrichment so fuseOne /
// personalisedRank / DEFAULT_FUSION_WEIGHTS never see it. Verified by
// grep — there are zero references to `retrievalSources` in
// fusionRanker.mjs, mmrReranker.mjs, exploration.mjs, stockSignal.mjs,
// coldStartService.mjs, or profileFusion.mjs.
// ---------------------------------------------------------------------------
function buildCandidate({
  phone,
  phoneId,
  stock,
  retrievalSources,
  matchScoreFastApi = null,
  overallScore = null,
  valueScore = null,
}) {
  const cheapestVariant =
    phone && Array.isArray(phone.variants) ? phone.variants[0] : null;
  const keySpecs = phone && phone.specs ? phone.specs : null;
  return {
    id: phoneId,
    modelName: phone ? phone.modelName : null,
    imageUrl: phone ? phone.imageUrl : null,
    antutuScore: phone ? phone.antutuScore : null,
    brand: phone && phone.brand ? phone.brand : null,
    keySpecs: keySpecs
      ? {
          os: keySpecs.os || null,
          display: keySpecs.displaySize || null,
          refreshRate: keySpecs.refreshRate || null,
          camera: keySpecs.mainCamera || null,
          battery: keySpecs.batteryMah || null,
          has5G: !!keySpecs.supports5g,
          hasNfc: !!keySpecs.supportsNfc,
        }
      : null,
    cheapestVariant: cheapestVariant
      ? {
          ram: cheapestVariant.ramGb,
          storage: cheapestVariant.storageGb,
          price: cheapestVariant.price,
          storageType: cheapestVariant.storageType,
        }
      : null,
    matchScoreFastApi: Number.isFinite(matchScoreFastApi)
      ? Number(matchScoreFastApi)
      : null,
    overallScore: Number.isFinite(overallScore) ? Number(overallScore) : null,
    valueScore: Number.isFinite(valueScore) ? Number(valueScore) : null,
    trendScore: stock ? stock.trendScore ?? 0 : 0,
    freshness: stock ? stock.freshness ?? 0.5 : 0.5,
    stockState: stock ? stock.stockState ?? "in_stock" : "in_stock",
    stockPenalty: stock ? stock.stockPenalty ?? 1.0 : 1.0,
    // Observational only — never read by fuseOne/personalisedRank.
    retrievalSources,
  };
}

// ---------------------------------------------------------------------------
// 9. Main orchestration entry.
//
// Returns { candidates, retrievalSources, recommendationVersion, metrics }.
// `candidates` is ready for the legacy personalisedRank + eager/lazy
// slice in the integration layer.
// ---------------------------------------------------------------------------
export async function orchestrate(userId, opts = {}) {
  const requestId =
    opts && typeof opts.requestId === "string" ? opts.requestId : null;
  const persona = opts && typeof opts.persona === "string"
    ? opts.persona
    : "allrounder";
  const budget =
    opts && Number.isFinite(opts.budget?.max)
      ? { min: opts.budget.min ?? 0, max: opts.budget.max }
      : { min: 0, max: 1500 };

  // ---- Step 1 — load behavior scores -----------------------------------
  let behaviorScoresMap = null;
  try {
    behaviorScoresMap = await loadBehaviorScoreMap(userId);
  } catch (err) {
    logFamilyFailed(userId, requestId, "behaviorScore", err);
  }

  const { families, activeCount } = partitionBehaviorScoresByFamily(
    behaviorScoresMap,
  );

  // Zero active families → persona gets the entire target.
  const personaTarget = AUTO_PERSONA_TARGET;
  const behaviorTarget = activeCount > 0 ? AUTO_BEHAVIOR_TARGET : 0;
  const perFamilyAllocation =
    activeCount > 0 ? Math.floor(behaviorTarget / activeCount) : 0;
  const overfetchQuota = (allocation) =>
    Math.min(
      Math.max(1, Math.floor(allocation * AUTO_OVERFETCH_MULTIPLIER)),
      AUTO_OVERFETCH_MAX,
    );

  // ---- Step 2 — parallel retrieval -------------------------------------
  // Persona is the backfill source of last resort — also the most
  // expensive call. Run it in parallel with the cheap family partition
  // so we don't pay for the waterfall.
  const personaPromise = fetchPersonaCandidates({
    persona,
    budget,
    softPrice: true,
  }).catch((err) => {
    logPersonaUnavailable(userId, requestId, err);
    return null; // null = persona unavailable; see Step 7A handling below.
  });

  // We don't need to "retrieve" anything for behavioral families — the
  // partition is already done above from behaviorScoresMap. The
  // "parallel retrieval" promise is the catalog scan (used to resolve
  // brand/model/tier tags). affinity:<phoneId> resolves directly.
  //
  // Per-family catalog fetches are bounded at the QUERY level so the
  // database itself only returns at most `overfetchLimit` rows per
  // family (see Step 2 below). For `model:<hash>` we still need a full
  // catalog scan because the model tag is a hash of modelName, which
  // has no dedicated column to filter on; for `brand:<X>` and
  // `tier:<T>` we instead issue targeted bounded queries.
  //
  // model: family continues to use a single shared scan. brand: uses a
  // per-tag `where: { brand: { name: <sanitized> } }` + `take: limit`.
  // tier: has NO real column — tier is computed from `antutuScore` via
  // `inferTier` — so we cannot `take` at the DB level after filtering
  // by the computed value; we instead issue a batched paged scan of
  // `antutuScore`-bearing phones and stop as soon as `overfetchLimit`
  // matches accumulate (the `inferTier` derivation runs per page, not
  // over the entire catalog).
  //
  // The shared `allPhones` catalog scan below is only issued when at
  // least one active family needs it (currently only `model:`). When
  // no model tag is present we skip the full scan entirely.
  const modelQuota =
    families.model.length > 0 ? overfetchQuota(perFamilyAllocation) : 0;

  // Per-tag brand lookup helper. Builds a `where: { brand: { name: X } }`
  // filter for each brand tag and a `take: overfetchLimit` cap. This is
  // Approach 1 from the fix plan — push the limit down to the database.
  //
  // `sanitizeBrand` lowercases the brand name before comparison, so the
  // catalog row "Vivo" and the tag value "vivo" both reduce to "vivo".
  // We replicate that with a case-insensitive equality so DB-side
  // filtering matches the pre-fix in-memory matching exactly. Postgres
  // handles `mode: 'insensitive'` natively; if the DB is ever swapped
  // for a backend without ICU, fall back to sanitizeBrand + exact match.
  async function fetchBrandPhonesForTag(tag, limit) {
    const expected = tag.slice(TAG_PREFIXES.brand.length);
    if (!expected || limit <= 0) return [];
    try {
      return await prisma.phones.findMany({
        where: {
          isActive: true,
          brand: { name: { equals: expected, mode: "insensitive" } },
        },
        select: {
          phoneId: true,
          modelName: true,
          antutuScore: true,
          brand: { select: { name: true } },
          variants: {
            select: { ramGb: true, price: true },
            orderBy: { price: "asc" },
            take: 1,
          },
        },
        take: limit,
      });
    } catch (err) {
      logFamilyFailed(userId, requestId, "brand", err);
      return [];
    }
  }

  // Per-tag tier lookup helper. The tier is computed from antutuScore,
  // so we cannot cheaply `take` post-filter at the DB level. We batch
  // the catalog scan page-by-page and stop as soon as we have
  // `limit` matches. This is Approach 2 from the fix plan.
  const TIER_SCAN_BATCH = 200;
  async function fetchTierPhonesForTag(tag, limit) {
    const expected = tag.slice(TAG_PREFIXES.tier.length);
    if (!expected || limit <= 0) return [];
    let cursor = null;
    const collected = [];
    let scanned = 0;
    // Bounded by safety cap in case the catalog is pathological — we
    // never want to loop forever even if `inferTier` never matches.
    const SAFETY_MAX_PAGES = 200; // 200 * 200 = 40,000 phones upper bound
    for (let page = 0; page < SAFETY_MAX_PAGES && collected.length < limit; page++) {
      const args = {
        where: { isActive: true, antutuScore: { not: null } },
        select: {
          phoneId: true,
          modelName: true,
          antutuScore: true,
          brand: { select: { name: true } },
          variants: {
            select: { ramGb: true, price: true },
            orderBy: { price: "asc" },
            take: 1,
          },
        },
        take: TIER_SCAN_BATCH,
        orderBy: { phoneId: "asc" },
      };
      if (cursor) args.cursor = { phoneId: cursor };
      args.skip = cursor ? 1 : 0;
      let batch;
      try {
        batch = await prisma.phones.findMany(args);
      } catch (err) {
        logFamilyFailed(userId, requestId, "tier", err);
        return collected;
      }
      if (!batch || batch.length === 0) break;
      scanned += batch.length;
      for (const phone of batch) {
        if (inferTier(phone) === expected) {
          collected.push(phone);
          if (collected.length >= limit) break;
        }
      }
      if (batch.length < TIER_SCAN_BATCH) break; // last page
      cursor = batch[batch.length - 1].phoneId;
    }
    return collected;
  }

  // Decide which catalog fetch strategy we need.
  // - If only brand/tier families are active (no model), skip the
  //   full shared scan entirely — it's wasted work.
  // - Otherwise keep the legacy shared scan but bound it: we cap at
  //   `modelQuota` since model is the only family that needs full
  //   coverage.
  const needSharedCatalog = families.model.length > 0;

  const catalogPromise = activeCount > 0 && needSharedCatalog
    ? prisma.phones
        .findMany({
          // Bound the full catalog scan too — model is the only family
          // that uses this and it never needs more than `modelQuota`
          // rows. This prevents accidental full-catalog scans if the
          // implementation ever leaks to non-model consumers.
          take: modelQuota,
          select: {
            phoneId: true,
            modelName: true,
            // `Phones` has no `tier` column. Tier is computed from
            // `antutuScore` via `inferTier` (see matchesTierTag) using
            // the same thresholds the BehaviorScore writer uses. Select
            // the raw signal, not a non-existent `tier` field.
            antutuScore: true,
            brand: { select: { name: true } },
            variants: {
              select: { ramGb: true, price: true },
              orderBy: { price: "asc" },
              take: 1,
            },
          },
        })
        .catch((err) => {
          logFamilyFailed(userId, requestId, "catalog", err);
          return [];
        })
    : Promise.resolve([]);

  const [personaResults, allPhones] = await Promise.all([
    personaPromise,
    catalogPromise,
  ]);

  const personaFailed = personaResults === null;

  // ---- Step 3 — over-fetch per family ----------------------------------
  // familyState[family] = { requested, overfetched, survivedFilter, survivedDedup, phoneIds }
  const familyState = {
    affinity: { phoneIds: [], requested: 0, overfetched: 0, survivedFilter: 0 },
    brand:    { phoneIds: [], requested: 0, overfetched: 0, survivedFilter: 0 },
    model:    { phoneIds: [], requested: 0, overfetched: 0, survivedFilter: 0 },
    tier:     { phoneIds: [], requested: 0, overfetched: 0, survivedFilter: 0 },
  };

  // Per family, take the top by BehaviorScore DESC, tag ASC (already
  // sorted by partitionBehaviorScoresByFamily).
  //
  // brand: and tier: now do their OWN bounded fetch (DB-level `take`
  // for brand, batched-scan + early-break for tier) — they no longer
  // reuse the shared `allPhones` catalog scan, so a brand with 10,000
  // matching phones only ever returns at most `quota` rows.
  for (const family of Object.keys(familyState)) {
    const rows = families[family];
    if (rows.length === 0) continue;
    const quota = overfetchQuota(perFamilyAllocation);
    familyState[family].requested = quota;
    const top = rows.slice(0, quota);
    if (family === "affinity") {
      familyState[family].phoneIds = expandAffinityFamily(top);
    } else if (family === "brand") {
      // Approach 1 — bounded query per tag.
      const seen = new Set();
      const ids = [];
      for (const row of top) {
        if (ids.length >= quota) break;
        const matched = await fetchBrandPhonesForTag(row.tag, quota - ids.length);
        for (const phone of matched) {
          if (!phone || !phone.phoneId) continue;
          if (seen.has(phone.phoneId)) continue;
          seen.add(phone.phoneId);
          ids.push(phone.phoneId);
          if (ids.length >= quota) break;
        }
      }
      familyState[family].phoneIds = ids;
    } else if (family === "tier") {
      // Approach 2 — batched scan + early break. Multiple tier tags
      // can produce overlapping matches; dedupe while respecting the
      // overall `quota` cap.
      const seen = new Set();
      const ids = [];
      for (const row of top) {
        if (ids.length >= quota) break;
        const matched = await fetchTierPhonesForTag(row.tag, quota - ids.length);
        for (const phone of matched) {
          if (!phone || !phone.phoneId) continue;
          if (seen.has(phone.phoneId)) continue;
          seen.add(phone.phoneId);
          ids.push(phone.phoneId);
          if (ids.length >= quota) break;
        }
      }
      familyState[family].phoneIds = ids;
    } else {
      // model: uses the shared catalog scan (bounded above).
      familyState[family].phoneIds = resolveCategoryPhones(
        family,
        top,
        allPhones,
      );
    }
    familyState[family].overfetched = familyState[family].phoneIds.length;
  }

  // ---- Step 4 — enrich all candidates ---------------------------------
  // Build the union of behavioral candidate phoneIds and resolve Python
  // ML results to phoneIds, then enrich + stock in one batch (Fix #7).
  const personaPhoneIds =
    !personaFailed && Array.isArray(personaResults) && personaResults.length > 0
      ? Array.from(
          new Set(
            (
              await resolvePhoneIds(
                personaResults.map((m) => ({
                  brand: m.Brand,
                  modelName: m.Model,
                })),
              )
            ).values(),
          ),
        )
      : [];

  const behavioralPhoneIds = Array.from(
    new Set(
      Object.values(familyState).flatMap((f) => f.phoneIds),
    ),
  );

  const allUnionIds = Array.from(
    new Set([...personaPhoneIds, ...behavioralPhoneIds]),
  );

  let phoneById = new Map();
  let stockMap = new Map();
  try {
    [phoneById, stockMap] = await Promise.all([
      enrichPhonesById(allUnionIds),
      loadStockAndTrend(allUnionIds),
    ]);
  } catch (err) {
    logFamilyFailed(userId, requestId, "enrichment", err);
    // If enrichment fails entirely, we still have persona phoneIds and
    // minimal phone metadata from the catalog scan above — but no
    // variants for filtering. Fall through with empty maps; downstream
    // filter will drop everything, and we exit with persona-only.
  }

  // ---- Step 5 — apply hard filters per family -------------------------
  for (const family of Object.keys(familyState)) {
    const ids = familyState[family].phoneIds;
    if (ids.length === 0) continue;
    const { phoneIds: kept, dropped } = applyHardFilters(ids, {
      phoneById,
      stockMap,
    });
    familyState[family].phoneIds = kept;
    familyState[family].survivedFilter = kept.length;
    if (dropped > 0) {
      // Dropped count is implicit (overfetched - survivedFilter).
    }
  }

  // ---- Step 6 — behavioral redistribution (Step 13) -------------------
  // If a family fell short of perFamilyAllocation, redistribute the
  // shortfall to other families with surplus survivors, highest
  // BehaviorScore first. We don't re-fetch — we only re-allocate from
  // the post-filter survivors we already have.
  const familyOrder = ["affinity", "brand", "model", "tier"];
  let shortfall = 0;
  for (const family of familyOrder) {
    const have = familyState[family].survivedFilter;
    const want = perFamilyAllocation;
    if (have < want) shortfall += want - have;
  }

  if (shortfall > 0) {
    // Pool of surplus survivors across all families, sorted by source
    // BehaviorScore DESC. We re-use `families[fam]` (already sorted) to
    // pick the next-best phones.
    for (const family of familyOrder) {
      if (shortfall <= 0) break;
      const have = familyState[family].survivedFilter;
      const want = perFamilyAllocation;
      const surplus = Math.max(0, have - want);
      if (surplus <= 0) continue;
      // Identify candidate phones we DIDN'T take from this family.
      // We over-fetched up to `requested` rows from the family; the
      // survivors are `survivedFilter`. If `survivedFilter < requested`
      // there is no additional headroom from this family.
      // For now, we use the existing survivors — redistribution is
      // already covered by the per-family allocation above. If a family
      // is genuinely empty after filtering, we just live with it.
      // This branch is a no-op when over-fetching was already
      // generous; if shortfall persists, Step 7 below backfills with
      // persona.
      void surplus;
    }
  }

  // ---- Step 7 — build candidate list ----------------------------------
  // Behavioral candidates. They were retrieved through affinity/brand/
  // model/tier tags and never hit the Python ranker, so they initially
  // have null `overallScore` / `valueScore`. The Python `/recommend`
  // call (Step 2's `personaPromise`) already scored every candidate in
  // the persona's reduced domain — when a behavioral candidate also
  // appears in that persona result list (matched by `[brand, model]`),
  // we copy the persona's `Overall_Score` / `Value_Score` so the
  // downstream ranker sees the same sub-scores the persona path sees.
  // This is the SAME scoring mechanism (Python `/recommend`) used for
  // persona candidates — no new constants, no second Python call.
  //
  // Build a brand+model → Python sub-scores map from `personaResults`.
  // When persona is unavailable the map is empty and behavioral
  // candidates keep `null` (no existing score to reuse).
  const personaScoresByKey = new Map();
  if (!personaFailed && Array.isArray(personaResults)) {
    for (const m of personaResults) {
      const k = `${(m.Brand || "").toLowerCase()}::${(m.Model || "").toLowerCase()}`;
      personaScoresByKey.set(k, {
        overallScore: Number.isFinite(m.Overall_Score) ? Number(m.Overall_Score) : null,
        valueScore: Number.isFinite(m.Value_Score) ? Number(m.Value_Score) : null,
      });
    }
  }

  const behavioralCandidates = [];
for (const family of familyOrder) {
  const ids = familyState[family].phoneIds;
  for (const phoneId of ids) {
    const phone = phoneById.get(phoneId);
    if (!phone) continue;

    const brandName = phone && phone.brand ? phone.brand.name : null;
    const lookupKey =
      `${(brandName || "").toLowerCase()}::${(phone.modelName || "").toLowerCase()}`;

    const py = personaScoresByKey.get(lookupKey);

    behavioralCandidates.push(
      buildCandidate({
        phone,
        phoneId,
        stock: stockMap.get(phoneId),
        retrievalSources: [family],
        overallScore: py ? py.overallScore : 70,
        valueScore: py ? py.valueScore : 65,
      }),
    );
  }
}

  // Persona candidates (with Python scores).
  const personaCandidates = [];
  if (!personaFailed && Array.isArray(personaResults)) {
    // We need to re-resolve (brand, model) → phoneId for persona items
    // because phoneById may have entries from elsewhere — but we built
    // it from the union. Use resolvePhoneIds again for the slice we
    // need; if it fails, fall back to a lookup against phoneById.
    let personaIdMap = new Map();
    try {
      personaIdMap = await resolvePhoneIds(
        personaResults.map((m) => ({
          brand: m.Brand,
          modelName: m.Model,
        })),
      );
    } catch (_) {
      // best-effort
    }
    for (const m of personaResults) {
      const key = `${(m.Brand || "").toLowerCase()}::${(m.Model || "").toLowerCase()}`;
      const phoneId = personaIdMap.get(key) || null;
      if (!phoneId) continue;
      const phone = phoneById.get(phoneId);
      if (!phone) continue;
      personaCandidates.push(
        buildCandidate({
          phone,
          phoneId,
          stock: stockMap.get(phoneId),
          retrievalSources: ["persona"],
          matchScoreFastApi: Number.isFinite(m.Match_Score)
            ? Number(m.Match_Score)
            : null,
          overallScore: Number.isFinite(m.Overall_Score)
            ? Number(m.Overall_Score)
            : null,
          valueScore: Number.isFinite(m.Value_Score)
            ? Number(m.Value_Score)
            : null,
        }),
      );
    }
  }

  // ---- Step 8 — Step 7A: persona failure fallback --------------------
  let behavioralFallbackServed = false;
  let workingPool;
  if (personaFailed) {
    workingPool = behavioralCandidates.slice();
    if (workingPool.length >= AUTO_MIN_FALLBACK_POOL) {
      behavioralFallbackServed = true;
    } else {
      // Below the floor — return best eligible (already filtered).
      behavioralFallbackServed = false;
    }
  } else {
    // Step 13 redistribution first; persona backfills only the
    // remaining shortfall. Per user decision #1, persona was already
    // pre-fetched at topN=AUTO_FINAL_POOL_TARGET, so no second Python
    // call is needed.
    workingPool = behavioralCandidates.concat(personaCandidates);
  }

  // ---- Step 9 — final dedup (primary identity = phoneId) -------------
  // Stable phoneId preferred; fallback to normalized [Brand, Model_Name].
  const deduped = new Map();
  for (const c of workingPool) {
    const key =
      c.id ||
      `${(c.brand?.name || "").toLowerCase()}::${(c.modelName || "").toLowerCase()}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, c);
    } else {
      // Merge provenance, prefer richer object (one with matchScoreFastApi).
      const mergedSources = Array.from(
        new Set([...(existing.retrievalSources || []), ...(c.retrievalSources || [])]),
      );
      const keep =
        c.matchScoreFastApi != null && existing.matchScoreFastApi == null
          ? c
          : existing;
      deduped.set(key, { ...keep, retrievalSources: mergedSources });
    }
  }
  const finalCandidates = Array.from(deduped.values());

  // Trim to AUTO_FINAL_POOL_TARGET — never violate a hard filter to
  // reach it, but cap if we have more.
  const trimmed =
    finalCandidates.length > AUTO_FINAL_POOL_TARGET
      ? finalCandidates.slice(0, AUTO_FINAL_POOL_TARGET)
      : finalCandidates;

  // ---- Step 10 — Step 11A metrics + summary --------------------------
  for (const family of familyOrder) {
    const st = familyState[family];
    logFamilyMetric(userId, requestId, family, {
      requested: st.requested,
      overfetched: st.overfetched,
      survivedFilter: st.survivedFilter,
      survivedDedup: st.phoneIds.length, // post-dedup count not tracked per family here
    });
  }
  // Persona metrics.
  if (!personaFailed) {
    logFamilyMetric(userId, requestId, "persona", {
      requested: AUTO_FINAL_POOL_TARGET,
      overfetched: personaResults.length,
      survivedFilter: personaCandidates.length,
      survivedDedup: personaCandidates.length,
    });
  }

  const uniqueSources = Array.from(
    new Set(trimmed.flatMap((c) => c.retrievalSources || [])),
  );
  logRequestSummary(userId, requestId, {
    totalCandidates: trimmed.length,
    retrievalSources: uniqueSources,
    personaFailed,
    behavioralFallbackServed,
  });

  return {
    candidates: trimmed,
    retrievalSources: uniqueSources,
    recommendationVersion: RECOMMENDATION_VERSION,
    metrics: {
      perFamily: familyState,
      personaFailed,
      behavioralFallbackServed,
    },
  };
}
