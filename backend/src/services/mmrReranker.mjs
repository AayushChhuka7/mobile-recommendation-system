// mmrReranker — Fix #5, maximal-marginal-relevance re-ranker.
//
// Re-orders a relevance-sorted list so the top of the list is
// relevance-dominant but near-duplicate phones don't crowd each
// other out. Pure, deterministic for a given input + lambda.
//
// Why a separate function and not a slot in fusionRanker?
//   - MMR is O(K²) in the top-K window. We only need it on the
//     top-K (default 50) of the 200 ranked candidates — applying
//     it to the full 200 list would be 200² = 40k comparisons
//     and 99% of them never surface.
//   - MMR is orthogonal to fusionRank: it can be skipped, retried
//     with a different lambda, or composed with the exploration
//     pass (#6) without touching the ranker.
//
// Lambda (the relevance / diversity knob):
//   - lambda = 1.0  →  pure relevance (no diversity)
//   - lambda = 0.78 →  product default; small diversity lift
//   - lambda = 0.0  →  pure diversity (ignores relevance)
//
// Conflict note (vs. Fix #6 exploration):
//   The exploration pass MUST run AFTER MMR, not before. Otherwise
//   MMR will penalise the exploration pick as a near-duplicate of
//   an already-selected phone and the user will never see
//   exploration slots in the visible top 5.

import { hashModelName } from "./behaviorAnalyzer.mjs";

// Default per-pair similarity function. Brand+series+tier is enough
// to catch "Galaxy S24 vs Galaxy S24 Ultra" without doing a full
// feature-vector dot product. We deliberately do NOT reuse
// `hashModelName` for the series bucket — see the comment in
// `seriesKey` below.
export function defaultSim(a, b) {
  if (!a || !b) return 0;
  const sameSeries = seriesKey(a) === seriesKey(b) ? 0.7 : 0;
  const sameBrand  = a.brand?.name && b.brand?.name &&
    a.brand.name.toLowerCase() === b.brand.name.toLowerCase() ? 0.2 : 0;
  const sameTier   = a.tier && b.tier && a.tier === b.tier ? 0.1 : 0;
  return sameSeries + sameBrand + sameTier;
}

// "Series" bucket. Split the model name on whitespace and take the
// first two tokens. "Galaxy S24" → "Galaxy S24", "Galaxy S24 Ultra"
// → "Galaxy S24" → same bucket, score 0.7. This is intentionally a
// coarser bucket than `hashModelName` (which the ranker uses for
// affinity — same hash = same model = strong lift). For diversity
// we want the OPPOSITE: a Galaxy S24 and Galaxy S24 Ultra should be
// considered similar (penalised) but not identical.
function seriesKey(c) {
  if (!c || typeof c.modelName !== "string") return "";
  const parts = c.modelName.trim().split(/\s+/).slice(0, 2);
  return parts.join(" ").toLowerCase();
}

// Re-rank `candidates` (assumed sorted by relevance desc) using MMR
// on the top-K. Returns a NEW array; the input is not mutated.
//
//   candidates — array of { ..., finalScore } from personalizedRank / fusionRank
//   lambda     — relevance weight in [0, 1]
//   similarity — fn(a, b) -> [0, 1]; defaults to brand+series+tier key
//   topK       — only the top-K is reranked. The remainder is appended
//                in original order so we never blow up latency on
//                the long tail of the 200-list.
//
// Time complexity: O(K²). K=50, 200 candidates → 2,500 ops, < 1ms.
export function mmrRerank(candidates, lambda = 0.78, similarity = defaultSim, topK = 50) {
  if (!Array.isArray(candidates) || candidates.length === 0) return candidates;
  if (lambda < 0) lambda = 0;
  if (lambda > 1) lambda = 1;

  const top = candidates.slice(0, topK);
  const rest = candidates.slice(topK);
  if (top.length <= 1) return candidates;

  // Normalise relevance to [0, 1] within the top-K so the relevance
  // term is on the same scale as the similarity term. Two phones
  // both at 0.93 finalScore should have equal relevance here even
  // if the catalog mean is 0.6.
  const scores = top.map((c) => (Number.isFinite(c.finalScore) ? c.finalScore : 0));
  const minS = Math.min(...scores);
  const maxS = Math.max(...scores);
  const span = (maxS - minS) || 1;
  const rel = scores.map((s) => (s - minS) / span);

  // Work in a parallel array for O(1) splice. The "remaining" buffer
  // holds candidates we haven't picked yet; each iteration we pick
  // the one with the highest MMR score.
  const remaining = top.map((c, i) => ({ c, rel: rel[i] }));
  const selected = [];

  // Seed with the highest-relevance item. Greedy, deterministic.
  remaining.sort((a, b) => b.rel - a.rel);
  selected.push(remaining.shift());

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const r = remaining[i];
      let maxSim = 0;
      for (const s of selected) {
        const sim = similarity(r.c, s.c);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lambda * r.rel - (1 - lambda) * maxSim;
      if (mmr > bestVal) {
        bestVal = mmr;
        bestIdx = i;
      }
    }
    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return [...selected.map((s) => s.c), ...rest];
}
