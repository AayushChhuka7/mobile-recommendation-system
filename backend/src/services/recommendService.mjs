import { ML_BASE_URL } from "../config/ml.mjs";
import { badRequest, internal } from "../utils/ApiError.mjs";
import { prisma } from "../config/prisma.mjs";
import { buildFusedWeights } from "./profileFusion.mjs";
import { fusionRank, personalizedRank } from "./fusionRanker.mjs";
import { fetchContentSimilarity } from "./similarityClient.mjs";
import { phoneToTags } from "./searchHistoryScore.mjs";
import { buildShortTermInterest } from "./shortTermInterest.mjs";
import { resolvePhoneIds, enrichPhonesById } from "./enrichmentClient.mjs";
import { loadStockAndTrend, applyStockPenalty } from "./stockSignal.mjs";
import { mmrRerank } from "./mmrReranker.mjs";
import { applyExploration } from "./exploration.mjs";
import {
  getProfileBundle,
  loadBehaviorScoreMap,
  getRecentEvents,
  loadPhoneMetaMap,
  loadUserLikedAndViewed,
  safeRecordRecommendationLog,
} from "./profileService.mjs";


// Auto-recommend pulls FULL_LIST_TOP_N candidates back from the
// Python ranker (default 200). With ~8.4k catalog rows × 9 per-dim
// scores, a cold-cache topN=200 call regularly exceeds 8s on the
// ML side — the prior default made every dashboard mount fail
// with "ML service timed out". Bumped to 30s so the eager call
// reliably returns, while the auto path keeps the cache-hot
// per-call latency below ~10s. The lazy /recommend/slice path
// also reuses this same timeout (it asks for topN=200 again by
// default in `getRecommendationsSlice`).
const TIMEOUT_MS = 30000;

// Eager slice shipped in the first response (#8 — pagination).
// Lazy expansion fetches the next LAZY_BATCH on FE scroll.
const EAGER_TOP_N = 60;
const LAZY_BATCH = 30;

// MMR rerank window. Only the top-50 of the 200 candidates is
// re-ordered by diversity. The remaining 150 keep their relevance
// order so the long tail is still relevance-dominant.
const MMR_TOP_K = 50;
const MMR_LAMBDA = 0.78;

// Exploration pass (#6) is also gated by relevance in the top-50.
// Outside that window the slot injection would land on a phone the
// user is unlikely to ever see.
const EXPLORATION_TOP_K = 50;

// Soft-constraint candidate floor. If the BE forwards min_candidates
// to the Python side, the ranker widens constraints to keep at
// least this many candidates in the pool (#2). Matches the Python
// default in `recommend.py::MIN_CANDIDATES`.
const MIN_CANDIDATES = 10;

// De-duplicate a recommendation list by a stable identity key.
//
// The ML ranker already de-dupes by `[Brand, Model_Name]` before
// returning (see `ML Model/pipeline/recommend.py::recommend` lines
// 156–159), and the BE's enrichment step does a best-effort
// `findFirst` per ML item. In practice the same DB row can still be
// returned under multiple ML items when model/brand names share a
// substring (the BE enrichment uses Prisma `contains`, not `equals`),
// and the FE renders one card per result entry. That produced visible
// duplicates in the "Recommend Me a Phone" output.
//
// This helper enforces the API contract: the served recommendation
// list never contains duplicate phones. Ranking is preserved by
// `first-occurrence wins` — both pipelines sort by score desc before
// calling this, so the kept row is always the highest-ranked one for
// that identity. For entries that didn't match a DB row (`id` is
// null), we fall back to the `[brand, modelName]` pair so an
// unmatched phone is still only shown once.
const dedupeByStableId = (list) => {
  if (!Array.isArray(list) || list.length === 0) return list;
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = item && item.id
      ? String(item.id)
      : `${item?.brand?.name || ""}::${item?.modelName || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
};

// Issue 1 fix — default topN is now large enough to surface the full
// ranked catalog in the recs panel instead of a top-6 picks list.
// The ranker still returns phones in `Match_Score` desc order; widening
// the slice just exposes more of the same ordering.
const FULL_LIST_TOP_N = 200;

// Cap the per-call impression log at this many rows. The ranker can
// serve up to FULL_LIST_TOP_N candidates; logging every one would
// spam `recommendation_logs` for marginal analytics value (the top-N
// are the ones the user actually sees and interacts with).
const REC_LOG_WRITE_CAP = 50;

// Two-stage "Recommend Me a Phone" pipeline tunables.
//
// STAGE1_TOP_N — size of the reduced candidate domain returned by the
// rule-based stage. The rule-based stage (FastAPI /recommend) applies
// all the user's hard filters (budget, brand, RAM, 5G, persona weights)
// and returns the top-N matches. The content-based stage then re-ranks
// ONLY this set, not the full catalog, so we want it large enough that
// the top-5 by content similarity are high quality but small enough to
// keep the similarity call cheap.
const STAGE1_TOP_N = 200;

// STAGE2_FINAL_TOP_N — phones returned to the FE for the click flow.
// Hard requirement: exactly 5.
const STAGE2_FINAL_TOP_N = 5;

// Coerce any value into a clean one-line human message for error
// envelopes. Avoids the "[object Object]" trap when FastAPI replies
// with a 422 carrying a `detail: [{msg, loc, type}, ...]` array
// (or any other non-string payload).
const describeError = (value) => {
  if (value == null) return "ML service error";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    // FastAPI / pydantic validation error shape: [{msg, loc, type}, ...]
    const parts = value
      .map((entry) => {
        if (!entry) return null;
        if (typeof entry === "string") return entry;
        const where = Array.isArray(entry.loc) ? entry.loc.join(".") : null;
        const msg = typeof entry.msg === "string" ? entry.msg : null;
        return [where, msg].filter(Boolean).join(": ") || null;
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join("; ") : JSON.stringify(value);
  }
  if (typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    if (typeof value.detail === "string") return value.detail;
    if (typeof value.error === "string") return value.error;
    try {
      return JSON.stringify(value);
    } catch {
      return "ML service error";
    }
  }
  return String(value);
};

// Pull a clean error message out of a caught value, falling back
// through err.cause → err.message → a generic string. Avoids the
// template-literal `[object Object]` smell when upstream errors are
// non-stringified.
const safeErrorMessage = (err) => {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  const fromMessage = describeError(err.message);
  if (fromMessage !== "ML service error") return fromMessage;
  if (err.cause) {
    const fromCause = describeError(err.cause?.message ?? err.cause);
    if (fromCause) return fromCause;
  }
  return err.name || "unknown error";
};

const mlFetch = async (path, options = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${ML_BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      // Build a single readable message from whatever FastAPI sent.
      // Common shapes: {message: "..."}, {detail: "..."},
      // {detail: [{msg, loc, type}, ...]} (422 validation),
      // {error: "..."}.
      const msg = describeError(data?.message ?? data?.detail ?? data?.error);
      throw badRequest(msg);
    }

    return data;
  } catch (err) {
    // Re-throw already-shaped ApiError factories unchanged. NOTE: the
    // factory errors expose `err.status`, not `err.statusCode` — fix
    // a pre-existing bug where the wrong property was being checked
    // and shaped errors were being re-wrapped as "unreachable".
    if (err && err.status) throw err;
    if (err && err.name === "AbortError") throw internal("ML service timed out");
    throw internal(`ML service unreachable (${safeErrorMessage(err)})`);
  } finally {
    clearTimeout(timer);
  }
};

export const checkHealth = async () => {
  return mlFetch("/health");
};

export const getRecommendations = async (body, userId, opts = {}) => {
  const { persona, budget, preferences, brandFilter, topN } = body || {};
  // `source` is forwarded by the controller to flag the call origin.
  // The auto-recommendation flow passes "auto" so the impression log
  // is tagged with `source: "auto"` (Fix #1) — it is NOT suppressed
  // anymore; the trainer (#3) filters on `isTrainingEligible` to
  // avoid pollution.
  // `requestId` is the FE's per-mount UUID. It's required for the
  // impression upsert key (userId, phoneId, source, requestId).
  const source = opts && typeof opts.source === "string" ? opts.source : "click";
  const requestId = opts && typeof opts.requestId === "string" ? opts.requestId : null;
  // `softPrice` is an internal-call flag, NOT a user-facing body
  // field. When true, the Python scorer treats `budget.max` as a
  // soft penalty instead of a hard drop (auto-recommend path).
  // Default false preserves the click-flow hard ceiling. Set by
  // `getAutoRecommendations`; the controller never sets it.
  const softPrice = !!(opts && opts.softPrice);

  // Brand include/exclude from the "Find your phone" modal. The FE
  // sends `{ mode: "include" | "exclude", list: string[] }`; we map it
  // to the ranker's `preferred_brands` / `exclude_brands` slots. Both
  // slots are HARD drops on the Python side (see
  // `ML Model/pipeline/recommend.py::_hard_filter_drops` steps 6 + 7)
  // — non-matching brands are removed from the candidate pool
  // outright, never ranked-and-penalised. When the user has not
  // picked anything (or sent an invalid shape) we emit `undefined`
  // so the field is dropped by JSON.stringify — that keeps the ranker
  // on its unfiltered default path.
  const brandList = Array.isArray(brandFilter?.list) ? brandFilter.list : null;
  const preferredBrands =
    brandList && brandList.length > 0 && brandFilter.mode === "include"
      ? brandList
      : undefined;
  const excludeBrands =
    brandList && brandList.length > 0 && brandFilter.mode === "exclude"
      ? brandList
      : undefined;

  // Two-stage pipeline trigger: the "Recommend Me a Phone" click flow
  // passes topN=5 to switch off the 5-signal fusionRank and onto the
  // rule-based → content-based → top-5 pipeline. Any other topN keeps
  // the legacy full-fusion behaviour (auto-recommend, future callers).
  if (topN === STAGE2_FINAL_TOP_N) {
    return getRecommendationsTwoStage(body, userId, { source, requestId });
  }

  if (!persona) throw badRequest("persona is required");
  if (!budget || typeof budget.max !== "number")
    throw badRequest("budget.max is required");

  // ---- Step C: Profile Fusion ---------------------------------------------
  let fusedPreferences = null;
  if (userId) {
    fusedPreferences = await buildFusedWeights(userId, {
      preferencesFromRequest: preferences,
    });
  }

  const effectivePersona = fusedPreferences ? "Custom" : persona;

  // 1. Get ML results (Fix #2 — soft constraints + progressive
  //    relaxation live in Python). `minCandidates` matches the
  //    Python `MIN_CANDIDATES` default.
  //    `softPrice` is forwarded ONLY when `opts.softPrice === true`
  //    (auto-recommend path). Click path leaves it false (the
  //    Pydantic schema default) so the user's budget.max stays a
  //    hard ceiling.
  const data = await mlFetch("/recommend", {
    method: "POST",
    body: JSON.stringify({
      persona: effectivePersona,
      budget: { min: budget.min || 0, max: budget.max },
      preferences: fusedPreferences || preferences || {},
      preferred_brands: preferredBrands,
      exclude_brands: excludeBrands,
      softPrice,
      topN: topN || FULL_LIST_TOP_N,
      minCandidates: MIN_CANDIDATES,
    }),
  });

  const mlResults = data.results || [];

  if (mlResults.length === 0) return [];

  // ---- Fix #7 — batched enrichment ---------------------------------------
  // 2a. Resolve (brand, model) → phoneId in ONE findMany (was N=200).
  const idMap = await resolvePhoneIds(
    mlResults.map((m) => ({ brand: m.Brand, modelName: m.Model })),
  );
  const phoneIds = Array.from(new Set(idMap.values()));
  // 2b. Pull full enrichment in ONE findMany (was N=200).
  const phoneById = await enrichPhonesById(phoneIds);

  // 2c. Stock / trend / freshness (Fix #9) — one extra findMany.
  const stockMap = await loadStockAndTrend(phoneIds);

  // 2d. Re-attach everything to the ML list in original order.
  let enriched = mlResults.map((item) => {
    const key = `${(item.Brand || "").toLowerCase()}::${(item.Model || "").toLowerCase()}`;
    const phoneId = idMap.get(key) || null;
    const phone = phoneId ? phoneById.get(phoneId) : null;
    const stock = phoneId ? stockMap.get(phoneId) : null;

    const base = formatRecommendation(item, phone);
    return {
      ...base,
      overallScore: Number.isFinite(item.Overall_Score) ? Number(item.Overall_Score) : null,
      matchScoreFastApi: Number.isFinite(item.Match_Score) ? Number(item.Match_Score) : null,
      valueScore: Number.isFinite(item.Value_Score) ? Number(item.Value_Score) : null,
      // Fix #9 — wire the freshness + trending sub-scores into the
      // ranker via the candidate object. Defaulted to 0.5 (neutral)
      // when stock/trend metadata is missing.
      trendScore: stock?.trendScore ?? 0,
      freshness:  stock?.freshness ?? 0.5,
      stockState: stock?.stockState ?? "in_stock",
      stockPenalty: stock?.stockPenalty ?? 1.0,
      tags: phoneToTags(phone || {}),
    };
  });

  // 2e. Fix #9 pre-fusion stock gate. Out-of-stock phones are
  //     dropped from the auto response (the user did not ask for
  //     them). Low-stock phones pass through and are penalised at
  //     rank time. The legacy behaviour (no gate) is preserved for
  //     the explicit "click" flow, where the user actively asked.
  if (source === "auto") {
    const before = enriched.length;
    const dropped = [];
    enriched = enriched.filter((c) => {
      const gate = (c.stockState || "in_stock") === "out_of_stock" ? false : true;
      if (!gate) dropped.push(`${c.brand?.name || "?"} ${c.modelName || "?"} (stockState=${c.stockState})`);
      return gate;
    });
    // One-shot diagnostic — surfaces phones the auto gate silently
    // dropped so the ops team can audit "why doesn't this phone show
    // up in my top-N?" without re-running the pipeline. Gated to
    // non-production so there is zero cost in prod.
    if (process.env.NODE_ENV !== "production" && dropped.length > 0) {
      console.warn(
        `[auto-recommend] stock gate dropped ${dropped.length}/${before}: ${dropped.slice(0, 10).join(" | ")}${dropped.length > 10 ? " | …" : ""}`,
      );
    }
    if (enriched.length === 0) return [];
  }

  // ---- Fix #4 — content similarity against USER history -----------------
  // The user history is the union of: browsed phones + compared
  // phones. Empty history = cold start = fall back to the legacy
  // "centroid of candidates" score, which the FastAPI side also
  // reports as `similarityToCatalog` so the BE can blend.
  //
  // Disabled for the auto path: the user no longer wants content
  // similarity to influence the auto ranking. We keep the read pipeline
  // (loadUserLikedAndViewed / fetchContentSimilarity) intact so the
  // `getRecommendationsTwoStage` path can keep using it unchanged — set
  // the guard to `true` to re-enable.
  const USE_CONTENT_SIMILARITY_FOR_AUTO = false;
  let seedPhones = [];
  let simRows = [];
  if (USE_CONTENT_SIMILARITY_FOR_AUTO && userId) {
    seedPhones = await loadUserLikedAndViewed(userId, { limit: 25 });
    simRows = await fetchContentSimilarity(
      enriched.map((c) => ({
        brand: c.brand?.name || null,
        modelName: c.modelName,
      })),
      seedPhones.map((s) => ({ brand: s.brandName, modelName: s.phoneLabel })),
    );
    // Cold-start blend: when the user has < 3 history phones, mix in
    // the catalog score so the long tail doesn't collapse.
    const seedWeight = seedPhones.length >= 3
      ? 1.0
      : Math.max(0.4, seedPhones.length / 3);
    for (const c of enriched) {
      const key = `${c.brand?.name || ""}::${c.modelName}`;
      const row = simRows.find((r) => `${r.brand}::${r.modelName}` === key);
      const simSeed  = row && Number.isFinite(row.similarityToSeed)    ? row.similarityToSeed    : 0;
      const simCat   = row && Number.isFinite(row.similarityToCatalog) ? row.similarityToCatalog : 0;
      c.contentSim = (seedWeight * simSeed) + ((1 - seedWeight) * simCat);
    }
  }

  // Step D — behaviour score map for the search_history sub-score.
  const behaviorScoresMap = userId
    ? await loadBehaviorScoreMap(userId)
    : null;

  // Step E — short-term interest vector.
  let interestVec = new Map();
  let candidateMetaMap = new Map();
  if (userId) {
    const recentEvents = await getRecentEvents(userId);
    if (Array.isArray(recentEvents) && recentEvents.length > 0) {
      const interactedIds = recentEvents.map((e) => e.phoneId).filter(Boolean);
      const candidateIds = enriched.map((c) => c.id).filter(Boolean);
      candidateMetaMap = await loadPhoneMetaMap([
        ...interactedIds,
        ...candidateIds,
      ]);
      interestVec = buildShortTermInterest(recentEvents, candidateMetaMap);
    }
  }

  // Step E — personalized fusion. The stock multiplier is a function
  // so each candidate can have its own penalty (low_stock → 0.85,
  // in_stock → 1.0). Cold users (no stockMultiplier) keep the
  // legacy path.
  const stockMultiplier = (c) =>
    Number.isFinite(c.stockPenalty) ? c.stockPenalty : 1.0;
  const ranked = personalizedRank(
    enriched,
    behaviorScoresMap,
    interestVec,
    candidateMetaMap,
    stockMultiplier,
  );

  // ---- Fix #5 — MMR diversity rerank -------------------------------------
  // Re-orders the top-K by maximal marginal relevance. The remainder
  // of the list keeps relevance order. Exploration (#6) runs AFTER
  // this so the diversity pass doesn't penalise the exploration
  // pick as a near-duplicate.
  const mmrReranked = mmrRerank(ranked, MMR_LAMBDA, undefined, MMR_TOP_K);

  // ---- Fix #6 — exploration slot injection --------------------------------
  // ε-greedy + Thompson sampling on the top-50 by relevance. The
  // exploration picks are marked with `explorationArm` so the
  // trainer (#3) can filter them out.
  const explored = await applyExploration(mmrReranked, userId);

  // Re-shape for the FE. `matchScore` (0..100) is overwritten with
  // the fused score so the "% match" UI keeps working unchanged.
  const finalRanked = explored.map((c) => ({
    ...c,
    matchScore: c.finalScore * 100,
    matchComponents: c.components,
    explorationArm: c.explorationArm || null,
  }));

  // One-shot diagnostic — for any candidate the user's affinity
  // singles out, print where it landed in the final list. Helps
  // answer "user has strong affinity for X but X is missing from top
  // N" without re-running the pipeline. Gated to non-production.
  if (process.env.NODE_ENV !== "production" && finalRanked.length > 0) {
    const interesting = finalRanked.filter((c) => {
      const id = c.id || "";
      const model = (c.modelName || "").toLowerCase();
      return (
        (behaviorScoresMap && behaviorScoresMap.has(`affinity:${id}`)) ||
        model.includes("iphone 17e") ||
        model.includes("iphone air")
      );
    });
    if (interesting.length > 0) {
      const top = finalRanked
        .slice(0, 20)
        .map((c) => `${c.brand?.name || "?"} ${c.modelName || "?"}`)
        .join(" | ");
      const detail = interesting
        .map((c) => {
          const comps = c.components || {};
          const k = Object.entries(comps)
            .map(([k, v]) => `${k.slice(0, 4)}=${(v || 0).toFixed(2)}`)
            .join(" ");
          return `  ${c.brand?.name || "?"} ${c.modelName || "?"} (phoneId=${c.id || "null"}) finalScore=${(c.finalScore || 0).toFixed(3)} ${k}`;
        })
        .join("\n");
      const firstAffIdx = finalRanked.findIndex(
        (c) => c.id && behaviorScoresMap && behaviorScoresMap.has(`affinity:${c.id}`),
      );
      const rank = firstAffIdx >= 0 ? firstAffIdx + 1 : "not in top 20";
      console.warn(
        `[auto-recommend] affinity-tracked candidates in final list (${interesting.length})\n  user top-20: ${top}\n  detail:\n${detail}\n  rank of first affinity hit: ${rank}`,
      );
    }
  }

  // Enforce the "no duplicate phones" contract.
  const finalRankedUnique = dedupeByStableId(finalRanked);

  // ---- Fix #1 — fire-and-forget impression log ---------------------------
  // No longer suppressed on `source === "auto"`. The trainer filters
  // on `is_training_eligible` (set true by the FE's
  // `POST /impressions` when dwell >= 1.5s && !skipped). requestId
  // is the FE's per-mount UUID; pass null when the FE didn't supply
  // one (defensive — should never happen in production).
  if (userId && Array.isArray(finalRankedUnique) && finalRankedUnique.length > 0) {
    const topLogged = finalRankedUnique.slice(0, REC_LOG_WRITE_CAP);
    void safeRecordRecommendationLog(
      userId,
      topLogged.map((c, i) => ({
        rank: i + 1,
        phoneId: c.id,
        finalScore: c.matchScore,
        source,
        requestId,
        explorationArm: c.explorationArm || null,
        firstSeenAt: new Date(),
      })),
    );
  }

  // ---- Fix #8 — pagination-aware payload ---------------------------------
  // Ship the first EAGER_TOP_N fully enriched, plus a thin "lazy"
  // descriptor list for the rest. The FE uses `lazy[]` to request
  // expansion as the user scrolls. We never re-serve the same phone
  // twice; the FE is expected to render positions [0..eager-1] in
  // order and append lazy[0], lazy[1], ... as the user scrolls.
  const eagerSlice = finalRankedUnique.slice(0, EAGER_TOP_N);
  const lazyQueue  = finalRankedUnique.slice(EAGER_TOP_N);
  const response = {
    results: eagerSlice,
    lazy: lazyQueue.map((c, i) => ({
      offset: EAGER_TOP_N + i,
      phoneId: c.id,
      finalScore: c.matchScore,
    })),
    totalRanked: finalRankedUnique.length,
    eagerCount: eagerSlice.length,
  };
  return response;
};

// ---------------------------------------------------------------------------
// Two-stage pipeline — used by the "Recommend Me a Phone" button click.
//
//   Full Dataset
//      ↓
//   Stage 1 — Rule-Based (FastAPI /recommend)
//      · applies budget, brand, RAM, 5G, persona weights
//      · returns STAGE1_TOP_N (200) candidates — the reduced domain
//      ↓
//   Stage 2 — Content-Based (FastAPI /similarity/score)
//      · runs ONLY on the Stage-1 reduced set, NOT on the full catalog
//      · each candidate gets a cosine similarity to the centroid of the set
//      ↓
//   Sort by content_similarity desc → slice to STAGE2_FINAL_TOP_N (5)
//
// Compared to `getRecommendations` (the 5-signal fusionRank path used by
// auto-recommend), this deliberately:
//   - drops the fusionRank call (final rank is content similarity only)
//   - drops the behaviour score lookup (irrelevant when content rank wins)
//   - drops the impression log (top-5 is still logged by the controller
//     via safeRecordRecommendationEvent/safeRecordRecommendationCall)
//
// Backward compatibility: triggered only when the FE passes topN === 5.
// Any other topN continues to use `getRecommendations` above.
// ---------------------------------------------------------------------------
export const getRecommendationsTwoStage = async (body, userId, opts = {}) => {
  const { persona, budget, preferences, brandFilter } = body || {};
  const source = opts && typeof opts.source === "string" ? opts.source : "click";
  const requestId = opts && typeof opts.requestId === "string" ? opts.requestId : null;

  // Brand include/exclude from the "Find your phone" modal — see the
  // mirror copy in `getRecommendations` for the full comment. Kept
  // identical so both call sites stay in lock-step. Both slots are
  // HARD drops on the Python side (see
  // `ML Model/pipeline/recommend.py::_hard_filter_drops` steps 6 + 7).
  const brandList = Array.isArray(brandFilter?.list) ? brandFilter.list : null;
  const preferredBrands =
    brandList && brandList.length > 0 && brandFilter.mode === "include"
      ? brandList
      : undefined;
  const excludeBrands =
    brandList && brandList.length > 0 && brandFilter.mode === "exclude"
      ? brandList
      : undefined;

  if (!persona) throw badRequest("persona is required");
  if (!budget || typeof budget.max !== "number")
    throw badRequest("budget.max is required");

  let fusedPreferences = null;
  if (userId) {
    fusedPreferences = await buildFusedWeights(userId, {
      preferencesFromRequest: preferences,
    });
  }
  const effectivePersona = fusedPreferences ? "Custom" : persona;

  const data = await mlFetch("/recommend", {
    method: "POST",
    body: JSON.stringify({
      persona: effectivePersona,
      budget: { min: budget.min || 0, max: budget.max },
      preferences: fusedPreferences || preferences || {},
      preferred_brands: preferredBrands,
      exclude_brands: excludeBrands,
      // Click path keeps the hard price ceiling — budget.max is the
      // user's stated wall. Only the auto path opts into soft price.
      softPrice: false,
      topN: STAGE1_TOP_N,
      minCandidates: MIN_CANDIDATES,
    }),
  });

  const mlResults = data.results || [];
  if (mlResults.length === 0) return [];

  // ---- Fix #7 — batched enrichment (same path as the legacy call) -------
  const idMap = await resolvePhoneIds(
    mlResults.map((m) => ({ brand: m.Brand, modelName: m.Model })),
  );
  const phoneIds = Array.from(new Set(idMap.values()));
  const phoneById = await enrichPhonesById(phoneIds);
  const stockMap = await loadStockAndTrend(phoneIds);

  const enriched = mlResults.map((item) => {
    const key = `${(item.Brand || "").toLowerCase()}::${(item.Model || "").toLowerCase()}`;
    const phoneId = idMap.get(key) || null;
    const phone = phoneId ? phoneById.get(phoneId) : null;
    const stock = phoneId ? stockMap.get(phoneId) : null;
    const base = formatRecommendation(item, phone);
    return {
      ...base,
      overallScore: Number.isFinite(item.Overall_Score)
        ? Number(item.Overall_Score)
        : null,
      matchScoreFastApi: Number.isFinite(item.Match_Score)
        ? Number(item.Match_Score)
        : null,
      valueScore: Number.isFinite(item.Value_Score)
        ? Number(item.Value_Score)
        : null,
      trendScore: stock?.trendScore ?? 0,
      freshness: stock?.freshness ?? 0.5,
      stockState: stock?.stockState ?? "in_stock",
      stockPenalty: stock?.stockPenalty ?? 1.0,
      tags: phoneToTags(phone || {}),
    };
  });

  // ---- Fix #4 — content similarity against user history -----------------
  const seedPhones = userId
    ? await loadUserLikedAndViewed(userId, { limit: 25 })
    : [];
  const simRows = await fetchContentSimilarity(
    enriched.map((c) => ({
      brand: c.brand?.name || null,
      modelName: c.modelName,
    })),
    seedPhones.map((s) => ({ brand: s.brandName, modelName: s.phoneLabel })),
  );
  const seedWeight = seedPhones.length >= 3
    ? 1.0
    : Math.max(0.4, seedPhones.length / 3);
  for (const c of enriched) {
    const key = `${c.brand?.name || ""}::${c.modelName}`;
    const row = simRows.find((r) => `${r.brand}::${r.modelName}` === key);
    const simSeed = row && Number.isFinite(row.similarityToSeed) ? row.similarityToSeed : 0;
    const simCat  = row && Number.isFinite(row.similarityToCatalog) ? row.similarityToCatalog : 0;
    c.contentSim = (seedWeight * simSeed) + ((1 - seedWeight) * simCat);
  }

  // ---- Final ranking: content similarity only, then slice top 5 -----------
  // No 5-signal fusion. No behaviour score. The contract for this flow
  // is "Rank the remaining phones using the content-based similarity
  // score and return exactly 5 phones with the highest similarity."
  //
  // Dedupe BEFORE the slice so the top-5 are guaranteed to be 5 unique
  // phones, even when the underlying rule-based candidates share a
  // DB row (see `dedupeByStableId`). `dedupeByStableId` preserves
  // the order of first occurrence, so the highest-ranked row for
  // each identity is what survives.
  const rankedUnique = dedupeByStableId(
    enriched.slice().sort((a, b) => {
      const aSim = Number.isFinite(a.contentSim) ? a.contentSim : 0;
      const bSim = Number.isFinite(b.contentSim) ? b.contentSim : 0;
      if (bSim !== aSim) return bSim - aSim;
      const aMatch = Number.isFinite(a.matchScoreFastApi)
        ? a.matchScoreFastApi
        : 0;
      const bMatch = Number.isFinite(b.matchScoreFastApi)
        ? b.matchScoreFastApi
        : 0;
      return bMatch - aMatch;
    }),
  );

  const finalRanked = rankedUnique.slice(0, STAGE2_FINAL_TOP_N);

  // Re-shape for the FE. The 0..100 matchScore the dashboard renders
  // is derived from the content similarity (already in [0,1]) so the UI
  // percentage keeps working without a special case in the renderer.
  const shaped = finalRanked.map((c) => ({
    ...c,
    matchScore: (Number.isFinite(c.contentSim) ? c.contentSim : 0) * 100,
  }));

  // Top-5 impression log (Fix #1 — now writes for ALL sources; the
  // trainer filters on is_training_eligible).
  if (userId && shaped.length > 0) {
    void safeRecordRecommendationLog(
      userId,
      shaped.map((c, i) => ({
        rank: i + 1,
        phoneId: c.id,
        finalScore: c.matchScore,
        source,
        requestId,
        firstSeenAt: new Date(),
      })),
    );
  }

  return shaped;
};

// ---------------------------------------------------------------------------
// Fix #8 — lazy expansion. The FE calls this as the user scrolls past
// the eager slice. Re-runs the FULL pipeline (stateful per-call
// pipelines are a trap) but only enriches / returns the
// [offset, offset+limit) window. The score / order are identical to
// what the eager response would have shown at those positions, so the
// FE can just append without re-sorting.
//
// We deliberately do NOT cache between calls — the user's behavior
// changes between calls and a cached response would be stale. The
// full pipeline is ~30-80ms on warm cache; the lazy slice is fine.
// ---------------------------------------------------------------------------
export const getRecommendationsSlice = async (body, userId, opts = {}) => {
  const { persona, budget, preferences, topN } = body || {};
  const source = opts && typeof opts.source === "string" ? opts.source : "click";
  const requestId = opts && typeof opts.requestId === "string" ? opts.requestId : null;
  const offset = Number.isFinite(opts.offset) ? Math.max(0, opts.offset) : EAGER_TOP_N;
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(60, opts.limit)) : LAZY_BATCH;

  // Run the same full pipeline, but only return the requested window.
  // We do this by calling the main path and slicing the response.
  const full = await getRecommendations({ ...(body || {}), topN: topN || FULL_LIST_TOP_N }, userId, {
    source,
    requestId,
  });
  const all = full && Array.isArray(full.results) ? full.results : [];
  const slice = all.slice(offset, offset + limit);
  return {
    results: slice,
    offset,
    limit,
    totalRanked: full?.totalRanked ?? all.length,
  };
};

// ---------------------------------------------------------------------------
// Auto-recommend — derive persona + budget from the stored profile and run
// the same fusion pipeline the click "Recommend Me" button uses.
//
// Reuses `getRecommendations` end-to-end so ML / similarity / fusion paths
// stay single-source-of-truth. No new FastAPI endpoint, no new fields in
// the bundle, no new recommendation route — the FE composes the same
// `POST /recommend` call dressed up as automatic.
//
// Fallback policy:
//   - No userId → return []. The route never fires for anonymous users.
//   - No stored persona → default to "allrounder" (matches Dashboard.jsx
//     selectedCategory default on a fresh account).
//   - No budget.max → default to €1500 (covers the full catalog).
//   - Either fallback fires a `defaultedAt` flag so the FE can show
//     "showing cold-start picks" UX if it wants to.
// ---------------------------------------------------------------------------
export const getAutoRecommendations = async (userId, opts = {}) => {
  if (!userId) {
    return {
      results: [],
      lazy: [],
      totalRanked: 0,
      eagerCount: 0,
      defaultedAt: { persona: false, budget: false },
    };
  }

  const source = opts && typeof opts.source === "string" ? opts.source : "auto";
  const requestId = opts && typeof opts.requestId === "string" ? opts.requestId : null;

  // Single read; buildFusedWeights inside getRecommendations will also
  // pull behavior_scores, so we don't double-load that table here.
  const bundle = await getProfileBundle(userId);

  const persona =
    bundle?.customerProfile?.recommendationPersona || "allrounder";
  const maxBudget =
    bundle?.preference?.maxBudget != null
      ? Number(bundle.preference.maxBudget)
      : null;

  // Track which fields we defaulted so the FE can show a
  // "Suggested for you — no preferences yet" badge if both defaulted.
  const defaultedAt = {
    persona: !bundle?.customerProfile?.recommendationPersona,
    budget: maxBudget == null,
  };

  // Hard-floor at 0 (matches the FE's validation: budget.min may be 0).
  const budget = {
    min: 0,
    max: maxBudget != null && maxBudget > 0 ? maxBudget : 1500,
  };

  // Skip the explicit-prefs layer in the click flow — auto-recommend
  // is offline-of-the-moment, so fused weights do all the work.
  //
  // Behaviour tracking policy (updated 2026-08 — Fix #1):
  // The impression log inside `getRecommendations` is now WRITTEN
  // (not suppressed) with `source: "auto"`. The trainer (#3)
  // filters on `is_training_eligible` (set true by the FE's
  // POST /impressions when dwell >= 1.5s && !skipped) so noisy
  // "scrolled past" impressions don't pollute the regression.
  let results = [];
  try {
    const response = await getRecommendations(
      // Auto path does NOT forward a `brandFilter`. The Python
      // ranker treats `preferred_brands` / `exclude_brands` as HARD
      // drops (see `ML Model/pipeline/recommend.py::_hard_filter_drops`
      // steps 6 + 7), so forwarding the user's stored brand list here
      // would silently hide phones the user never asked to hide.
      // Auto-recommend surfaces ALL brands and lets the score decide.
      // The click flow ("Recommend Me a Phone") continues to honour
      // the modal's brand filter as a hard drop — that path is
      // untouched.
      { persona, budget, topN: FULL_LIST_TOP_N },
      userId,
      // Auto path opts OUT of the hard price ceiling. Out-of-budget
      // phones still surface (ranked, not dropped) with a soft
      // penalty proportional to how far over-budget they are. The
      // click flow ("Recommend Me a Phone") leaves `softPrice`
      // unset so the user's stated budget stays a hard ceiling.
      { source, requestId, softPrice: true },
    );
    // Fix #8 — the new response shape is { results, lazy, totalRanked,
    // eagerCount }. The auto path returns the full shape so the FE
    // can drive lazy expansion.
    if (response && Array.isArray(response.results)) {
      return { ...response, defaultedAt };
    }
    // Legacy fallback (the inner getRecommendations returned a plain
    // array; preserve the old contract).
    results = Array.isArray(response) ? response : [];
  } catch (err) {
    // Don't bubble the error up to the route — the FE will simply show
    // an empty recs section. We surface the failure via console for ops.
    if (process.env.NODE_ENV === "production") {
      console.warn("[auto-recommend] failed:", err?.message || err);
    } else {
      console.error("[auto-recommend] failed:", err);
    }
    results = [];
  }

  return {
    results,
    lazy: [],
    totalRanked: results.length,
    eagerCount: results.length,
    defaultedAt,
  };
};

// Format ML result + DB data into frontend-friendly shape
const formatRecommendation = (mlItem, phone) => {
  if (!phone) {
    return {
      id: null,
      modelName: mlItem.Model,
      brand: { name: mlItem.Brand },
      imageUrl: null,
      keySpecs: null,
      cheapestVariant: { price: mlItem.Price_EUR },
      matchScore: mlItem.Match_Score,
      why: mlItem.Why || [],
      inDatabase: false,
    };
  }

  const cheapestVariant = phone.variants?.[0];

  return {
    id: phone.phoneId,
    modelName: phone.modelName,
    imageUrl: phone.imageUrl,
    antutuScore: phone.antutuScore,
    brand: phone.brand,
    keySpecs: {
      os: phone.specs?.os || null,
      display: phone.specs?.displaySize || null,
      refreshRate: phone.specs?.refreshRate || null,
      camera: phone.specs?.mainCamera || null,
      battery: phone.specs?.batteryMah || null,
      has5G: phone.specs?.supports5g || false,
      hasNfc: phone.specs?.supportsNfc || false,
    },
    cheapestVariant: cheapestVariant
      ? {
          ram: cheapestVariant.ramGb,
          storage: cheapestVariant.storageGb,
          price: cheapestVariant.price,
          storageType: cheapestVariant.storageType,
        }
      : null,
    matchScore: mlItem.Match_Score,
    why: mlItem.Why || [],
    inDatabase: true,
  };
};

export const compareWithML = async (modelNameA, modelNameB) => {
  if (!modelNameA || !modelNameB) throw badRequest("Both phone model names are required");

  try {
    const data = await mlFetch("/compare", {
      method: "POST",
      body: JSON.stringify({
        model_name_a: modelNameA,
        model_name_b: modelNameB,
      }),
    });
    return data;
  } catch (err) {
    // Same `err.status` vs `err.statusCode` fix as `mlFetch`. The
    // `safeErrorMessage` helper is already defined at module scope.
    if (err && err.status) throw err;
    throw internal(`ML compare failed (${safeErrorMessage(err)})`);
  }
};