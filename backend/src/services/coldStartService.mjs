// coldStartService — onboarding recommendations for users who
// don't have enough history to drive personalised ranking.
//
// Three jobs:
//   1. isColdStart(userId) — cheap boolean for the FE to decide
//      whether to show the onboarding modal.
//   2. getOnboardingQuestions(userId?) — a fixed set of persona-
//      shaping questions. Idempotent so it's safe to call on
//      every Dashboard mount.
//   3. getOnboardingRecommendations(userId, opts) — a curated list
//      blending popular + trending + a default persona's match.
//
// Integration:
//   - `recommendationService.getPersonalizedRecommendations` calls
//     `isColdStart` first; on true, it falls through to
//     `getOnboardingRecommendations` instead of the full ML pipeline.
//     (See recommendationService.mjs for the wiring.)
//
// Failure policy:
//   - All DB / FastAPI reads are wrapped in try/catch and degrade
//     to safe defaults. A failing onboarding path must NEVER break
//     the Dashboard — empty array is the worst acceptable outcome.

import { prisma } from "../config/prisma.mjs";
import { explain, stubShap } from "./explanationService.mjs";
import {
  inferPersonaFromSignals,
  PERSONAS,
} from "./personaInferenceService.mjs";
import { phoneToTags } from "./searchHistoryScore.mjs";

// ---- Tunables -------------------------------------------------------------

// A user is "cold-start" when they don't have any of:
//   - more than COLD_THRESHOLD events
//   - more than COLD_THRESHOLD searches
//   - any explicit preferences
const COLD_THRESHOLD = 3;

// Onboarding picks composition. The FE renders this many cards.
const POPULAR_COUNT = 4;
const TRENDING_COUNT = 4;
const ALROUNDER_COUNT = 2;
const MAX_PICKS = POPULAR_COUNT + TRENDING_COUNT + ALROUNDER_COUNT;

// Days of "trending" look-back. After this, "trending" falls back to
// the popular list (same phones anyway at our scale).
const TRENDING_LOOKBACK_DAYS = 7;

// ---- Cold-start detection --------------------------------------------------

/**
 * Is this user a cold-start? Counts behaviour events, search history,
 * and explicit preferences in one round-trip.
 *
 * @param {string|null|undefined} userId
 * @returns {Promise<boolean>}
 */
export const isColdStart = async (userId) => {
  if (!userId) return true;
  try {
    const [eventCount, searchCount, preference] = await Promise.all([
      prisma.event.count({ where: { userId } }),
      prisma.searchHistory.count({ where: { userId } }),
      prisma.userPreference.findUnique({
        where: { userId },
        select: { usageType: true, cameraPreference: true, maxBudget: true },
      }),
    ]);

    const hasPreferences =
      !!preference &&
      (preference.usageType ||
        preference.cameraPreference ||
        (preference.maxBudget && Number(preference.maxBudget) > 0));

    return (
      !hasPreferences &&
      eventCount <= COLD_THRESHOLD &&
      searchCount <= COLD_THRESHOLD
    );
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[coldStart] isColdStart failed:", err?.message || err);
    } else {
      console.error("[coldStart] isColdStart failed:", err);
    }
    return true; // safer to default to cold-start than to spam recs
  }
};

// ---- Onboarding questions ------------------------------------------------

const ONBOARDING_QUESTIONS = Object.freeze([
  {
    key: "primary_use",
    label: "What will you use the phone for most?",
    options: [
      { key: "gaming", label: "Gaming" },
      { key: "photography", label: "Photography & video" },
      { key: "battery_life", label: "Long battery life" },
      { key: "all_round", label: "Everyday use" },
    ],
  },
  {
    key: "budget",
    label: "What's your budget?",
    options: [
      { key: "under_300", label: "Under €300" },
      { key: "300_600", label: "€300 - €600" },
      { key: "600_1000", label: "€600 - €1000" },
      { key: "over_1000", label: "€1000+" },
    ],
  },
  {
    key: "brand",
    label: "Any brand preference?",
    options: [
      { key: "any", label: "No preference" },
      { key: "samsung", label: "Samsung" },
      { key: "apple", label: "Apple" },
      { key: "xiaomi", label: "Xiaomi / Redmi" },
      { key: "google", label: "Google" },
    ],
  },
  {
    key: "must_have",
    label: "Must-have feature?",
    options: [
      { key: "5g", label: "5G" },
      { key: "wireless_charging", label: "Wireless charging" },
      { key: "headphone_jack", label: "Headphone jack" },
      { key: "expandable_storage", label: "Expandable storage" },
    ],
  },
]);

/**
 * Static list of onboarding questions. Idempotent — same return on
 * every call so the FE can `useMemo` safely.
 */
export const getOnboardingQuestions = () => ONBOARDING_QUESTIONS;

// ---- Phone hydration ------------------------------------------------------

// Reusable include shape for the curated phone list.
const ONBOARDING_INCLUDE = {
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
    take: 1,
    select: {
      variantId: true,
      ramGb: true,
      storageGb: true,
      price: true,
      storageType: true,
    },
  },
};

// Hydrate phones → frontend shape. Mirrors `formatPhoneListItem` so
// the FE doesn't need a new renderer for onboarding cards.
const formatPhone = (phone) => {
  if (!phone) return null;
  const cheapest = phone.variants?.[0] || null;
  return {
    phoneId: phone.phoneId,
    id: phone.phoneId,
    modelName: phone.modelName,
    imageUrl: phone.imageUrl,
    antutuScore: phone.antutuScore,
    brand: phone.brand
      ? {
          id: phone.brand.brandId,
          name: phone.brand.name,
          logoUrl: phone.brand.logoUrl,
        }
      : null,
    keySpecs: {
      os: phone.specs?.os || null,
      display: phone.specs?.displaySize || null,
      refreshRate: phone.specs?.refreshRate || null,
      camera: phone.specs?.mainCamera || null,
      battery: phone.specs?.batteryMah || null,
      has5G: phone.specs?.supports5g || false,
      hasNfc: phone.specs?.supportsNfc || false,
    },
    cheapestVariant: cheapest
      ? {
          ram: cheapest.ramGb,
          storage: cheapest.storageGb,
          price: cheapest.price,
          storageType: cheapest.storageType,
        }
      : null,
    tags: phoneToTags(phone),
  };
};

// Fetch the curated "popular" phones (top antutu, active, fresh).
const fetchPopularPhones = async (limit) => {
  try {
    const rows = await prisma.phones.findMany({
      where: { isActive: true, antutuScore: { not: null, gt: 0 } },
      orderBy: { antutuScore: "desc" },
      take: limit,
      include: ONBOARDING_INCLUDE,
    });
    return rows.map(formatPhone).filter(Boolean);
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[coldStart] fetchPopularPhones failed:", err?.message || err);
    } else {
      console.error("[coldStart] fetchPopularPhones failed:", err);
    }
    return [];
  }
};

// Fetch "trending" phones from the impression log over the last
// `TRENDING_LOOKBACK_DAYS` days. Falls back to popular on empty.
const fetchTrendingPhones = async (limit) => {
  const since = new Date(Date.now() - TRENDING_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  try {
    const grouped = await prisma.recommendationLog.groupBy({
      by: ["phoneId"],
      where: { shownAt: { gte: since } },
      _count: { phoneId: true },
      orderBy: { _count: { phoneId: "desc" } },
      take: limit,
    });
    const phoneIds = grouped.map((g) => g.phoneId);
    if (phoneIds.length === 0) {
      return fetchPopularPhones(limit);
    }
    const rows = await prisma.phones.findMany({
      where: { phoneId: { in: phoneIds }, isActive: true },
      include: ONBOARDING_INCLUDE,
    });
    // Re-order to match groupBy's count desc.
    const byId = new Map(rows.map((r) => [r.phoneId, r]));
    return phoneIds.map((id) => byId.get(id)).filter(Boolean).map(formatPhone).filter(Boolean);
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[coldStart] fetchTrendingPhones failed:", err?.message || err);
    } else {
      console.error("[coldStart] fetchTrendingPhones failed:", err);
    }
    return fetchPopularPhones(limit);
  }
};

// Fetch the default-persona all-rounder set: a few high-quality phones
// in different price bands so the user sees variety.
const fetchAllRounderPhones = async (limit) => {
  try {
    const rows = await prisma.phones.findMany({
      where: {
        isActive: true,
        specs: { supports5g: true },
      },
      orderBy: [{ antutuScore: "desc" }],
      take: limit * 3, // pull more then dedup by brand
      include: ONBOARDING_INCLUDE,
    });
    // Diversify: avoid stacking the same brand at the top.
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const brand = r.brand?.name || "_";
      if (seen.has(brand) && out.length >= limit) continue;
      seen.add(brand);
      out.push(formatPhone(r));
      if (out.length >= limit) break;
    }
    return out;
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[coldStart] fetchAllRounderPhones failed:", err?.message || err);
    } else {
      console.error("[coldStart] fetchAllRounderPhones failed:", err);
    }
    return [];
  }
};

// Deduplicate a candidate list while preserving order.
const dedupeById = (phones) => {
  const seen = new Set();
  const out = [];
  for (const p of phones) {
    if (!p || seen.has(p.phoneId)) continue;
    seen.add(p.phoneId);
    out.push(p);
  }
  return out;
};

// ---- Onboarding recommendations -----------------------------------------

/**
 * Build the onboarding recommendation list for a cold-start user.
 *
 * @param {string|null} userId
 * @param {object} [opts]
 * @param {string} [opts.persona]      — override the default persona (All_Rounder).
 * @param {number}  [opts.max=10]
 * @returns {Promise<{persona, generatedAt, candidates}>}
 */
export const getOnboardingRecommendations = async (userId, opts = {}) => {
  const max = Math.max(1, Math.min(25, Number(opts.max) || MAX_PICKS));
  const persona = opts.persona || PERSONAS.ALL_ROUNDER;

  // Fetch the three buckets in parallel.
  const [popular, trending, allrounder] = await Promise.all([
    fetchPopularPhones(POPULAR_COUNT),
    fetchTrendingPhones(TRENDING_COUNT),
    fetchAllRounderPhones(ALROUNDER_COUNT),
  ]);

  // Compose + dedup.
  const composed = dedupeById([
    ...popular,
    ...trending,
    ...allrounder,
  ]).slice(0, max);

  // Attach lightweight explanations. We don't have SHAP yet (no
  // request), so we synthesise a stable one from features.
  const candidates = composed.map((phone, i) => {
    const featureValues = {
      battery_mah: phone.keySpecs.battery || 0,
      camera_mp: parseCameraMp(phone.keySpecs.camera),
      ram_gb: phone.cheapestVariant?.ram || 0,
      refresh_rate_hz: phone.keySpecs.refreshRate || 0,
      supports_5g: phone.keySpecs.has5G ? true : false,
      display_size: phone.keySpecs.display || 0,
      antutu_score: phone.antutuScore || 0,
    };
    // Trending phones get a small bump so the explanation ranks them
    // higher in `overall`.
    const trendingBonus = i < TRENDING_COUNT ? 0.1 : 0;
    const stubScore = Math.min(1, 0.55 + trendingBonus + (phone.antutuScore || 0) / 2_000_000);
    const shapValues = stubShap(featureValues);
    const explanation = explain({
      shapValues,
      featureValues,
      score: stubScore,
      options: { topN: 3, minImportance: 0.03 },
    });

    return {
      ...phone,
      scores: {
        composite: stubScore,
        match: stubScore * 100,
        value: null,
        components: null,
      },
      explanation,
      reason: pickReasonTag(i, persona),
    };
  });

  // For typed personas, optionally re-order by persona-aligned features.
  // (Pure heuristic; no FastAPI call.)
  const reordered = reorderByPersona(candidates, persona);

  return {
    persona,
    generatedAt: new Date().toISOString(),
    candidates: reordered,
    isColdStart: true,
  };
};

// Parse "50MP + 12MP" → 50. Returns null if it can't be parsed.
const parseCameraMp = (raw) => {
  if (typeof raw !== "string") return null;
  const m = raw.match(/(\d+)\s*MP/i);
  return m ? Number(m[1]) : null;
};

// Human-readable reason tag the FE shows on each onboarding card.
const REASON_BY_PERSONA = {
  [PERSONAS.Gamer]: "Trending for gaming",
  [PERSONAS.CAMERA_LOVER]: "Trending for photography",
  [PERSONAS.BATTERY_FOCUSED]: "Long battery life",
  [PERSONAS.BUSINESS_USER]: "Great for business",
  [PERSONAS.ALL_ROUNDER]: "Popular all-rounder",
};
const pickReasonTag = (i, persona) => {
  if (i < POPULAR_COUNT) return "Popular right now";
  if (i < POPULAR_COUNT + TRENDING_COUNT) {
    return REASON_BY_PERSONA[persona] || "Trending";
  }
  return "Solid all-rounder";
};

// Move persona-aligned phones earlier in the list. Cheap heuristic —
// we don't have SHAP here.
const reorderByPersona = (candidates, persona) => {
  const scoreFor = (p) => {
    if (persona === PERSONAS.Gamer) {
      const antutu = p.antutuScore || 0;
      return (p.keySpecs.refreshRate || 0) * 0.05 + antutu / 1_000_000;
    }
    if (persona === PERSONAS.CAMERA_LOVER) {
      return parseCameraMp(p.keySpecs.camera) || 0;
    }
    if (persona === PERSONAS.BATTERY_FOCUSED) {
      return p.keySpecs.battery || 0;
    }
    if (persona === PERSONAS.BUSINESS_USER) {
      return (p.keySpecs.hasNfc ? 1 : 0) + (p.keySpecs.has5G ? 1 : 0);
    }
    return p.antutuScore || 0;
  };
  return [...candidates].sort((a, b) => scoreFor(b) - scoreFor(a));
};

// ---------------------------------------------------------------------------
// Example usage
// ---------------------------------------------------------------------------
//
//   import { isColdStart, getOnboardingQuestions, getOnboardingRecommendations } from "./coldStartService.mjs";
//
//   if (await isColdStart(userId)) {
//     const questions = getOnboardingQuestions();
//     const onboarding = await getOnboardingRecommendations(userId);
//     // onboarding.candidates is a ready-to-render list.
//   }
//
// ---------------------------------------------------------------------------
// Suggested unit tests
// ---------------------------------------------------------------------------
//
//   - isColdStart('') → true.
//   - getOnboardingQuestions() is referentially equal across calls
//     (Object.freeze + same array).
//   - getOnboardingRecommendations returns <= max phones, dedup'd by id.
//   - reorderByPersona prefers high antutu when persona=Gamer.
//   - All inputs null/undefined don't throw.
//
// ---------------------------------------------------------------------------
// Assumptions
// ---------------------------------------------------------------------------
//
//   - The catalog has enough phones that the popular list never
//     returns empty in production. If it does, the FE degrades to
//     "no picks" UX.
//   - The impression log table (`RecommendationLog`) has been
//     populated by `recommendService.getRecommendations`; in brand
//     new deployments it will be empty and trending falls back to
//     popular — same outcome.
//
// ---------------------------------------------------------------------------
// Reusable functions
// ---------------------------------------------------------------------------
//
//   - ONBOARDING_QUESTIONS is exported as `getOnboardingQuestions`
//     so callers never mutate the underlying array.
//   - formatPhone is reused by the cold-start + recommendation
//     services for the curated list shape.
//
// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
//
//   - Every Prisma call is wrapped; on failure we return [] and let
//     the caller pick the empty state.
//   - explain() never throws; if feature values are missing the
//     lines come back empty.