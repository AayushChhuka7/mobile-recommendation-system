import { ML_BASE_URL } from "../config/ml.mjs";
import { badRequest, internal } from "../utils/ApiError.mjs";
import { prisma } from "../config/prisma.mjs";
import { buildFusedWeights } from "./profileFusion.mjs";
import { fusionRank } from "./fusionRanker.mjs";
import { fetchContentSimilarity } from "./similarityClient.mjs";
import { phoneToTags } from "./searchHistoryScore.mjs";
import {
  getProfileBundle,
  loadBehaviorScoreMap,
  safeRecordRecommendationLog,
} from "./profileService.mjs";

const TIMEOUT_MS = 8000;

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

export const getRecommendations = async (body, userId) => {
  const { persona, budget, preferences, topN } = body || {};

  // Two-stage pipeline trigger: the "Recommend Me a Phone" click flow
  // passes topN=5 to switch off the 5-signal fusionRank and onto the
  // rule-based → content-based → top-5 pipeline. Any other topN keeps
  // the legacy full-fusion behaviour (auto-recommend, future callers).
  if (topN === STAGE2_FINAL_TOP_N) {
    return getRecommendationsTwoStage(body, userId);
  }

  if (!persona) throw badRequest("persona is required");
  if (!budget || typeof budget.max !== "number")
    throw badRequest("budget.max is required");

  // ---- Step C: Profile Fusion ---------------------------------------------
  // Build the per-dim weight map from Step A (explicit) + Step B
  // (behaviour). If the request supplies explicit `preferences` already
  // (FE sliders for a Custom persona), those win as the explicit layer.
  // Behaviour ALWAYS comes from the BE table — that's the same-session
  // nudge that the user explicitly asked for. Output is in-memory only;
  // nothing is persisted.
  let fusedPreferences = null;
  if (userId) {
    fusedPreferences = await buildFusedWeights(userId, {
      preferencesFromRequest: preferences,
    });
  }

  // When fused preferences exist, the persona itself becomes `Custom` for
  // the FastAPI call — otherwise the ranker ignores `custom_weights_stars`
  // entirely and falls back to the persona preset, which would silently
  // swallow our behaviour nudge. The original `persona` is preserved in
  // the response so the FE still sees what the user asked for.
  const effectivePersona = fusedPreferences ? "Custom" : persona;

  // 1. Get ML results
  const data = await mlFetch("/recommend", {
    method: "POST",
    body: JSON.stringify({
      persona: effectivePersona,
      budget: { min: budget.min || 0, max: budget.max },
      preferences: fusedPreferences || preferences || {},
      topN: topN || FULL_LIST_TOP_N,
    }),
  });

  const mlResults = data.results || [];

  if (mlResults.length === 0) return [];

  // 2. Enrich with database data
  const enriched = await Promise.all(
    mlResults.map(async (item) => {
      const phone = await prisma.phones.findFirst({
        where: {
          modelName: { contains: item.Model, mode: "insensitive" },
          brand: { name: { contains: item.Brand, mode: "insensitive" } },
          isActive: true,
        },
        include: {
          brand: { select: { brandId: true, name: true, logoUrl: true } },
          specs: {
            select: {
              os: true,
              chipset: true,
              displaySize: true,
              displayType: true,
              refreshRate: true,
              mainCamera: true,
              batteryMah: true,
              supports5g: true,
              supportsNfc: true,
            },
          },
          variants: {
            where: { isAvailable: true },
            orderBy: { price: "asc" },
            select: {
              variantId: true,
              ramGb: true,
              storageGb: true,
              price: true,
              storageType: true,
            },
          },
        },
      });

      // Step D — attach sub-scores + tag set so fusionRank can consume
      // them in the same pass as the DB enrichment. item.* come from
      // FastAPI's extended /recommend response (Step D Python side).
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
        tags: phoneToTags(phone || {}),
      };
    }),
  );

  // Step D — content similarity (mean of candidates). One POST to
  // FastAPI's /similarity/score; failure path returns zeros.
  const simRows = await fetchContentSimilarity(
    enriched.map((c) => ({
      brand: c.brand?.name || null,
      modelName: c.modelName,
    })),
  );
  const simMap = new Map(
    simRows.map((r) => [`${r.brand}::${r.modelName}`, r.similarityToMean]),
  );
  for (const c of enriched) {
    const key = `${c.brand?.name || ""}::${c.modelName}`;
    c.contentSim = Number.isFinite(simMap.get(key)) ? simMap.get(key) : 0;
  }

  // Step D — behaviour score map for the search_history sub-score.
  // `null` is fine: searchHistoryScore treats it as neutral (0.5).
  const behaviorScoresMap = userId
    ? await loadBehaviorScoreMap(userId)
    : null;

  // Step D — final 5-signal fusion. Ranker is pure; returns a new list
  // with `finalScore` and `components` attached.
  const ranked = fusionRank(enriched, behaviorScoresMap);

  // Re-shape for the FE. The existing `matchScore` (0..100) is
  // overwritten with the fused score so the "% match" UI keeps working
  // unchanged. `matchComponents` is opt-in for the FE (used by the
  // "Boosted by your activity" badge).
  const finalRanked = ranked.map((c) => ({
    ...c,
    matchScore: c.finalScore * 100,
    matchComponents: c.components,
  }));

  // Enforce the "no duplicate phones" contract on the API response.
  // See `dedupeByStableId` for rationale. Ranking order is preserved
  // because `fusionRank` returns phones in `finalScore` desc order —
  // the first occurrence is always the highest-ranked row for each
  // identity.
  const finalRankedUnique = dedupeByStableId(finalRanked);

  // Step D — fire-and-forget impression log. One row per served
  // candidate for future segmentation clustering (consumes the 0.05
  // popularity slot reserved in FUSION_WEIGHTS). Never awaited, never
  // throws back to the route.
  //
  // Issue 1 — at the new FULL_LIST_TOP_N, log writes are capped at
  // REC_LOG_WRITE_CAP rows per call. We bulk-insert via `createMany`
  // so the cost is one round-trip per request rather than N, and the
  // DB never sees more than the top 50 ranked impressions regardless
  // of how many candidates the ranker returned.
  //
  // Log from the post-dedup list so the analytics table never sees
  // duplicate impressions for the same phone on one call.
  if (userId && Array.isArray(finalRankedUnique) && finalRankedUnique.length > 0) {
    const topLogged = finalRankedUnique.slice(0, REC_LOG_WRITE_CAP);
    void safeRecordRecommendationLog(
      userId,
      topLogged.map((c, i) => ({
        rank: i + 1,
        phoneId: c.id,
        finalScore: c.matchScore, // already in [0,100] for FE
      })),
    );
  }

  return finalRankedUnique;
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
export const getRecommendationsTwoStage = async (body, userId) => {
  const { persona, budget, preferences } = body || {};

  if (!persona) throw badRequest("persona is required");
  if (!budget || typeof budget.max !== "number")
    throw badRequest("budget.max is required");

  // ---- Step C: Profile Fusion ---------------------------------------------
  // Same as the legacy path. The fused weights feed the rule-based stage
  // (FastAPI /recommend reads custom_weights_stars when persona=Custom).
  let fusedPreferences = null;
  if (userId) {
    fusedPreferences = await buildFusedWeights(userId, {
      preferencesFromRequest: preferences,
    });
  }
  const effectivePersona = fusedPreferences ? "Custom" : persona;

  // ---- Stage 1: Rule-based filtering + persona-weight ranking ------------
  // Same FastAPI call as the legacy path — applies budget, brand, RAM,
  // 5G filters on the full catalog and returns STAGE1_TOP_N candidates.
  // This is the "reduced candidate domain" Stage 2 runs on.
  const data = await mlFetch("/recommend", {
    method: "POST",
    body: JSON.stringify({
      persona: effectivePersona,
      budget: { min: budget.min || 0, max: budget.max },
      preferences: fusedPreferences || preferences || {},
      topN: STAGE1_TOP_N,
    }),
  });

  const mlResults = data.results || [];
  if (mlResults.length === 0) return [];

  // ---- Enrich with database data (same loop as legacy path) ---------------
  const enriched = await Promise.all(
    mlResults.map(async (item) => {
      const phone = await prisma.phones.findFirst({
        where: {
          modelName: { contains: item.Model, mode: "insensitive" },
          brand: { name: { contains: item.Brand, mode: "insensitive" } },
          isActive: true,
        },
        include: {
          brand: { select: { brandId: true, name: true, logoUrl: true } },
          specs: {
            select: {
              os: true,
              chipset: true,
              displaySize: true,
              displayType: true,
              refreshRate: true,
              mainCamera: true,
              batteryMah: true,
              supports5g: true,
              supportsNfc: true,
            },
          },
          variants: {
            where: { isAvailable: true },
            orderBy: { price: "asc" },
            select: {
              variantId: true,
              ramGb: true,
              storageGb: true,
              price: true,
              storageType: true,
            },
          },
        },
      });

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
        tags: phoneToTags(phone || {}),
      };
    }),
  );

  // ---- Stage 2: Content-based similarity (reduced domain only) ------------
  // The candidate list here is exactly the Stage-1 output, so the
  // similarity is computed within the rule-based filtered domain, not
  // the full catalog. FastAPI /similarity/score is unchanged.
  const simRows = await fetchContentSimilarity(
    enriched.map((c) => ({
      brand: c.brand?.name || null,
      modelName: c.modelName,
    })),
  );
  const simMap = new Map(
    simRows.map((r) => [`${r.brand}::${r.modelName}`, r.similarityToMean]),
  );
  for (const c of enriched) {
    const key = `${c.brand?.name || ""}::${c.modelName}`;
    c.contentSim = Number.isFinite(simMap.get(key)) ? simMap.get(key) : 0;
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
      // Stable tie-break: FastAPI's Match_Score (the rule-based
      // ranking) acts as the implicit tie-breaker, identical to how
      // the fusion ranker behaves for ties.
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

  // Top-5 impression log (fire-and-forget, same as the legacy path).
  // We never log more than STAGE2_FINAL_TOP_N rows here because that's
  // the contract.
  if (userId && shaped.length > 0) {
    void safeRecordRecommendationLog(
      userId,
      shaped.map((c, i) => ({
        rank: i + 1,
        phoneId: c.id,
        finalScore: c.matchScore,
      })),
    );
  }

  return shaped;
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
export const getAutoRecommendations = async (userId) => {
  if (!userId) return { results: [], defaultedAt: { persona: false, budget: false } };

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
  let results = [];
  try {
    results = await getRecommendations(
      { persona, budget, topN: FULL_LIST_TOP_N },
      userId,
    );
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

  return { results, defaultedAt };
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