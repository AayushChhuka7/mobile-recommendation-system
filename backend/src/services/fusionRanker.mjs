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

import { searchHistoryScore } from "./searchHistoryScore.mjs";

// ---- Weight table ---------------------------------------------------------
//
// Sums to 1.0 exactly. To re-add popularity: shrink each entry to
// w * 0.95 (so the original 0.05 popularity slot becomes available),
// then add `popularity: 0.05` to the table.
export const FUSION_WEIGHTS = Object.freeze({
  compatibility: 0.4211,
  customer_preference: 0.2105,
  content_similarity: 0.1579,
  search_history: 0.1053,
  value: 0.1053,
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

// Read the 5 sub-scores out of an enriched candidate row. Each
// FastAPI-side score (overallScore / matchScoreFastApi / valueScore)
// is on a 0..100 scale; we divide by 100 to normalise.
function computeComponents(c, behaviorScores) {
  return {
    compatibility: clamp01(
      Number.isFinite(c.overallScore) ? c.overallScore / 100 : 0,
    ),
    customer_preference: clamp01(
      Number.isFinite(c.matchScoreFastApi) ? c.matchScoreFastApi / 100 : 0,
    ),
    content_similarity: clamp01(
      Number.isFinite(c.contentSim) ? c.contentSim : 0,
    ),
    // searchHistoryScore is the only score with a non-trivial
    // calculation: it folds the user's BehaviourScore map onto the
    // phone's tag set. Returns the neutral 0.5 when behaviorScores is
    // null or has no overlap with the phone's tags.
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