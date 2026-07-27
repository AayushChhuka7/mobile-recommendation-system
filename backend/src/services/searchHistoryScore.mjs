// searchHistoryScore — Step B.
//
// Pure function. No Prisma / no HTTP. Converts a single phone's tags
// into a [0, 1] affinity score relative to the user's behaviour
// score map. The Final Ranking Formula (Step D) consumes this as one
// of six sub-scores.
//
// Why a separate file from `behaviorAnalyzer`?
//   - `behaviorAnalyzer` writes scores (the Event → BehaviorScore write
//     path).
//   - `searchHistoryScore` reads scores (the BehaviorScore → per-phone
//     affinity read path).
// Keeping them apart means we can hot-swap the scoring formula without
// touching the write path, and we can unit-test both in isolation.
//
// Inputs:
//   phone        — enriched phone object (must include `brand.name`,
//                  `specs.chipset`, `batteryMah`, `antutuScore`,
//                  `variants[0].price`, `variants[0].ramGb`,
//                  `specs.refreshRate`, `specs.mainCamera`).
//   behaviorMap  — { [tag]: score } from BehaviorScore. May be empty.
//
// Output:
//   number in [0, 1] — `1` means "strongly matches past behaviour";
//   `0` means "neutral" (no behaviour data OR no tag overlap).
//
// Tag conventions (must match `behaviorAnalyzer.tagsForEvent`):
//   brand:<BrandName>          e.g. "brand:Samsung"
//   tier:<budget|mid|premium|flagship>
//   chipset:<family>           e.g. "chipset:snapdragon-flagship"
//   category:<gaming|camera|battery|display>
//   query:<lowercased-query>   e.g. "query:rog"

import { applyDecay } from "./behaviorAnalyzer.mjs";

// ---- Per-dimension weights ----
//
// How much each tag dimension contributes to the final affinity score.
// They sum to 1 so the result is bounded.
//
// `category` gets the biggest slice because it directly mirrors the
// persona-style traits the user expressed (gamer→gaming, camera lover
// → camera). `query` is a secondary, lower-trust signal — same word
// can mean different things in different contexts, so we dampen it.
//
// Tweak these to taste; they're documented hyperparameters.

const DIMENSION_WEIGHTS = Object.freeze({
  brand: 0.25,
  tier: 0.10,
  chipset: 0.20,
  category: 0.35,
  query: 0.10,
});

// ---- Per-dimension tag derivation ----
//
// Given a phone + (optional) recent search query, build the set of
// `tag → per-dimension` mappings we want to compare against the user's
// behavior map. Mirrors `tagsForEvent` in `behaviorAnalyzer` but
// returns the per-dimension structure this scorer needs.
//
// Exported so the event service can verify "what tag did the user
// actually score?" without duplicating the heuristic.

const TIER_BANDS = [
  { name: "budget",      max: 300 },
  { name: "mid",         max: 600 },
  { name: "premium",     max: 1000 },
  { name: "flagship",    max: Infinity },
];

const tierFromPrice = (price) => {
  const p = Number(price);
  if (!Number.isFinite(p)) return null;
  for (const band of TIER_BANDS) {
    if (p < band.max) return band.name;
  }
  return "flagship";
};

const chipsetFamily = (chipset) => {
  if (!chipset || typeof chipset !== "string") return null;
  const c = chipset.toLowerCase();
  if (c.includes("snapdragon 8") || c.includes("snapdragon 8+")) return "snapdragon-flagship";
  if (c.includes("snapdragon 7")) return "snapdragon-upper-mid";
  if (c.includes("snapdragon")) return "snapdragon";
  if (c.includes("dimensity 9")) return "dimensity-flagship";
  if (c.includes("dimensity 8")) return "dimensity-upper-mid";
  if (c.includes("dimensity")) return "dimensity";
  if (c.includes("apple") || c.includes("a1") || c.includes("a2") || c.includes("a3")) return "apple-silicon";
  if (c.includes("exynos 2")) return "exynos-flagship";
  if (c.includes("exynos")) return "exynos";
  if (c.includes("tensor")) return "google-tensor";
  if (c.includes("kirin")) return "kirin";
  return null;
};

const dominantCategory = (phone) => {
  if (!phone) return null;

  const ram = phone?.variants?.[0]?.ramGb ?? phone?.ramGb ?? null;
  const battery = phone?.batteryMah ?? phone?.specs?.batteryMah ?? null;
  const antutu = phone?.antutuScore ?? null;
  const camera = phone?.specs?.mainCamera ?? phone?.mainCamera ?? null;
  const refresh = phone?.specs?.refreshRate ?? phone?.refreshRate ?? null;

  if ((antutu && antutu >= 900_000) || (ram && ram >= 12 && refresh && refresh >= 120)) {
    return "gaming";
  }
  if (camera && typeof camera === "string" && /periscope|\b200\b|\b108\b|\b50\b.*\b50\b/i.test(camera)) {
    return "camera";
  }
  if (battery && battery >= 5500) {
    return "battery";
  }
  if (refresh && refresh >= 120) {
    return "display";
  }
  return null;
};

/**
 * Build the per-dimension tag set for a phone. Returns
 *   { brand?: [string], tier?: [string], chipset?: [string],
 *     category?: [string], query?: [string] }
 *
 * Each dimension is a list because in the future a phone might map to
 * more than one category (e.g. a phone that's both gaming-class AND
 * battery-focused). Today's heuristics only emit at most one value per
 * dimension, but the list shape lets the scorer use `Math.max(...)`
 * safely without a special case.
 *
 * @param {object} phone           enriched phone
 * @param {string|null} recentQuery most recent search query (if known)
 * @returns {Record<string, string[]>}
 */
export const tagsForPhone = (phone, recentQuery = null) => {
  const out = {};

  const brand =
    phone?.brand?.name ??
    (typeof phone?.brand === "string" ? phone.brand : null);
  if (brand) out.brand = [brand];

  const price =
    phone?.cheapestVariant?.price ??
    phone?.variants?.[0]?.price ??
    phone?.price ??
    null;
  const tier = tierFromPrice(price);
  if (tier) out.tier = [tier];

  const chip = phone?.specs?.chipset ?? phone?.chipset ?? null;
  const family = chipsetFamily(chip);
  if (family) out.chipset = [family];

  const cat = dominantCategory(phone);
  if (cat) out.category = [cat];

  if (recentQuery && typeof recentQuery === "string" && recentQuery.trim().length > 0) {
    out.query = [recentQuery.trim().toLowerCase()];
  }

  return out;
};

// ---- Scoring ----
//
// For each dimension we walk the phone's tags, look up the user's
// behaviour score for that exact tag, and accumulate:
//
//   dimensionScore = sum( max(0, behavior_score_for_tag) ) / N
//
// Why `max(0, ...)`:
//   - Behaviour scores can be negative (the user *dismissed* phones
//     of this brand). We don't want to reward a phone for being
//     disliked; we want it to be penalised.
//
// Why divide by N:
//   - A phone with 4 brand tags (none today, but the shape supports
//     it) should not score 4× a phone with 1 brand tag for the same
//     behaviour intensity. Average, not sum.
//
// Final score is a weighted sum of dimension scores, then mapped from
// [0, +∞) → [0, 1] via a softplus-style sigmoid so a runaway "saved
// Samsung 100 times" doesn't peg the score at 1.0.
//
//   final = 1 - exp(-raw)
// where `raw` is the weighted sum. `raw = 0` → score = 0. `raw = 1`
// → score ≈ 0.63. `raw = 3` → score ≈ 0.95. This keeps the score
// spread across the full range for typical behaviour intensities
// while preventing any single dimension from running away.

const SIGMOID_K = 1.0; // larger K = steeper curve, faster saturation

/**
 * Compute the [0, 1] affinity score for a single phone.
 *
 * @param {object} phone           enriched phone (see tagsForPhone for shape)
 * @param {Record<string, number>|null} behaviorMap
 *                                 { "brand:Samsung": 4.2, ... } — may be
 *                                 null / empty for a brand-new user.
 * @param {string|null} recentQuery most recent search query (optional)
 * @returns {number} in [0, 1]
 */
export const searchHistoryScore = (phone, behaviorMap, recentQuery = null) => {
  if (!phone) return 0;
  const map = behaviorMap && typeof behaviorMap === "object" ? behaviorMap : {};
  if (Object.keys(map).length === 0) return 0;

  const phoneTags = tagsForPhone(phone, recentQuery);
  if (Object.keys(phoneTags).length === 0) return 0;

  let raw = 0;

  for (const [dimension, tags] of Object.entries(phoneTags)) {
    const weight = DIMENSION_WEIGHTS[dimension] ?? 0;
    if (weight === 0 || tags.length === 0) continue;

    let dimScore = 0;
    for (const tagValue of tags) {
      const tagKey = `${dimension}:${tagValue}`;
      const beh = Number(map[tagKey]);
      // Treat unknown / negative / non-finite as "no signal". A
      // dismissal should hurt (see applyDecay), so we *don't* zero
      // negatives — we just refuse to let them reward the phone.
      if (!Number.isFinite(beh) || beh <= 0) continue;
      dimScore += beh;
    }
    // Average over the dimension's tag count so a phone with N tags
    // in a dimension doesn't dominate a phone with 1.
    dimScore /= tags.length;
    raw += weight * dimScore;
  }

  if (raw <= 0) return 0;
  // Map [0, ∞) → [0, 1) with a softplus-style curve.
  const score = 1 - Math.exp(-SIGMOID_K * raw);
  // Clamp defensively against float edge cases.
  if (score < 0) return 0;
  if (score > 1) return 1;
  return score;
};

/**
 * Convenience: score an array of phones in one pass and return a new
 * array of the same shape with `{ searchHistoryScore }` attached.
 *
 * Used by the recommend service when it wants to attach the sub-score
 * without changing the original list order.
 *
 * @template T
 * @param {T[]} phones
 * @param {Record<string, number>|null} behaviorMap
 * @param {string|null} recentQuery
 * @returns {Array<T & { searchHistoryScore: number }>}
 */
export const attachSearchHistoryScores = (phones, behaviorMap, recentQuery = null) => {
  if (!Array.isArray(phones)) return [];
  return phones.map((p) => ({
    ...p,
    searchHistoryScore: searchHistoryScore(p, behaviorMap, recentQuery),
  }));
};

// Re-export `applyDecay` so the event controller only needs to import
// from this file when computing both read & write paths.
export { applyDecay };