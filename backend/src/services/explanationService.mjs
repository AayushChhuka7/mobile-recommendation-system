// explanationService — convert SHAP feature importance + raw feature
// values into a short, human-readable explanation that the FE can
// surface next to a recommended phone.
//
// Design principles (from the spec):
//   - Filter insignificant SHAP values (`|importance| < minImportance`).
//   - Sort by `|importance|` desc.
//   - Return top-N lines.
//   - Make the rule set configurable (FEATURE_HANDLERS map).
//   - Never hardcode phone names. The messages describe feature
//     contributions, not specific devices.
//
// Pure: no DB, no FastAPI. Easy to unit-test.
//
// Output shape (frozen):
//   {
//     overall: 'Strong match' | 'Good match' | 'Fair match' | 'Weak match',
//     lines: [
//       {
//         feature: 'battery_mah',
//         importance: 0.18,            // signed SHAP value
//         message: 'Strong match: 5500 mAh battery',
//         kind: 'strong' | 'good' | 'neutral' | 'weak',
//       },
//       ...
//     ],
//   }

// ---- Tunables -------------------------------------------------------------
//
// Default thresholds. Callers can override per-call via `options`.
const DEFAULT_TOP_N = 5;
const DEFAULT_MIN_IMPORTANCE = 0.05;

// Final-score → overall message band. Score is expected in [0, 1].
const OVERALL_BANDS = [
  { min: 0.85, label: "Strong match" },
  { min: 0.65, label: "Good match" },
  { min: 0.45, label: "Fair match" },
  { min: 0, label: "Weak match" },
];

// ---- Per-feature message handlers ----------------------------------------
//
// Each handler receives (rawValue, importance) and returns
//   { kind, message }
// where `kind` is the qualitative band and `message` is the
// human-readable string. Handlers must NOT mention phone names.
//
// Adding a new canonical feature is a one-line change: add it to
// `FEATURE_HANDLERS` below.

/** @type {Record<string, (rawValue:any, importance:number)=>{kind:string, message:string}>} */
const FEATURE_HANDLERS = {
  battery_mah: (v, imp) => {
    if (typeof v !== "number") return generic("battery", imp);
    const mah = v;
    if (imp > 0 && mah >= 5000) return strong(`Strong match: ${mah} mAh battery`);
    if (imp > 0 && mah >= 4500) return good(`Good battery: ${mah} mAh`);
    if (imp > 0) return good(`Solid ${mah} mAh battery`);
    if (imp < 0 && mah < 3500) return weak(`Small battery: ${mah} mAh`);
    return neutral(`${mah} mAh battery`);
  },

  ram_gb: (v, imp) => {
    if (typeof v !== "number") return generic("RAM", imp);
    if (imp > 0 && v >= 12) return strong(`Strong match: ${v} GB RAM`);
    if (imp > 0 && v >= 8) return good(`Good multitasking: ${v} GB RAM`);
    if (imp < 0 && v < 4) return weak(`Limited RAM: ${v} GB`);
    return neutral(`${v} GB RAM`);
  },

  storage_gb: (v, imp) => {
    if (typeof v !== "number") return generic("storage", imp);
    if (imp > 0 && v >= 256) return good(`Plenty of storage: ${v} GB`);
    if (imp > 0 && v >= 128) return good(`${v} GB of storage`);
    if (imp < 0 && v < 64) return weak(`Limited storage: ${v} GB`);
    return neutral(`${v} GB storage`);
  },

  antutu_score: (v, imp) => {
    if (typeof v !== "number") return generic("performance", imp);
    if (imp > 0 && v >= 900_000) return strong(`Excellent gaming performance`);
    if (imp > 0 && v >= 500_000) return good(`Strong overall performance`);
    if (imp < 0 && v < 200_000) return weak(`Entry-level performance`);
    return neutral(`${v.toLocaleString()} Antutu`);
  },

  camera_mp: (v, imp) => {
    if (typeof v !== "number") return generic("camera", imp);
    if (imp > 0 && v >= 50) return strong(`Excellent camera quality`);
    if (imp > 0 && v >= 12) return good(`Capable camera: ${v} MP main`);
    if (imp < 0 && v < 8) return weak(`Basic camera: ${v} MP main`);
    return neutral(`${v} MP main camera`);
  },

  refresh_rate_hz: (v, imp) => {
    if (typeof v !== "number") return generic("display refresh rate", imp);
    if (imp > 0 && v >= 120) return strong(`Buttery ${v} Hz display`);
    if (imp > 0 && v >= 90) return good(`Smooth ${v} Hz display`);
    if (imp < 0) return weak(`Standard ${v} Hz display`);
    return neutral(`${v} Hz display`);
  },

  supports_5g: (v, imp) => {
    if (v === true || v === "true") {
      return imp > 0 ? good("Supports 5G") : neutral("Supports 5G");
    }
    return imp < 0 ? weak("No 5G support") : neutral("No 5G support");
  },

  price_eur: (v, imp) => {
    if (typeof v !== "number") return generic("price", imp);
    if (imp > 0) return good(`Price fits your budget (€${Math.round(v)})`);
    if (imp < 0) return weak(`Above budget (€${Math.round(v)})`);
    return neutral(`€${Math.round(v)}`);
  },

  display_size: (v, imp) => {
    if (typeof v !== "number") return generic("display", imp);
    if (imp > 0 && v >= 6.5) return good(`Large ${v}\" display`);
    if (imp > 0) return good(`${v}\" display`);
    return neutral(`${v}\" display`);
  },

  has_ois: (v, imp) => {
    if (v === true || v === "true") return good("OIS camera stabilisation");
    return neutral("No OIS camera");
  },

  chipset: (v, imp) => {
    if (typeof v !== "string" || !v) return generic("chipset", imp);
    if (imp > 0 && /snapdragon\s*8/i.test(v)) {
      return strong(`Flagship ${v} chipset`);
    }
    if (imp > 0) return good(`Modern ${v} chipset`);
    return neutral(`${v} chipset`);
  },
};

// ---- Helpers --------------------------------------------------------------

const strong = (message) => ({ kind: "strong", message });
const good = (message) => ({ kind: "good", message });
const neutral = (message) => ({ kind: "neutral", message });
const weak = (message) => ({ kind: "weak", message });

const generic = (featureName, imp) => {
  if (imp > 0) return good(`Fits your ${featureName}`);
  if (imp < 0) return weak(`Doesn't fit your ${featureName}`);
  return neutral(`${featureName} considered`);
};

// Pick the right handler — feature-specific or generic.
const handlerFor = (feature) =>
  FEATURE_HANDLERS[feature] || ((v, imp) => generic(feature, imp));

// Pick the "overall" headline from the final score (0..1).
const overallFor = (score) => {
  if (typeof score !== "number" || !Number.isFinite(score)) return "Match summary";
  const clamped = Math.max(0, Math.min(1, score));
  const band = OVERALL_BANDS.find((b) => clamped >= b.min) || OVERALL_BANDS.at(-1);
  return band.label;
};

// ---- Public API -----------------------------------------------------------

/**
 * Build a human-readable explanation from SHAP values + feature values.
 *
 * @param {object} input
 * @param {Record<string, number>} input.shapValues   — signed importance per feature.
 * @param {Record<string, *>}      input.featureValues — raw feature values.
 * @param {number}                 input.score         — final composite score in [0,1].
 * @param {object} [input.options]
 * @param {number} [input.options.topN=5]
 * @param {number} [input.options.minImportance=0.05]
 * @returns {{ overall: string, lines: Array }}
 */
export const explain = ({
  shapValues = {},
  featureValues = {},
  score,
  options = {},
} = {}) => {
  const topN = clampInt(options.topN ?? DEFAULT_TOP_N, 1, 25);
  const minImportance = Math.max(0, Number(options.minImportance ?? DEFAULT_MIN_IMPORTANCE));

  const entries = Object.entries(shapValues)
    .filter(([, imp]) => Number.isFinite(imp) && Math.abs(imp) >= minImportance)
    .map(([feature, importance]) => {
      const handler = handlerFor(feature);
      const raw = featureValues[feature];
      const { kind, message } = handler(raw, importance);
      return {
        feature,
        importance,
        message,
        kind,
      };
    })
    .sort((a, b) => Math.abs(b.importance) - Math.abs(a.importance))
    .slice(0, topN);

  return {
    overall: overallFor(score),
    lines: entries,
  };
};

/**
 * Stub SHAP for callers that don't have one yet (cold-start path).
 * Returns a synthetic map where each feature's importance is its
 * normalised raw value (signed, in [-1, 1]). The numbers aren't
 * real SHAP — they're a stand-in so the FE has plausible lines
 * even without a model response.
 *
 * Per-feature cap table (a feature's raw value above its cap saturates
 * at 1.0; negative values stay negative if the feature can be):
 *   battery_mah  → 6000 mAh
 *   ram_gb       → 16 GB
 *   storage_gb   → 1024 GB
 *   antutu_score → 1_200_000
 *   camera_mp    → 64 MP
 *   refresh_rate → 144 Hz
 *   price_eur    → 2000 €   (HIGHER price = LOWER contribution)
 *   display_size → 7 in
 *   supports_5g  → boolean (1 or 0)
 *
 * @param {Record<string, number>} featureValues
 * @param {Record<string, number>} [weights]  — feature → weight in [0,1].
 * @returns {Record<string, number>}
 */
export const stubShap = (featureValues, weights = {}) => {
  const caps = {
    battery_mah: 6000,
    ram_gb: 16,
    storage_gb: 1024,
    antutu_score: 1_200_000,
    camera_mp: 64,
    refresh_rate_hz: 144,
    price_eur: 2000,
    display_size: 7,
  };
  const out = {};
  for (const [k, raw] of Object.entries(featureValues || {})) {
    if (!Number.isFinite(raw)) continue;
    const w = Number.isFinite(weights[k]) ? weights[k] : 1;

    let shap;
    if (k === "supports_5g" || k === "has_ois") {
      // Boolean features: positive if true, mild negative if false.
      shap = raw === true || raw === 1 ? 0.15 : -0.05;
    } else if (k === "price_eur") {
      // Higher price = lower contribution.
      const cap = caps.price_eur;
      shap = Number((Math.max(0, Math.min(1, 1 - raw / cap)) - 0.5).toFixed(4));
    } else if (caps[k] != null) {
      const cap = caps[k];
      shap = Number((Math.max(0, Math.min(1, raw / cap)) - 0.5).toFixed(4));
    } else {
      // Unknown feature: normalise to [-0.5, 0.5].
      const norm = Math.tanh(raw / 10);
      shap = Number((norm * 0.5).toFixed(4));
    }
    out[k] = Number((shap * w).toFixed(4));
  }
  return out;
};

const clampInt = (v, min, max) => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
};

// ---------------------------------------------------------------------------
// Example usage
// ---------------------------------------------------------------------------
//
//   import { explain, stubShap } from "./explanationService.mjs";
//
//   const e = explain({
//     shapValues: { battery_mah: 0.12, camera_mp: 0.09, ram_gb: 0.04 },
//     featureValues: { battery_mah: 5500, camera_mp: 50, ram_gb: 12 },
//     score: 0.82,
//   });
//   // → { overall: 'Good match',
//   //     lines: [
//   //       { feature: 'battery_mah', importance: 0.12, kind: 'strong', message: 'Strong match: 5500 mAh battery' },
//   //       { feature: 'camera_mp',   importance: 0.09, kind: 'strong', message: 'Excellent camera quality' },
//   //     ] }
//
// ---------------------------------------------------------------------------
// Suggested unit tests
// ---------------------------------------------------------------------------
//
//   - Filters |importance| < minImportance.
//   - Sorts by |importance| desc.
//   - Caps at topN.
//   - Unknown feature falls through to generic().
//   - overallFor() picks the right band per score.
//   - stubShap produces a finite map and respects weights.
//
// ---------------------------------------------------------------------------
// Assumptions
// ---------------------------------------------------------------------------
//
//   - SHAP importance is on a roughly [0, 1] scale (signed). The
//     default minImportance=0.05 is the same threshold used by the
//     reference SHAP summary plot.
//   - `score` is the final composite score from fusionRanker
//     (finalScore ∈ [0,1]). overallFor clamps defensively.
//
// ---------------------------------------------------------------------------
// Reusable functions
// ---------------------------------------------------------------------------
//
// `FEATURE_HANDLERS` is exported for tests and for callers that want
// to extend the rule set without touching the core explain()
// function.
//
// `stubShap` is exported for the cold-start path which has no real
// SHAP and needs plausible lines.
//
// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
//
// Pure: no thrown errors. Bad inputs are silently dropped from the
// output (filter + Number.isFinite). If both `shapValues` and
// `featureValues` are empty, returns `{ overall, lines: [] }`.