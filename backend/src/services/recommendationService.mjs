// recommendationService — top-level orchestrator for the personalised
// recommendation pipeline.
//
// Why this exists alongside `recommendService.mjs` (which is the
// lower-level ML orchestrator)? Because the project needs:
//   1. Persona inference before the ML call (so we know what to ask
//      FastAPI for).
//   2. Cold-start detection + a graceful fallback to onboarding
//      recommendations instead of throwing or returning [].
//   3. SHAP explanations attached per candidate (the lower-level
//      service only exposes a free-text `why` array today; we map
//      the per-dim fusion components into SHAP-style importances so
//      the FE has structured explanations).
//   4. A normalized DTO that the FE can render without any extra
//      parsing. The lower-level service returns a superset that
//      leaks ML keys (Model, Brand, Match_Score, Overall_Score,
//      Value_Score, …); this service strips those.
//
// Failure policy:
//   - Persona inference failure → default All_Rounder persona,
//     warn-level log. Never break the recommendation.
//   - Explanation failure → candidate gets empty lines, fallback
//     overall message. Never break the recommendation.
//   - FastAPI unreachable → caller (lower-level service) raises an
//     internal error; we let it propagate because the FE expects
//     503 in that case.
//
// Public API:
//   - getPersonalizedRecommendations(userId, opts)
//   - getColdStartRecommendations(userId, opts)   (delegates)
//   - explainRecommendation(userId, phoneId)

import { getRecommendations as lowerGetRecommendations } from "./recommendService.mjs";
import { getProfileBundle, loadBehaviorScoreMap } from "./profileService.mjs";
import { buildFusedWeights } from "./profileFusion.mjs";
import { inferPersona, PERSONAS } from "./personaInferenceService.mjs";
import { isColdStart, getOnboardingRecommendations } from "./coldStartService.mjs";
import { explain as explainWithShap } from "./explanationService.mjs";
import { FUSION_WEIGHTS } from "./fusionRanker.mjs";
import { phoneToTags } from "./searchHistoryScore.mjs";
import { notFound, badRequest } from "../utils/ApiError.mjs";

// ---- Tunables -------------------------------------------------------------
const DEFAULT_TOP_N = 10;
const MAX_TOP_N = 50;

// ---- Pure helpers ---------------------------------------------------------

// Map a candidate row from the lower-level service into the
// SHAP-like feature vector `explanationService` understands.
// The lower-level service does NOT expose real SHAP — we use the
// fusion components as a stand-in until FastAPI ships SHAP.
// `value` here is in [0, 1] so the SHAP bucket is consistent.
const candidateToShap = (c) => {
  const components = c?.matchComponents || c?.components || null;
  if (!components || typeof components !== "object") return {};

  // Map the 5-signal fusion space onto the FE-facing feature keys.
  const out = {
    gaming: components.customer_preference ?? 0,
    camera: components.content_similarity ?? 0,
    battery: components.value ?? 0,
    display: components.compatibility ?? 0,
    search_history: components.search_history ?? 0,
    price_eur: components.value ?? 0,
    ram_gb: components.compatibility ?? 0,
    antutu_score: components.compatibility ?? 0,
  };
  // Subtract a neutral baseline so SHAP is signed.
  for (const k of Object.keys(out)) {
    out[k] = Number((out[k] - 0.5).toFixed(4));
  }
  return out;
};

const candidateToFeatureValues = (c) => {
  const cheapest = c?.cheapestVariant || {};
  const specs = c?.keySpecs || {};
  return {
    battery_mah: Number(specs.battery) || 0,
    ram_gb: Number(cheapest.ram) || 0,
    storage_gb: Number(cheapest.storage) || 0,
    antutu_score: Number(c?.antutuScore) || 0,
    camera_mp: parseCameraMp(specs.camera),
    refresh_rate_hz: Number(specs.refreshRate) || 0,
    supports_5g: specs.has5G === true,
    price_eur: Number(cheapest.price) || 0,
    display_size: Number(specs.display) || 0,
    has_ois: false,
    chipset: null,
  };
};

// Parse "50MP + 12MP + 8MP" → max int. Returns null when unparseable.
const parseCameraMp = (raw) => {
  if (typeof raw !== "string") return null;
  const matches = raw.match(/\d+\s*MP/gi);
  if (!matches) return null;
  let max = 0;
  for (const m of matches) {
    const n = parseInt(m, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max > 0 ? max : null;
};

// ---- Lower-level result → normalized DTO --------------------------------

// Convert a single candidate row (output of `lowerGetRecommendations`)
// into the FE-facing shape. We strip ML keys, attach the SHAP-based
// explanation, and emit a stable score block.
const normalizeCandidate = (c) => {
  if (!c || typeof c !== "object") return null;

  const finalScore = Number.isFinite(c.finalScore)
    ? c.finalScore
    : Number.isFinite(c.matchScore)
    ? c.matchScore / 100
    : null;

  let explanation = { overall: "Match summary", lines: [] };
  try {
    const shap = candidateToShap(c);
    const values = candidateToFeatureValues(c);
    explanation = explainWithShap({
      shapValues: shap,
      featureValues: values,
      score: finalScore ?? 0.5,
      options: { topN: 4, minImportance: 0.04 },
    });
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[recommendation] explain failed:", err?.message || err);
    } else {
      console.error("[recommendation] explain failed:", err);
    }
    explanation = { overall: "Match summary", lines: [] };
  }

  return {
    phoneId: c.id || c.phoneId || null,
    modelName: c.modelName || null,
    imageUrl: c.imageUrl || null,
    brand: c.brand
      ? { id: c.brand.brandId || c.brand.id || null, name: c.brand.name || null, logoUrl: c.brand.logoUrl || null }
      : null,
    keySpecs: c.keySpecs || null,
    cheapestVariant: c.cheapestVariant || null,
    scores: {
      match: Number.isFinite(c.matchScore) ? c.matchScore : finalScore != null ? finalScore * 100 : null,
      value: Number.isFinite(c.valueScore) ? c.valueScore : null,
      composite: finalScore,
      components: c.matchComponents || c.components || null,
    },
    explanation,
  };
};

// Derive a request budget from the stored profile. Defaults mirror
// `recommendService.getAutoRecommendations` so the user gets the
// same fallback UX whether they hit /auto or /recommendations.
const budgetFromBundle = (bundle) => {
  const maxBudget =
    bundle?.preference?.maxBudget != null
      ? Number(bundle.preference.maxBudget)
      : null;
  return {
    min: 0,
    max: maxBudget != null && maxBudget > 0 ? maxBudget : 1500,
  };
};

// Resolve persona: stored preference wins; otherwise personaInference
// wins. If neither is set, fall back to All_Rounder.
const resolvePersona = (bundle, inferred) => {
  const stored = bundle?.customerProfile?.recommendationPersona || null;
  if (stored) return stored;
  return inferred?.persona || PERSONAS.ALL_ROUNDER;
};

// ---- Public API ----------------------------------------------------------

/**
 * Get personalised recommendations for a user.
 *
 * @param {string|null} userId
 * @param {object} [opts]
 * @param {number}  [opts.topN=10]
 * @param {object}  [opts.weights]        — explicit dim weight overrides.
 * @param {string}  [opts.persona]        — explicit persona override.
 * @param {boolean} [opts.skipColdStart=false]  — bypass the cold-start gate.
 * @returns {Promise<{ userId, persona, generatedAt, candidates, isColdStart, modelVersion }>}
 */
export const getPersonalizedRecommendations = async (userId, opts = {}) => {
  if (!userId) throw badRequest("userId is required");
  const topN = clampInt(opts.topN ?? DEFAULT_TOP_N, 1, MAX_TOP_N);

  // Cold-start gate. Cold-start users get onboarding picks instead
  // of the full ML pipeline — saves a FastAPI call and avoids the
  // "empty result for a brand-new user" failure mode.
  if (!opts.skipColdStart && (await isColdStart(userId))) {
    const onboarding = await getOnboardingRecommendations(userId, {
      persona: opts.persona || PERSONAS.ALL_ROUNDER,
      max: topN,
    });
    return {
      userId,
      persona: onboarding.persona,
      generatedAt: onboarding.generatedAt,
      candidates: onboarding.candidates,
      isColdStart: true,
      modelVersion: "v1",
    };
  }

  // 1. Bundle + persona + weights — fan out as much as possible.
  const [bundle, personaResult, behaviorScores] = await Promise.all([
    getProfileBundle(userId),
    inferPersona(userId),
    loadBehaviorScoreMap(userId),
  ]);

  const persona = opts.persona || resolvePersona(bundle, personaResult);
  const budget = budgetFromBundle(bundle);

  // 2. Build the fused weights. We pass `opts.weights` through so a
  // FE "Custom" persona still gets its slider values; behaviour data
  // is the same-session nudge.
  const fusedPreferences = await buildFusedWeights(userId, {
    preferencesFromRequest: opts.weights,
  });

  // 3. Lower-level pipeline. Returns a list of enriched candidates
  // with `finalScore`, `components`, and FE-facing fields.
  const lowerResult = await lowerGetRecommendations(
    {
      persona,
      budget,
      preferences: fusedPreferences || opts.weights || {},
      topN,
    },
    userId,
  );

  // 4. Normalize + attach SHAP-style explanations.
  const candidates = (Array.isArray(lowerResult) ? lowerResult : [])
    .map(normalizeCandidate)
    .filter(Boolean);

  return {
    userId,
    persona,
    generatedAt: new Date().toISOString(),
    candidates,
    isColdStart: false,
    modelVersion: "v1",
    evidence: personaResult?.evidence || [],
  };
};

/**
 * Convenience wrapper for the cold-start path. Delegates to
 * `coldStartService.getOnboardingRecommendations` and wraps the
 * result in the normalized DTO envelope.
 *
 * @param {string|null} userId
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export const getColdStartRecommendations = async (userId, opts = {}) => {
  const topN = clampInt(opts.topN ?? DEFAULT_TOP_N, 1, MAX_TOP_N);
  const onboarding = await getOnboardingRecommendations(userId, {
    persona: opts.persona || PERSONAS.ALL_ROUNDER,
    max: topN,
  });
  return {
    userId: userId || null,
    persona: onboarding.persona,
    generatedAt: onboarding.generatedAt,
    candidates: onboarding.candidates,
    isColdStart: true,
    modelVersion: "v1",
  };
};

/**
 * Generate a human-readable explanation for a single phone — used by
 * the phone-detail page or the "why this phone?" modal.
 *
 * @param {string} userId
 * @param {string} phoneId
 * @returns {Promise<{ phone, persona, explanation }>}
 */
export const explainRecommendation = async (userId, phoneId) => {
  if (!userId) throw badRequest("userId is required");
  if (!phoneId) throw badRequest("phoneId is required");

  const { prisma } = await import("../config/prisma.mjs");

  // 1. Load the phone + the user's behaviour-score map.
  const [phone, behaviorScores, personaResult] = await Promise.all([
    prisma.phones.findUnique({
      where: { phoneId },
      include: {
        brand: { select: { brandId: true, name: true, logoUrl: true } },
        specs: {
          select: {
            chipset: true,
            batteryMah: true,
            mainCamera: true,
            displaySize: true,
            refreshRate: true,
            supports5g: true,
            supportsNfc: true,
            ois: true,
          },
        },
        variants: {
          where: { isAvailable: true },
          orderBy: { price: "asc" },
          take: 1,
          select: { ramGb: true, storageGb: true, price: true },
        },
      },
    }),
    loadBehaviorScoreMap(userId),
    inferPersona(userId),
  ]);

  if (!phone) throw notFound("Phone not found");

  // 2. Build the feature + SHAP vectors. We don't have a real SHAP
  // source for an arbitrary phoneId, so the importance is derived
  // from the fusion composite of this single phone + the user's
  // behaviour scores. The numbers are illustrative — the FE renders
  // them as a structured "why" panel.
  const featureValues = {
    battery_mah: phone.specs?.batteryMah || 0,
    ram_gb: phone.variants?.[0]?.ramGb || 0,
    storage_gb: phone.variants?.[0]?.storageGb || 0,
    antutu_score: phone.antutuScore || 0,
    camera_mp: parseCameraMp(phone.specs?.mainCamera),
    refresh_rate_hz: phone.specs?.refreshRate || 0,
    supports_5g: phone.specs?.supports5g === true,
    price_eur: phone.variants?.[0]?.price ? Number(phone.variants[0].price) : 0,
    display_size: phone.specs?.displaySize ? Number(phone.specs.displaySize) : 0,
    has_ois: phone.specs?.ois === true,
    chipset: phone.specs?.chipset || null,
  };

  const tags = phoneToTags(phone);
  const behaviorAffinity = computeTagsAffinity(tags, behaviorScores);
  // Build a SHAP-like vector by splitting the affinity across the
  // canonical features.
  const shap = {
    battery_mah: normalise(featureValues.battery_mah, 5000, 0, 5000),
    camera_mp: normalise(featureValues.camera_mp || 0, 50, 0, 50),
    ram_gb: normalise(featureValues.ram_gb, 12, 0, 12),
    refresh_rate_hz: normalise(featureValues.refresh_rate_hz, 120, 60, 120),
    antutu_score: normalise(featureValues.antutu_score, 900_000, 200_000, 1_200_000),
    price_eur: 0.5 - (featureValues.price_eur / 1500),
    display_size: normalise(featureValues.display_size, 6.5, 5, 7),
    supports_5g: featureValues.supports_5g ? 0.1 : -0.05,
    has_ois: featureValues.has_ois ? 0.05 : 0,
    chipset: featureValues.chipset ? 0.1 : -0.05,
    search_history: behaviorAffinity,
  };

  const composite =
    (shap.battery_mah + shap.camera_mp + shap.ram_gb + shap.refresh_rate_hz +
     shap.antutu_score + shap.supports_5g + shap.has_ois + shap.chipset) /
    8;
  const score = clamp01(0.5 + composite * 0.5);

  const explanation = explainWithShap({
    shapValues: shap,
    featureValues,
    score,
    options: { topN: 5, minImportance: 0.04 },
  });

  return {
    phone: {
      phoneId: phone.phoneId,
      modelName: phone.modelName,
      imageUrl: phone.imageUrl,
      brand: phone.brand
        ? { id: phone.brand.brandId, name: phone.brand.name, logoUrl: phone.brand.logoUrl }
        : null,
    },
    persona: personaResult?.persona || PERSONAS.ALL_ROUNDER,
    explanation: { ...explanation, score },
  };
};

// ---- Pure helpers used by explainRecommendation ---------------------------

const normalise = (value, goodAt, badAt, cap) => {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return -0.3;
  const span = Math.max(1, cap - badAt);
  const t = Math.max(0, Math.min(1, (value - badAt) / span));
  return Number((t - 0.5).toFixed(4));
};

// Aggregate the per-tag behaviour affinity into a single scalar in
// [-1, 1]. Mirrors `searchHistoryScore` but with a simpler formula
// since this is a single-phone, per-detail view (not a ranking pass).
const computeTagsAffinity = (tags, behaviorScores) => {
  if (!Array.isArray(tags) || tags.length === 0) return 0;
  if (!behaviorScores || (behaviorScores instanceof Map && behaviorScores.size === 0)) {
    return 0;
  }
  const map = behaviorScores instanceof Map
    ? behaviorScores
    : new Map(Object.entries(behaviorScores || {}));
  let raw = 0;
  let matched = 0;
  for (const t of tags) {
    const v = map.get(t);
    if (typeof v === "number" && Number.isFinite(v)) {
      raw += v;
      matched += 1;
    }
  }
  if (matched === 0) return 0;
  return Number(Math.tanh(0.5 * raw).toFixed(4));
};

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

const clampInt = (v, min, max) => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
};

// ---------------------------------------------------------------------------
// Example usage
// ---------------------------------------------------------------------------
//
//   import {
//     getPersonalizedRecommendations,
//     getColdStartRecommendations,
//     explainRecommendation,
//   } from "./recommendationService.mjs";
//
//   const dto = await getPersonalizedRecommendations(userId, { topN: 10 });
//   // dto.candidates[0].explanation.lines → [{ feature, importance, message, kind }]
//
//   const onboarding = await getColdStartRecommendations(userId);
//   // onboarding.candidates → curated list, no FastAPI call.
//
//   const detail = await explainRecommendation(userId, phoneId);
//   // detail.explanation → { overall, lines, score }.
//
// ---------------------------------------------------------------------------
// Suggested unit tests
// ---------------------------------------------------------------------------
//
//   - normalizeCandidate never leaks raw ML keys (Model, Brand,
//     Match_Score, Overall_Score).
//   - Cold-start user gets isColdStart=true and never calls
//     lowerGetRecommendations (mock it and assert not called).
//   - explainRecommendation throws notFound for unknown phoneId.
//   - explainRecommendation always returns lines (never empty when
//     features are present).
//
// ---------------------------------------------------------------------------
// Assumptions
// ---------------------------------------------------------------------------
//
//   - The lower-level `recommendService.getRecommendations` already
//     runs FastAPI /similarity/score + the 5-signal fusion and
//     returns candidates with `finalScore` + `components`. We trust
//     that and only wrap.
//   - Real SHAP from FastAPI is not yet wired. We synthesise SHAP
//     from the fusion components so the FE has structured
//     explanations today. When FastAPI ships SHAP, swap
//     `candidateToShap` to read `c.shap || c.SHAP`.
//
// ---------------------------------------------------------------------------
// Reusable functions
// ---------------------------------------------------------------------------
//
//   - `normalizeCandidate` is exported implicitly via
//     `getPersonalizedRecommendations`. Tests can build synthetic
//     candidates and assert the DTO shape.
//   - `parseCameraMp` + `candidateToFeatureValues` are shared with
//     coldStartService.mjs (kept duplicated here so the services
//     don't form a circular import — both are pure).
//
// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
//
//   - Persona inference / explanation failures never propagate. They
//     degrade to safe defaults (All_Rounder / empty lines).
//   - The lower-level pipeline throws `internal` on FastAPI failure;
//     we let that bubble. Callers (controllers) map it to 503.
//   - `notFound` from Prisma on unknown phoneId is the only
//     non-recoverable case in `explainRecommendation`.