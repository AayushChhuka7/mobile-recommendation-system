// searchHistoryScore — Step B pure function.
//
// Computes a single "search-history" affinity score in [0, 1] for a
// candidate phone against the user's rolled-up `BehaviorScore` rows.
// This is the single-source-of-truth signal Step C (Profile Fusion) and
// Step D (Ranking) will read from — but it's exported here as an isolated
// pure function so it can be unit-tested before any ranking change ships.
//
// Contract:
//   searchHistoryScore(phone, behaviorScores) → number in [0, 1]
//
// Inputs:
//   phone           — the candidate phone. Must have a `tags` property
//                     which is an array of tag strings (e.g. ["brand:Samsung",
//                     "tier:flagship", "category:camera"]). Missing/empty
//                     `tags` → returns the neutral default 0.5.
//   behaviorScores  — Map<tag, score> OR a plain object { tag: score } from
//                     the user's BehaviorScore rows. Missing → neutral.
//
// Algorithm:
//   1. Tag overlap = sum of behaviourScores[t] for every t in phone.tags
//      that the user has a score for. Negative scores still count (they
//      push the total down). Tags the user has never interacted with
//      simply don't contribute.
//   2. Normalise to [0, 1] by clamping raw to [-1, 1] (extreme bounds)
//      and remapping via (raw + 1) / 2. A perfectly-aligned phone scores
//      1.0; a phone that hits only tags the user dislikes scores 0.0;
//      a phone with no overlapping tags scores 0.5 (neutral).
//
// Pure: no DB / no fetch. The caller hydrates behaviorScores first.

export function searchHistoryScore(phone, behaviorScores) {
  const tags =
    phone && Array.isArray(phone.tags) ? phone.tags.filter(isTagString) : [];
  if (tags.length === 0) return NEUTRAL;

  const scores = normaliseScoreMap(behaviorScores);
  if (scores.size === 0) return NEUTRAL;

  let raw = 0;
  let matched = 0;
  for (const tag of tags) {
    if (scores.has(tag)) {
      raw += scores.get(tag);
      matched += 1;
    }
  }

  // No overlap → neutral. We don't want a phone the user has never
  // interacted with to score above a phone they have positive history
  // on, but we also don't want it to score below.
  if (matched === 0) return NEUTRAL;

  // Sub-linear scaling so one big hit doesn't dwarf three small ones.
  // tanh(0.75 * raw) ∈ (−1, 1) and is squashed gently around 0.
  const squashed = Math.tanh(0.75 * raw);
  return (squashed + 1) / 2;
}

// ---- Internals (exported for tests) ---------------------------------------

export const NEUTRAL = 0.5;
const MAX_RAW = 5; // raw values above this are clipped pre-tanh

function isTagString(t) {
  return typeof t === "string" && t.length > 0 && t.length <= 60;
}

function normaliseScoreMap(input) {
  if (!input) return new Map();
  if (input instanceof Map) return input;
  if (typeof input === "object") {
    const out = new Map();
    for (const [k, v] of Object.entries(input)) {
      if (typeof k === "string" && Number.isFinite(v)) {
        out.set(k, v);
      }
    }
    return out;
  }
  return new Map();
}

// Convenience: build the `phone.tags` array the scorer expects from the
// fields we already have on a phone + brand + specs. Exported so callers
// don't reinvent the same mapping in three places.
//
// Inputs:
//   phone    — { modelName, brand: { name }, specs: { chipset }, antutuScore? }
//   events?  — optional. The same phoneId's events (we extract brand /
//              category / tier deltas from these when present). Most callers
//              should instead pre-materialise tags from the spec columns.
//
// Note: the BE preferes to compute tags lazily from the phone row at
// rank time. This helper exists so FE / tests can build a synthetic phone
// shape without hitting the DB.
export function phoneToTags(phone) {
  if (!phone || typeof phone !== "object") return [];
  const out = [];
  const brand = phone.brand && phone.brand.name;
  if (brand) out.push(`brand:${String(brand).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}`);
  if (typeof phone.antutuScore === "number") {
    if (phone.antutuScore >= 900_000) out.push("tier:flagship");
    else if (phone.antutuScore >= 500_000) out.push("tier:mid");
    else out.push("tier:budget");
  }

  // Feature tags MUST match the vocabulary the analyser writes to
  // `BehaviorScore.tag` (see behaviorAnalyzer `feature:<dim>`), otherwise
  // the exact-string overlap in `searchHistoryScore` never fires and the
  // user's feature affinity (gaming / camera / battery / display) is lost
  // from the Step D re-ranker. Previously this emitted a bare "gaming"
  // tag that could never match the stored "feature:gaming" score.
  const specs = (phone.specs && typeof phone.specs === "object") ? phone.specs : {};

  const chipset = specs.chipset;
  if (chipset && /snapdragon|dimensity|exynos|kirin|helio|rog/i.test(String(chipset))) {
    out.push("feature:gaming");
    out.push("feature:performance");
  }

  // Camera affinity — a high-MP main camera is our proxy for a
  // camera-focused phone (mirrors the analyser's feature bucketing).
  const cameraMp = parseInt(String(specs.mainCamera || "").match(/(\d+)\s*MP/i)?.[1] || "", 10);
  if (Number.isFinite(cameraMp) && cameraMp >= 48) {
    out.push("feature:camera");
  }

  // Battery affinity — a large cell is the battery-focused proxy.
  const battery = Number(specs.batteryMah);
  if (Number.isFinite(battery) && battery >= 5000) {
    out.push("feature:battery");
  }

  // Display affinity — a high refresh rate is the display-focused proxy.
  const refresh = Number(specs.refreshRate);
  if (Number.isFinite(refresh) && refresh >= 120) {
    out.push("feature:display");
  }

  return out;
}

// Helper for reading MAX_RAW (clamp util) — exported for tests.
export function clampRaw(raw) {
  if (!Number.isFinite(raw)) return 0;
  if (raw > MAX_RAW) return MAX_RAW;
  if (raw < -MAX_RAW) return -MAX_RAW;
  return raw;
}
