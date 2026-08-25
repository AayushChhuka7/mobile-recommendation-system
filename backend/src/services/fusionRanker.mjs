// fusionRanker — Step D. Pure final-ranking fusion.
//
// Combines sub-scores (compatibility, customer_preference,
// content_similarity, search_history, value, freshness_trending) into
// a single finalScore per candidate. The 6th slot
// (freshness_trending) is the new entry from Fix #9; it pulls
// weight from `compatibility` and `value` proportionally. Sum stays
// exactly 1.0.
//
// Learned weights (Fix #3):
//   The ranker now reads a JSON artifact written by the weekly
//   `train_fusion_weights.py` job. The artifact, if present and
//   valid, replaces the hand-tuned defaults. Cold start (no
//   artifact, or invalid artifact) falls back to the hand-tuned
//   table. Reload is on file-watch — no BE restart required.

import { searchHistoryScore } from "./searchHistoryScore.mjs";
import { shortTermMatch } from "./shortTermInterest.mjs";
import { BEHAVIOR_CONFIG } from "../config/behaviorConfig.mjs";
import { hashModelName } from "./behaviorAnalyzer.mjs";
import { readFileSync, watchFile } from "node:fs";
import { resolve } from "node:path";


// ---- Weight table (defaults; overridden by learned artifact) --------------
//
// Sums to 1.0 exactly. If you add a slot, shrink the others to make
// room. Re-exported as `DEFAULT_FUSION_WEIGHTS` so the trainer can
// log them and operators can diff against the live values.
export const DEFAULT_FUSION_WEIGHTS = Object.freeze({
  compatibility:        0.30,   // was 0.32 (gave 0.02 to freshness_trending)
  customer_preference:  0.31,   // unchanged
  content_similarity:   0.18,   // unchanged
  search_history:       0.08,   // unchanged
  value:                0.10,   // was 0.11 (gave 0.01 to freshness_trending)
  freshness_trending:   0.03,   // new in Fix #9
});

const FUSION_WEIGHT_KEYS = Object.freeze([
  "compatibility",
  "customer_preference",
  "content_similarity",
  "search_history",
  "value",
  "freshness_trending",
]);

// ---- Learned-weights loader -----------------------------------------------
//
// Reads ML Model/artifacts/fusion_weights.json if present. The file
// is the output of train_fusion_weights.py and contains a `weights`
// object { slot: number }. The loader validates the structure
// (expected keys, numeric values, sums to ~1.0) and falls back to
// defaults on any failure so a bad artifact can never crash the
// ranker. Hot-reload via fs.watchFile (5s polling) so the weekly
// refit picks up without a BE restart.

const ARTIFACT_PATH = (() => {
  // Resolve relative to the BE process CWD so docker-compose mounts
  // land in the right place. We try a couple of likely locations.
  const candidates = [
    resolve(process.cwd(), "ML Model/artifacts/fusion_weights.json"),
    resolve(process.cwd(), "../ML Model/artifacts/fusion_weights.json"),
    resolve(process.cwd(), "../../ML Model/artifacts/fusion_weights.json"),
  ];
  // Pick the first that exists at module load; if none exist yet,
  // the readFileSync below will simply throw and we fall back.
  for (const p of candidates) {
    try {
      readFileSync(p, "utf8");
      return p;
    } catch {
      // try next
    }
  }
  return candidates[0]; // default; will be re-checked on watch
})();

function loadFusionWeightsFromDisk() {
  try {
    const txt = readFileSync(ARTIFACT_PATH, "utf8");
    const parsed = JSON.parse(txt);
    const weights = parsed && parsed.weights;
    if (!weights || typeof weights !== "object") {
      throw new Error("artifact missing `weights` object");
    }
    for (const k of FUSION_WEIGHT_KEYS) {
      if (typeof weights[k] !== "number") {
        throw new Error(`artifact missing numeric weight for "${k}"`);
      }
    }
    const sum = FUSION_WEIGHT_KEYS.reduce((a, k) => a + weights[k], 0);
    if (Math.abs(sum - 1) > 0.02) {
      throw new Error(`weights do not sum to ~1.0: ${sum.toFixed(3)}`);
    }
    return Object.freeze({ ...weights });
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[fusion] learned weights unavailable, using defaults:",
        e.message,
      );
    }
    return null;
  }
}

let _learnedWeights = loadFusionWeightsFromDisk();

// Hot-reload: poll the artifact every 5s. The weekly trainer
// rewrites the file in place; this picks it up without restart.
try {
  watchFile(ARTIFACT_PATH, { interval: 5000 }, () => {
    const next = loadFusionWeightsFromDisk();
    if (next) _learnedWeights = next;
  });
} catch {
  // fs.watchFile can throw on some filesystems. Cold start is fine.
}

// `FUSION_WEIGHTS` is now a live view: reads `_learnedWeights` if
// present, else the hand-tuned defaults. The frozen table shape is
// preserved so existing call sites (`FUSION_WEIGHTS[key]`) keep
// working unchanged.
export const FUSION_WEIGHTS = new Proxy({}, {
  get(_target, key) {
    const src = _learnedWeights || DEFAULT_FUSION_WEIGHTS;
    return src[key];
  },
  ownKeys() {
    return Reflect.ownKeys(_learnedWeights || DEFAULT_FUSION_WEIGHTS);
  },
  getOwnPropertyDescriptor(_t, key) {
    const src = _learnedWeights || DEFAULT_FUSION_WEIGHTS;
    return Object.getOwnPropertyDescriptor(src, key);
  },
});

// Reserved popularity slot — DEPRECATED in Fix #9 (the slot was
// reclaimed by `freshness_trending`). Kept as an export so callers
// that reference the constant still resolve cleanly.
export const FUSION_WEIGHTS_RESERVED_POPULARITY = 0.0;

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

// Read the sub-scores out of an enriched candidate row. Each
// FastAPI-side score (overallScore / matchScoreFastApi / valueScore)
// is on a 0..100 scale; we divide by 100 to normalise. The
// `customer_preference` slot is derived from the user's BehaviorScore
// rows (per-phone affinity, per-model cluster, gated brand, tier, and
// feature vector) instead of FastAPI's `matchScoreFastApi`. The
// `freshness_trending` slot (Fix #9) is a 70/30 blend of
// phone-level freshness (newer = higher) and the nightly
// phone_trends.trendScore. Cold phones (no releasedAt, no trend)
// get 0.5 (neutral) so the slot can never DROP a phone just
// because we lack data.
function computeComponents(c, behaviorScores) {
  const trend =
    Number.isFinite(c.trendScore) ? c.trendScore : 0;
  const fresh =
    Number.isFinite(c.freshness) ? c.freshness : 0.5;
  return {
    compatibility: clamp01(
      Number.isFinite(c.overallScore) ? c.overallScore / 100 : 0,
    ),
    customer_preference: customerPreferenceFor(behaviorScores, c),
    content_similarity: clamp01(
      Number.isFinite(c.contentSim) ? c.contentSim : 0,
    ),
    search_history: searchHistoryScore(
      { tags: Array.isArray(c.tags) ? c.tags : [] },
      behaviorScores,
    ),
    value: clamp01(
      Number.isFinite(c.valueScore) ? c.valueScore / 100 : 0,
    ),
    // 70% freshness (recency) + 30% trending. Trending without
    // recency creates a "rich get richer" loop; recency without
    // trending buries genuinely hot new releases. The blend makes
    // both signals visible in the slot.
    freshness_trending: clamp01(0.7 * fresh + 0.3 * trend),
  };
}

// Fuse a single candidate's sub-scores into a finalScore in [0,1].
// Returns { finalScore, components } so the FE / future analytics
// can show *why* a phone ranked where it did.
//
// The weights are read from `FUSION_WEIGHTS` (a Proxy that resolves
// to either the learned artifact or the hand-tuned defaults). Any
// new slot in FUSION_WEIGHTS_KEYS that the candidate doesn't carry
// falls back to 0 — so an old payload without the freshness slot
// simply contributes 0 to that key.
export function fuseOne(candidate, behaviorScores) {
  const components = computeComponents(candidate, behaviorScores);
  let finalScore = 0;
  for (const key of FUSION_WEIGHT_KEYS) {
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
//
// Optional `stockMultiplier` lets the caller (#9) apply a per-phone
// penalty (e.g. 0.85 for low-stock) without touching the ranker.
export function fusionRank(candidates, behaviorScores, stockMultiplier = null) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  return candidates
    .map((c) => {
      const { finalScore, components } = fuseOne(c, behaviorScores);
      let score = finalScore;
      if (stockMultiplier && Number.isFinite(stockMultiplier(c))) {
        score = Math.max(0, Math.min(1, finalScore * stockMultiplier(c)));
      }
      return { ...c, finalScore: score, components };
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
// α = 0.12 (was 0.26). One click on a phone card used to add up to
// 0.26 × 1.0 = 0.26 to the blended score — a 30%+ jump against a
// 0.7 base — which made the auto list visibly reshuffle after every
// "Recommend Me" click. At α = 0.12 the same click nudges by 0.12,
// which a typical 0.6–0.8 base score absorbs without reordering.
// Sustained behaviour (3+ recent events of the same brand/feature)
// still produces a visible reorder because each event adds
// independently and the tanh short-term match sums.
export const SHORT_TERM_BLEND_ALPHA = 0.12;

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
  stockMultiplier = null,
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
      let finalScore = hasShortTerm
        ? (1 - SHORT_TERM_BLEND_ALPHA) * baseScore +
          SHORT_TERM_BLEND_ALPHA * stMatch
        : baseScore;
      if (stockMultiplier && Number.isFinite(stockMultiplier(c))) {
        finalScore = Math.max(0, Math.min(1, finalScore * stockMultiplier(c)));
      }
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


