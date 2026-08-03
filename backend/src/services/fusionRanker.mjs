// fusionRanker — Step D. Pure final-ranking fusion.
//
// Combines five signals (compatibility, customer_preference,
// content_similarity, search_history, value) into a single finalScore
// per candidate. The 6th slot from the original spec ("popularity")
// is deliberately omitted — the user has reserved its 0.05 weight for
// a future customer-segmentation cluster (same-cluster phones boost
// each other). Today the remaining five weights scale up
// proportionally so they sum to exactly 1.0.
//
// Shape contract:
//   candidates[]      → list of enriched candidates (see Step D plan §"Sub-score sourcing")
//   behaviorScores    → Map<tag, score> from BehaviorScore rows; null/empty for new users
//
// Returns the same list with `finalScore` (0..1) and `components`
// (the 5 sub-scores in [0,1]) attached, sorted by finalScore desc.
//
// Phase 3 (compare redesign):
//   - `customer_preference` widens from 0.2105 → 0.2632 to absorb the
//     new per-phone affinity (`affinity:<phoneId>`), per-model
//     cluster (`model:<hash>`), gated brand lift (`brand:<X>` after
//     ≥3 distinct phones), tier (`tier:<T>`) and feature vector
//     (`feature:<dim>`). Behaviour now contributes ±0.27 of the final
//     score (was ±0.21).
//   - `search_history` shrinks from 0.1053 → 0.0526 to fund the
//     widening. `search_history` is now keyword/legacy-overlap only;
//     brand/feature/affinity no longer leak through it (a deliberate
//     deduplication — they live in `customer_preference`).
//   - `compatibility`, `content_similarity`, `value` unchanged.

import { searchHistoryScore } from "./searchHistoryScore.mjs";
import { shortTermMatch } from "./shortTermInterest.mjs";
import { BEHAVIOR_CONFIG } from "../config/behaviorConfig.mjs";
import { hashModelName } from "./behaviorAnalyzer.mjs";


// ---- Weight table ---------------------------------------------------------
//
// Sums to 1.0 exactly. To re-add popularity: shrink each entry to
// w * 0.95 (so the original 0.05 popularity slot becomes available),
// then add `popularity: 0.05` to the table.
export const FUSION_WEIGHTS = Object.freeze({
  compatibility:        0.4211,
  customer_preference:  0.2632,
  content_similarity:   0.1579,
  search_history:       0.0526,
  value:                0.1053,
});

// Reserved slot — not consumed today. Exported so a future step
// (segmentation cluster popularity) can wire it in without touching
// the rest of the ranker.
export const FUSION_WEIGHTS_RESERVED_POPULARITY = 0.05;

// ---- Pure helpers ---------------------------------------------------------

// Clamp a value to [0, 1]. The sub-score sources are already in [0, 1]
// or [0, 100] (we divide by 100), but defensive clamping prevents
// weird inputs from leaking through.
function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// Sanitize a brand name to the same fold `behaviorAnalyzer` writes
// into `brand:<X>` tags. Kept local to the ranker so the ranker can
// be tested without importing the analyzer.
function sanitizeBrand(name) {
  if (typeof name !== "string" || !name) return null;
  const s = name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40).toLowerCase();
  return s || null;
}

// Neutral default used when behaviour data is missing or empty. Keeps
// `customer_preference` non-zero for cold-start users so the slot
// remains meaningful in the FE-facing SHAP vector.
const NEUTRAL = 0.5;

// Compute `customer_preference` for a single candidate, blending
// per-phone affinity (`affinity:<phoneId>`), per-model cluster
// (`model:<hash>`), brand lift (`brand:<X>`, gated at write time),
// tier (`tier:<T>`) and feature vector (`feature:<dim>`).
//
// Each tag-row is a raw `BehaviorScore` value in roughly [-4, 4]
// (post-tanh saturates near +4 for positive, -2 for negative). We
// sum them weighted by `BEHAVIOR_CONFIG.affinity.*`, then squash the
// total through `(tanh(0.75·raw) + 1) / 2` so the slot stays in [0, 1]
// even when multiple signals stack.
//
// Returns the neutral 0.5 when:
//   - `behaviorScores` is null or empty
//   - the candidate has no phoneId, modelName, or brand
//   - none of the new tags have a positive score for this candidate
//
// This shape matches the legacy `matchScoreFastApi / 100` fallback
// for cold users (a 0.5 neutral) so dashboards don't visually shift
// for cold-start accounts.
function customerPreferenceFor(behaviorScores, candidate) {
  if (!behaviorScores || behaviorScores.size === 0) return NEUTRAL;

  const phoneId =
    candidate && typeof candidate.id === "string" && candidate.id
      ? candidate.id
      : null;
  const modelName =
    candidate && typeof candidate.modelName === "string"
      ? candidate.modelName
      : null;
  const brandName =
    candidate && candidate.brand && typeof candidate.brand.name === "string"
      ? candidate.brand.name
      : null;

  if (!phoneId && !modelName && !brandName) return NEUTRAL;

  const aff = BEHAVIOR_CONFIG.affinity;
  let raw = 0;
  let touched = 0;

  // 1. Per-phone affinity. The strongest direct signal.
  if (phoneId) {
    const s = behaviorScores.get(`affinity:${phoneId}`);
    if (Number.isFinite(s) && s > 0) {
      raw += s * aff.phoneAffinity;
      touched += 1;
    }
  }

  // 2. Per-model cluster. Two phones of the same model (e.g.
  //    "Apple iPhone 17e" from two different stores) share this tag.
  const modelHash = hashModelName(modelName);
  if (modelHash) {
    const s = behaviorScores.get(`model:${modelHash}`);
    if (Number.isFinite(s) && s > 0) {
      raw += s * aff.modelAffinity;
      touched += 1;
    }
  }

  // 3. Brand lift. Pre-gated at write time (only fires after ≥3
  //    distinct phones of that brand touched by the user). A small
  //    "seed" delta may also be present; we treat it identically
  //    since it carries the same brand signal at lower magnitude.
  const brand = sanitizeBrand(brandName);
  if (brand) {
    const s = behaviorScores.get(`brand:${brand}`);
    if (Number.isFinite(s) && s > 0) {
      raw += s * aff.brandGatedAffinity;
      touched += 1;
    }
  }

  // 4. Tier (`tier:<T>`).
  const tier =
    candidate && typeof candidate.tier === "string" ? candidate.tier : null;
  if (tier) {
    const s = behaviorScores.get(`tier:${tier.toLowerCase()}`);
    if (Number.isFinite(s) && s > 0) {
      raw += s * aff.tierAffinity;
      touched += 1;
    }
  }

  // 5. Feature vector. Average across the feature:* rows that this
  //    candidate carries in its `tags` array. We re-derive the
  //    feature tags here rather than reading from the candidate's
  //    tags array (which is set by `phoneToTags` and may include
  //    non-feature entries).
  const profile = behaviorScores;
  const featureScores = [];
  for (const tag of FEATURE_TAGS) {
    const s = profile.get(tag);
    if (Number.isFinite(s) && s > 0) featureScores.push(s);
  }
  if (featureScores.length > 0) {
    const avg = featureScores.reduce((a, b) => a + b, 0) / featureScores.length;
    raw += avg * aff.featureAffinity;
    touched += 1;
  }

  if (touched === 0) return NEUTRAL;

  // Squash to [0, 1] via tanh. The 0.75 multiplier matches the
  // existing `searchHistoryScore` curve so FE-facing SHAP math is
  // comparable across slots.
  const squashed = Math.tanh(0.75 * raw);
  return clamp01((squashed + 1) / 2);
}

// The canonical feature-tag strings we read out of `behaviorScores`.
// Kept here as a frozen list so the ranker doesn't iterate over the
// candidate's tag array (which mixes feature, brand, tier, etc).
const FEATURE_TAGS = Object.freeze([
  "feature:gaming",
  "feature:camera",
  "feature:battery",
  "feature:performance",
  "feature:display",
]);

// Read the 5 sub-scores out of an enriched candidate row. Each
// FastAPI-side score (overallScore / matchScoreFastApi / valueScore)
// is on a 0..100 scale; we divide by 100 to normalise. The
// `customer_preference` slot is now derived from the user's
// BehaviorScore rows (per-phone affinity, per-model cluster, gated
// brand, tier, and feature vector) instead of FastAPI's
// `matchScoreFastApi`. Cold users still get a neutral 0.5 from
// `customerPreferenceFor` so the dashboard layout doesn't shift.
function computeComponents(c, behaviorScores) {
  return {
    compatibility: clamp01(
      Number.isFinite(c.overallScore) ? c.overallScore / 100 : 0,
    ),
    customer_preference: customerPreferenceFor(behaviorScores, c),
    content_similarity: clamp01(
      Number.isFinite(c.contentSim) ? c.contentSim : 0,
    ),
    // searchHistoryScore is keyword-only now. It folds the user's
    // BehaviourScore map onto the phone's STATIC tag set
    // (`feature:*`, `tier:*`, legacy `gaming`/`camera`) — the new
    // per-phone and per-model tags are NOT in `phone.tags` so they
    // do not contribute here. Brand/feature/affinity live in
    // `customer_preference`; this slot is now keyword-driven only.
    search_history: searchHistoryScore(
      { tags: Array.isArray(c.tags) ? c.tags : [] },
      behaviorScores,
    ),
    value: clamp01(
      Number.isFinite(c.valueScore) ? c.valueScore / 100 : 0,
    ),
  };
}

// Fuse a single candidate's 5 sub-scores into a finalScore in [0,1].
// Returns { finalScore, components } so the FE / future analytics
// can show *why* a phone ranked where it did.
export function fuseOne(candidate, behaviorScores) {
  const components = computeComponents(candidate, behaviorScores);
  let finalScore = 0;
  for (const key of Object.keys(FUSION_WEIGHTS)) {
    finalScore += FUSION_WEIGHTS[key] * (components[key] ?? 0);
  }
  return { finalScore, components };
}

// Rank a list of candidates by fused score desc. Pure — does not
// mutate the input array. Returns a NEW list of candidates with
// `finalScore` and `components` attached.
//
// Tie-breaker: identical finalScores preserve the input order (Array
// .sort is stable in V8 ≥ Node 12), so the FastAPI ranker (the
// source of `matchScoreFastApi`) acts as the implicit tie-breaker.
export function fusionRank(candidates, behaviorScores) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  return candidates
    .map((c) => {
      const { finalScore, components } = fuseOne(c, behaviorScores);
      return { ...c, finalScore, components };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}

// ---- Short-term personalization layer -------------------------------------
//
// Blend weight for the fast-moving recency signal. The base fused score
// stays the anchor (stability + accuracy); the short-term match adds a
// bounded boost so recent behaviour visibly reorders the list without
// letting a single session hijack it.
//
//   personalizedScore = (1 - α) * baseFinalScore + α * shortTermMatch
//
// α = 0.18 is chosen so the boost band (±0.18) is ~3.5x wider than the
// old ±0.05 behaviour swing — enough that adjacent phones actually swap
// after one event — while still small enough that a phone with a much
// higher base score won't be leap-frogged by an unrelated candidate.
// This is the single knob that trades "movement" against "stability".
export const SHORT_TERM_BLEND_ALPHA = 0.18;

// Personalized ranking: runs the pure 5-signal fusion, then folds in the
// short-term interest match as an additive, bounded boost. Falls back to
// plain `fusionRank` behaviour when there is no recent signal (empty
// interest vector) so cold-start users are unaffected.
//
//   candidates       — enriched candidate rows (same shape as fusionRank)
//   behaviorScores   — Map<tag, score> long-term signal (may be null)
//   interestVec      — Map<dim, weight> unit vector (may be empty)
//   metaByPhoneId    — Map<phoneId, meta> for shortTermMatch (may be empty)
//
// Returns a NEW list with `finalScore`, `components`, `baseScore`, and
// `shortTermMatch` attached, sorted by personalized finalScore desc.
export function personalizedRank(
  candidates,
  behaviorScores,
  interestVec,
  metaByPhoneId,
) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const hasShortTerm =
    interestVec && typeof interestVec.size === "number" && interestVec.size > 0;
  const metas = metaByPhoneId instanceof Map ? metaByPhoneId : new Map();

  return candidates
    .map((c) => {
      const { finalScore: baseScore, components } = fuseOne(c, behaviorScores);
      let stMatch = 0;
      if (hasShortTerm) {
        const meta = c && c.id ? metas.get(c.id) : null;
        stMatch = shortTermMatch(meta, interestVec);
      }
      const finalScore = hasShortTerm
        ? (1 - SHORT_TERM_BLEND_ALPHA) * baseScore +
          SHORT_TERM_BLEND_ALPHA * stMatch
        : baseScore;
      return {
        ...c,
        baseScore,
        shortTermMatch: stMatch,
        finalScore,
        components,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}


