// personaInferenceService — infer the user's primary persona from
// available signals (browsing / search / wishlist / purchases /
// ratings / preferred brands / budget / behaviour scores).
//
// We deliberately use deterministic heuristics rather than training
// a classifier: the dataset is small, the personas are coarse, and
// the spec explicitly says "use deterministic heuristics unless the
// project already has an ML classifier".
//
// Heuristic overview (weights in [0, ∞); accumulated per persona,
// then softmax-normalised to a probability distribution):
//
//   Gamer            search keyword "rog/gaming/gamer"          +3
//                    behaviorScore `gaming` >= 1.5             +2
//                    wishlist contains antutu >= 900_000       +2
//                    chipset flag set                          +1
//
//   Camera_Lover     search keyword "camera/photography"        +3
//                    behaviorScore `category:camera` >= 1.5    +2
//                    wishlist contains camera MP >= 50          +2
//                    UserPreference.cameraPreference
//                      == "Photophile"                          +3
//
//   Battery_Focused  search keyword "battery"                   +3
//                    behaviorScore `category:battery` >= 1.5    +2
//                    wishlist contains batteryMah >= 5000       +2
//
//   Business_User    UserPreference.usageType == "Business"    +4
//                    wishlist has dual-sim+IP rating OR has
//                      NFC + headphone jack + 5G                +1 each
//                    wishlist contains antutu in [500k, 900k]   +1
//
//   All_Rounder      catch-all (no signal matched)             +1
//
// Output:
//   { persona, confidence, evidence: [{ tag, weight, reason }, ...] }
//
// Failure isolation: any DB error inside `inferPersona` is logged
// and the service returns the safe default
// `{ persona: 'All_Rounder', confidence: 0, evidence: [] }` so the
// caller never breaks.

import { prisma } from "../config/prisma.mjs";

// ---- Personas -------------------------------------------------------------

export const PERSONAS = Object.freeze({
  Gamer: "Gamer",
  CAMERA_LOVER: "Camera_Lover",
  BATTERY_FOCUSED: "Battery_Focused",
  BUSINESS_USER: "Business_User",
  ALL_ROUNDER: "All_Rounder",
});

const PERSONA_LIST = Object.values(PERSONAS);

// ---- Heuristic table ------------------------------------------------------

// Search-query keywords → persona delta. Mirrors `SEARCH_KEYWORDS` in
// behaviorAnalyzer.mjs so a single match table would be possible
// later; we keep this separate because the mapping is persona-level
// (not behaviour-tag-level).
const SEARCH_KEYWORDS = {
  Gamer: ["rog", "gaming", "gamer"],
  Camera_Lover: ["camera", "photography", "photo"],
  Battery_Focused: ["battery", "battery life", "battery_life"],
  Business_User: ["business", "enterprise", "dual sim", "dualsim"],
};

const BEHAVIOR_TAG_THRESHOLDS = {
  Gamer: { tag: "gaming", threshold: 1.5 },
  Camera_Lover: { tag: "category:camera", threshold: 1.5 },
  Battery_Focused: { tag: "category:battery", threshold: 1.5 },
};

// ---- Pure helpers ---------------------------------------------------------

// Coerce an unknown value to a numeric behaviour score; NaN/Inf → 0.
const asScore = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Safe string contains, lower-case. Avoids the indexOf pitfall when
// one operand is null/undefined.
const includes = (haystack, needle) => {
  if (typeof haystack !== "string") return false;
  return haystack.toLowerCase().includes(String(needle).toLowerCase());
};

// Sum the per-persona contribution of a single search query string.
const scoreFromSearchQuery = (query) => {
  const out = {};
  if (typeof query !== "string") return out;
  for (const persona of PERSONA_LIST) {
    const keywords = SEARCH_KEYWORDS[persona] || [];
    for (const kw of keywords) {
      if (includes(query, kw)) {
        out[persona] = (out[persona] || 0) + 3;
        break; // one match per persona per query is enough
      }
    }
  }
  return out;
};

// Look up the user's `BehaviorScore` map; null when missing/empty.
// Returns a Map<tag, score>.
const loadBehaviorScoreMap = async (userId) => {
  if (!userId) return new Map();
  try {
    const rows = await prisma.behaviorScore.findMany({
      where: { userId },
      select: { tag: true, score: true },
    });
    const out = new Map();
    for (const { tag, score } of rows) out.set(tag, asScore(score));
    return out;
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[persona] loadBehaviorScoreMap failed:",
        err?.message || err,
      );
    } else {
      console.error("[persona] loadBehaviorScoreMap failed:", err);
    }
    return new Map();
  }
};

// Load wishlist phones (with the fields the heuristics need).
// Returns [] on error so the caller can keep going.
const loadWishlistPhones = async (userId) => {
  if (!userId) return [];
  try {
    const rows = await prisma.wishlist.findMany({
      where: { userId },
      select: {
        phone: {
          select: {
            antutuScore: true,
            specs: {
              select: {
                batteryMah: true,
                mainCamera: true,
                supportsNfc: true,
                supports5g: true,
                dualSim: true,
                ipRating: true,
                headphoneJack: true,
              },
            },
          },
        },
      },
    });
    return rows.map((r) => r.phone).filter(Boolean);
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[persona] loadWishlistPhones failed:",
        err?.message || err,
      );
    } else {
      console.error("[persona] loadWishlistPhones failed:", err);
    }
    return [];
  }
};

// Extract the integer megapixel count out of a `mainCamera` string
// like "50MP + 12MP + 8MP". Returns the max number found, or null.
const maxCameraMp = (mainCamera) => {
  if (typeof mainCamera !== "string") return null;
  const matches = mainCamera.match(/\d+\s*MP/gi);
  if (!matches) return null;
  let max = 0;
  for (const m of matches) {
    const n = parseInt(m, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max > 0 ? max : null;
};

// Softmax over a flat score map. Returns the same keys with values
// in (0, 1) that sum to 1.
const softmax = (scoreMap) => {
  const entries = Object.entries(scoreMap);
  if (entries.length === 0) return {};
  const max = Math.max(...entries.map(([, v]) => v));
  // Numerically-stable softmax: subtract max before exp.
  const exps = entries.map(([k, v]) => [k, Math.exp(v - max)]);
  const total = exps.reduce((acc, [, v]) => acc + v, 0);
  const out = {};
  for (const [k, v] of exps) out[k] = v / total;
  return out;
};

// Pick the top-K contributors across personas so the caller can
// show "why we picked this persona" in the UI.
const topEvidence = (evidence, k = 3) =>
  [...evidence]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, k);

// ---- Pure: infer from in-memory signals (for tests) -----------------------

/**
 * Pure persona inference. Inputs are plain objects; no DB access.
 *
 * @param {object} signals
 * @param {Array<{searchQuery?: string}>} [signals.searches=[]]
 * @param {Array<{phoneLabel?: string, brandName?: string}>} [signals.browses=[]]
 * @param {Map<string, number>|object} [signals.behaviorScores]
 * @param {Array}  [signals.wishlistPhones=[]]
 * @param {object} [signals.preference] — UserPreference row.
 * @returns {{ persona: string, confidence: number, evidence: Array }}
 */
export const inferPersonaFromSignals = (signals = {}) => {
  const {
    searches = [],
    browses = [],
    behaviorScores,
    wishlistPhones = [],
    preference = null,
  } = signals;

  // Normalise behaviorScores to a Map<tag, number>.
  let scoreMap = new Map();
  if (behaviorScores instanceof Map) {
    scoreMap = behaviorScores;
  } else if (behaviorScores && typeof behaviorScores === "object") {
    for (const [k, v] of Object.entries(behaviorScores)) {
      scoreMap.set(k, asScore(v));
    }
  }

  // Accumulator: { persona: weight, ... }, plus a parallel
  // evidence list of { persona, tag, weight, reason }.
  const acc = {};
  const evidence = [];

  const bump = (persona, tag, weight, reason) => {
    acc[persona] = (acc[persona] || 0) + weight;
    evidence.push({ persona, tag, weight, reason });
  };

  // 1. Search-query heuristics.
  for (const s of searches) {
    const contribs = scoreFromSearchQuery(s?.searchQuery);
    for (const [persona, w] of Object.entries(contribs)) {
      const firstKw = (SEARCH_KEYWORDS[persona] || []).find((kw) =>
        includes(s?.searchQuery, kw),
      );
      bump(persona, "search", w, `Search matched "${firstKw}"`);
    }
  }

  // 2. Behaviour-score thresholds.
  for (const [persona, { tag, threshold }] of Object.entries(BEHAVIOR_TAG_THRESHOLDS)) {
    const score = scoreMap.get(tag) || 0;
    if (score >= threshold) {
      bump(persona, tag, 2, `Behaviour tag "${tag}" ≥ ${threshold}`);
    }
  }

  // Gamer chipset heuristic: any chipset flag from the analyser.
  if ((scoreMap.get("chipset") || 0) >= 1.0) {
    bump(PERSONAS.Gamer, "chipset", 1, `Strong chipset interest`);
  }

  // 3. Wishlist-phone heuristics.
  for (const phone of wishlistPhones) {
    const antutu = asScore(phone?.antutuScore);
    if (antutu >= 900_000) {
      bump(PERSONAS.Gamer, "wishlist-flagship", 2, "Wishlist contains a flagship");
    }
    if (antutu >= 500_000 && antutu < 900_000) {
      bump(PERSONAS.BUSINESS_USER, "wishlist-midrange", 1, "Wishlist contains a mid-range phone");
    }

    const batteryMah = asScore(phone?.specs?.batteryMah);
    if (batteryMah >= 5000) {
      bump(PERSONAS.BATTERY_FOCUSED, "wishlist-battery", 2, "Wishlist has 5000+ mAh phone");
    }

    const mp = maxCameraMp(phone?.specs?.mainCamera);
    if (mp !== null && mp >= 50) {
      bump(PERSONAS.CAMERA_LOVER, "wishlist-camera", 2, `Wishlist has ${mp} MP camera`);
    }

    const s = phone?.specs;
    if (s) {
      // Business: dual-sim+IP, or full connectivity set (NFC + 3.5mm + 5G).
      if ((s.dualSim && s.ipRating) ||
          (s.supportsNfc && s.headphoneJack && s.supports5g)) {
        bump(PERSONAS.BUSINESS_USER, "wishlist-business", 1, "Wishlist has business-grade features");
      }
    }
  }

  // 4. Explicit-preference signals (UserPreference row).
  if (preference && typeof preference === "object") {
    if (preference.cameraPreference === "Photophile") {
      bump(PERSONAS.CAMERA_LOVER, "preference-camera", 3, "Photophile camera preference");
    }
    if (preference.usageType === "Business") {
      bump(PERSONAS.BUSINESS_USER, "preference-business", 4, "Business usage type");
    } else if (preference.usageType === "Gamer") {
      bump(PERSONAS.Gamer, "preference-gamer", 3, "Gamer usage type");
    } else if (preference.usageType === "Creator") {
      bump(PERSONAS.CAMERA_LOVER, "preference-creator", 2, "Creator usage type");
    }
  }

  // 5. Catch-all so All_Rounder is always a valid candidate.
  bump(PERSONAS.ALL_ROUNDER, "default", 1, "Default catch-all");

  // 6. Softmax → probabilities. Pick the max.
  const probs = softmax(acc);
  let persona = PERSONAS.ALL_ROUNDER;
  let confidence = 0;
  for (const [k, v] of Object.entries(probs)) {
    if (v > confidence) {
      confidence = v;
      persona = k;
    }
  }

  return {
    persona,
    confidence: Number(confidence.toFixed(4)),
    evidence: topEvidence(evidence, 3),
  };
};

// ---- Async: load all signals and infer -----------------------------------

/**
 * Load the user's signals from Prisma and run `inferPersonaFromSignals`.
 * Always resolves; returns a safe default on any DB error.
 *
 * @param {string} userId
 * @returns {Promise<{persona: string, confidence: number, evidence: Array}>}
 */
export const inferPersona = async (userId) => {
  if (!userId) {
    return { persona: PERSONAS.ALL_ROUNDER, confidence: 0, evidence: [] };
  }
  try {
    const [searches, behaviorScores, wishlistPhones, preference] = await Promise.all([
      prisma.searchHistory.findMany({
        where: { userId },
        orderBy: { searchedAt: "desc" },
        take: 30,
        select: { searchQuery: true },
      }),
      loadBehaviorScoreMap(userId),
      loadWishlistPhones(userId),
      prisma.userPreference.findUnique({
        where: { userId },
        select: {
          cameraPreference: true,
          usageType: true,
          preferredBrands: true,
        },
      }),
    ]);

    return inferPersonaFromSignals({
      searches,
      browses: [],
      behaviorScores,
      wishlistPhones,
      preference,
    });
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[persona] inferPersona failed:", err?.message || err);
    } else {
      console.error("[persona] inferPersona failed:", err);
    }
    return { persona: PERSONAS.ALL_ROUNDER, confidence: 0, evidence: [] };
  }
};

// ---------------------------------------------------------------------------
// Example usage
// ---------------------------------------------------------------------------
//
//   import { inferPersona, inferPersonaFromSignals } from "./personaInferenceService.mjs";
//
//   // Async — DB-backed:
//   const { persona, confidence, evidence } = await inferPersona(userId);
//   // → { persona: 'Gamer', confidence: 0.78, evidence: [...] }
//
//   // Pure — for tests:
//   const r = inferPersonaFromSignals({
//     searches: [{ searchQuery: 'best rog phone' }],
//     behaviorScores: new Map([['gaming', 2.0]]),
//     wishlistPhones: [{ antutuScore: 950000, specs: {} }],
//     preference: { usageType: 'Gamer' },
//   });
//
// ---------------------------------------------------------------------------
// Suggested unit tests
// ---------------------------------------------------------------------------
//
//   - search "rog" alone → Gamer confidence > 0.5.
//   - camera:photophile + 50MP wishlist → Camera_Lover.
//   - battery ≥ 5000 wishlist → Battery_Focused.
//   - empty signals → All_Rounder (default catch-all).
//   - softmax outputs sum to ~1 within ε.
//
// ---------------------------------------------------------------------------
// Assumptions
// ---------------------------------------------------------------------------
//
//   - The "Photophile" enum is the project's existing
//     CameraPreference value (see `prisma/schema.prisma`).
//   - The "Gamer" / "Business" / "Creator" usageType values are
//     defined in the `UsageType` enum.
//   - The user has at most a few dozen signals; iterating them in
//     memory is fine. For ≥10k signals we'd precompute a Redis
//     cache — out of scope here.
//   - We never call the ML service. Heuristics are deterministic and
//     inspectable by ops via the `evidence` field.