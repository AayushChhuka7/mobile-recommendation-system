// phoneFeatureProfile — Phase 1 of the behaviour-learning refresh.
//
// Build a *feature vector* for a single phone. The result is a
// `Map<dim, score ∈ [0,1]>` where each key is a canonical behaviour
// dim (`gaming`, `camera`, `battery`, `performance`, `display`).
//
// This replaces the older coarse `category` / `chipset` / `gaming`
// mapping in `behaviorAnalyzer.DELTAS`. Instead of one "this looks
// like a gaming phone" bump, every dim gets its own evidence-based
// score so a user who cares about camera doesn't accidentally end up
// with a "gaming +3" peak just for viewing an ROG phone.
//
// Pure module — no Prisma / no fetch. The caller is responsible for
// hydrating the `meta` object from `behaviorAnalyzer.lookupPhoneMeta`
// (which is already cached at module scope). The actual numeric
// thresholds live in `BEHAVIOR_CONFIG.featureThresholds` so tuning is
// a config-only edit, not a code change.
//
// Public exports:
//   buildPhoneFeatureProfile(meta)  → Map<dim, score>
//   phoneFeatureTag(dim)            → string  (e.g. "feature:gaming")
//   FEATURE_DIMS                    → string[] (canonical dim order)

import { BEHAVIOR_CONFIG } from "../config/behaviorConfig.mjs";

// Canonical dim order. Used by the analyser to emit feature:<dim>
// tags and by tests to assert shape stability. Order matters only for
// deterministic JSON serialisation — not for scoring.
export const FEATURE_DIMS = ["gaming", "camera", "battery", "performance", "display"];

// Chipset regex for the "gaming" dim. Matches:
//   - Snapdragon 8-series  (Snapdragon 8 Gen 3, SD 8+ Gen 1, ...)
//   - Dimensity 9 / 8000+   (Dimensity 9200, 9000+, 8300, ...)
//   - Apple A1x / A2x       (A14 Bionic and newer)
//   - Tensor G*             (Pixel 6+)
//   - "rog" / "redmagic" / "black shark" naming fallbacks
const GAMING_CHIPSET_RE =
  /(snapdragon\s*8|dimensity\s*[89]\d{2}|apple\s*a\d{2}|tensor\s*g\d|\brog\b|\bredmagic\b|\bblack\s*shark\b)/i;

// Helper: cap a value to [0, 1]. Defensive against float drift in
// threshold-floor calculations.
const clamp01 = (v) => {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
};

// ---- Per-dim builders ------------------------------------------------------
//
// Each builder is a pure function of (meta). Builders return a score
// ∈ [0, 1] — they do not emit tags directly. The caller (the analyser)
// multiplies by the per-event weight to produce the actual delta.

function gamingScore(meta) {
  if (!meta) return 0;
  const cfg = BEHAVIOR_CONFIG.featureThresholds.gaming;
  let s = 0;

  // Chipset matches a known flagship SoC → strong indicator.
  if (
    typeof meta.chipset === "string" &&
    GAMING_CHIPSET_RE.test(meta.chipset)
  ) {
    s += cfg.chipsetBoost;
  }

  // 120 Hz+ refresh rate is a meaningful gaming hint even on phones
  // with a mid-tier chipset.
  if (typeof meta.refreshRate === "number" && meta.refreshRate >= cfg.refreshMinHz) {
    s += cfg.refreshBoost;
  }

  // AnTuTu at flagship-tier land. Last-resort evidence.
  if (typeof meta.antutuScore === "number" && meta.antutuScore >= cfg.antutuMin) {
    s += cfg.antutuBoost;
  }

  return clamp01(s);
}

function cameraScore(meta) {
  if (!meta) return 0;
  const tiers = BEHAVIOR_CONFIG.featureThresholds.camera.tiers;
  const mp = typeof meta.mainCameraMp === "number" ? meta.mainCameraMp : null;
  if (mp == null) return 0;
  // tiers are sorted by minMp desc — first match wins.
  for (const t of tiers) {
    if (mp >= t.minMp) return t.score;
  }
  return 0;
}

function batteryScore(meta) {
  if (!meta) return 0;
  const tiers = BEHAVIOR_CONFIG.featureThresholds.battery.tiers;
  const mah = typeof meta.batteryMah === "number" ? meta.batteryMah : null;
  if (mah == null) return 0;
  for (const t of tiers) {
    if (mah >= t.minMah) return t.score;
  }
  return 0;
}

function performanceScore(meta) {
  if (!meta) return 0;
  const tiers = BEHAVIOR_CONFIG.featureThresholds.performance.tiers;
  const antutu =
    typeof meta.antutuScore === "number" ? meta.antutuScore : null;
  if (antutu == null) return 0;
  for (const t of tiers) {
    if (antutu >= t.minAnutu) return t.score;
  }
  return 0;
}

function displayScore(meta) {
  if (!meta) return 0;
  const cfg = BEHAVIOR_CONFIG.featureThresholds.display;
  let s = 0;
  if (typeof meta.refreshRate === "number" && meta.refreshRate >= cfg.refreshMinHz) {
    s += cfg.refreshBoost;
  }
  if (typeof meta.displaySize === "number" && meta.displaySize >= cfg.sizeMinInches) {
    s += cfg.sizeBoost;
  }
  return clamp01(s);
}

// Map of dim → builder fn. Kept module-scoped so callers can iterate
// without re-aliasing. The order is FEATURE_DIMS-ascending for
// stable iteration.
const FEATURE_BUILDERS = Object.freeze({
  gaming: gamingScore,
  camera: cameraScore,
  battery: batteryScore,
  performance: performanceScore,
  display: displayScore,
});

// ---- Public API ------------------------------------------------------------

// Build the full feature profile for a phone.
//
// Returns `Map<dim, score>` containing only the dims with a non-zero
// score for this phone. Dims with a zero score are NOT in the Map so
// downstream tag emission can `for..of` without a guard.
//
// The function is pure: identical `meta` objects produce identical
// Maps. We do NOT cache inside this module — `behaviorAnalyzer` owns
// the meta cache keyed by phoneId and re-uses the same Map instance
// when the meta is unchanged.
export function buildPhoneFeatureProfile(meta) {
  const out = new Map();
  if (!meta || typeof meta !== "object") return out;
  for (const dim of FEATURE_DIMS) {
    const fn = FEATURE_BUILDERS[dim];
    if (typeof fn !== "function") continue;
    const s = fn(meta);
    if (Number.isFinite(s) && s > 0) out.set(dim, s);
  }
  return out;
}

// Convenience: turn a feature dim into the BehaviourScore tag string
// ("feature:gaming", "feature:camera", ...). Used by the analyser so
// the tag vocabulary is consistent across all events.
export function phoneFeatureTag(dim) {
  if (typeof dim !== "string" || !dim) return null;
  return `feature:${dim}`;
}

export function phoneMetaFromRow(phone) {
  if (!phone || typeof phone !== "object") return null;
  const specs =
    phone.specs && typeof phone.specs === "object" ? phone.specs : {};
  const cameraText =
    typeof specs.mainCamera === "string" ? specs.mainCamera : "";
  const cameraMatch = cameraText.match(/(\d+(?:\.\d+)?)\s*MP/i);
  const mainCameraMp = cameraMatch ? Number(cameraMatch[1]) : null;
  return {
    modelName: phone.modelName || null,
    brandName: phone.brand?.name || null,
    chipset: specs.chipset || null,
    antutuScore:
      typeof phone.antutuScore === "number" ? phone.antutuScore : null,
    batteryMah: typeof phone.batteryMah === "number" ? phone.batteryMah : null,
    refreshRate:
      typeof specs.refreshRate === "number" ? specs.refreshRate : null,
    displaySize:
      typeof specs.displaySize === "number" ? specs.displaySize : null,
    mainCameraMp: Number.isFinite(mainCameraMp) ? mainCameraMp : null,
  };
}


// Convenience: build the `Map<tag, delta>` mapping for a phone's
// feature profile. Unlike `buildPhoneFeatureProfile`, this multiplies
// by the supplied feature weight and emits tags not dim names.
//
// `featureWeightFn` is a function `(dim) => number` so callers can
// pipe in `BEHAVIOR_CONFIG.featureWeight` (or a per-feature override
// for tests). The result is `Map<tag, delta>` with one entry per dim
// that has a positive score.
export function buildPhoneFeatureTagDeltas(meta, featureWeightFn) {
  const out = new Map();
  if (!meta) return out;
  const profile = buildPhoneFeatureProfile(meta);
  if (profile.size === 0) return out;

  for (const [dim, score] of profile.entries()) {
    const w =
      typeof featureWeightFn === "function" ? featureWeightFn(dim) : 1;
    const safeW = Number.isFinite(w) && w > 0 ? w : 0;
    const tag = phoneFeatureTag(dim);
    if (!tag || safeW === 0) continue;
    out.set(tag, score * safeW);
  }
  return out;
}
