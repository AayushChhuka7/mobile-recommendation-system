// profileFusion — Step C.
//
// In-memory, no-DB-write fusion of two signals for a single recommendation
// request:
//
//   explicit_priority   — what the user told the onboarding form
//                         (loaded by profileService.loadRecommendationInput)
//   behavior_score      — what the user's last N interactions imply
//                         (loaded by eventService.loadBehaviorScores)
//
// Output is `final_active_profile`: a 9-dimension weight map
// (Gaming, Camera, Battery, Display, Software, Storage, Connectivity,
// Security, Portability) that the FastAPI `/recommend` endpoint can
// consume directly via `custom_weights_stars`.
//
// Why a separate file (vs. putting `fuseProfile` inside behaviorAnalyzer):
//   - behaviorAnalyzer is the *write* path (events → scores).
//   - profileFusion is the *read* path (scores → final weights).
//   - profileFusion has nothing to do with Prisma and nothing to do
//     with tag derivation, so it doesn't belong in either.
//   - Step F (Profile Evolution) will reuse the same β-weighted math,
//     so keeping the rule in one tiny pure file pays off twice.
//
// Pure functions only — no Prisma, no fetch, no global state.

// ---- β parameter ----
//
// `β` controls how strongly the user's in-app behaviour overrides
// their declared persona. Default `0.7` says "trust the form answer,
// but let up to 30% of the final weight be reshaped by signals from
// recent searches / views / clicks."
//
//   final[dim] = β * explicit[dim] + (1 − β) * behavior[dim]
//
//   β = 1.0  → explicit-only (no behaviour nudge; pure rule-based)
//   β = 0.0  → behaviour-only (explicit is ignored)
//   β = 0.7  → default; explicit dominates, behaviour nudges
//
// Tweak β per request if you ever want a "boost behaviour" debug
// toggle — but don't persist the change. Step F already has its own
// evolution logic for long-term shifts.

export const DEFAULT_BETA = 0.7;

// ---- Dimension universe ----
//
// The 9 dimensions the FastAPI ranker understands. PascalCase is the
// canonical form — see ML Model/pipeline/recommend.py::SCORE_DIMENSIONS
// and pipeline/serve.py::_DIM_KEY_NORMALIZE. The FE slider shape
// (lowercase, partial) is *not* what this layer speaks; we translate
// below before returning.

const SCORE_DIMENSIONS = Object.freeze([
  "Gaming",
  "Camera",
  "Battery",
  "Display",
  "Software",
  "Storage",
  "Connectivity",
  "Security",
  "Portability",
]);

export { SCORE_DIMENSIONS };

// ---- Explicit-priority shape ----
//
// What the user told us. Source: Step A's UserPreference sliders
// (lowercase keys) plus their persona-derived 9-dim preset (PascalCase
// keys). The caller normalises whichever shape it has into
// `explicit9` (a `Map<dimName, 0..1>`) before calling `fuse`.
//
// Helpers in this file (`personaToExplicit`, `slidersToExplicit`)
// take whatever shape the FE / DB sends and emit the normalised
// 9-dim map.

// ---- Behavior-score shape ----
//
// What Step B's analyzer emits. Shape:
//   { "brand:Samsung": 4.2, "category:gaming": 7.1,
//     "chipset:snapdragon-flagship": 1.8, ... }
//
// We have no per-ML-dim score — we have per-tag scores. A mapping
// rule translates tags into one-or-more ML dimensions. The mapping
// is *additive*: a single tag can contribute to multiple dims (e.g.
// `category:gaming` lights up Gaming, Performance-adjacent Display,
// and a touch of Portability).

// ---- Tag → ML-dim mapping ----
//
// Each entry is `[dim, weight]`. The weights within a single tag sum
// to 1.0 — so `category:gaming` raising Gaming by Δ distributes its
// influence cleanly across the dims it touches.
//
// Dim names match SCORE_DIMENSIONS exactly. Tag names match the
// `<dimension>:<value>` format emitted by behaviorAnalyzer.

const TAG_TO_DIMS = Object.freeze({
  // category:* — strongest direct signal (mirrors the persona traits
  // the FE exposes as sliders).
  "category:gaming": [
    ["Gaming", 1.0],
  ],
  "category:camera": [
    ["Camera", 1.0],
  ],
  "category:battery": [
    ["Battery", 1.0],
  ],
  "category:display": [
    ["Display", 1.0],
  ],

  // chipset:* — second-strongest. Flagship-class snapdragon/dimensity
  // chips lift Gaming + Performance-adjacent Display.
  "chipset:snapdragon-flagship": [
    ["Gaming", 0.7],
    ["Display", 0.3],
  ],
  "chipset:snapdragon-upper-mid": [
    ["Gaming", 0.5],
    ["Display", 0.3],
    ["Software", 0.2],
  ],
  "chipset:snapdragon": [
    ["Software", 0.5],
    ["Connectivity", 0.3],
    ["Gaming", 0.2],
  ],
  "chipset:dimensity-flagship": [
    ["Gaming", 0.7],
    ["Display", 0.3],
  ],
  "chipset:dimensity-upper-mid": [
    ["Gaming", 0.5],
    ["Display", 0.3],
  ],
  "chipset:dimensity": [
    ["Software", 0.4],
    ["Gaming", 0.3],
    ["Connectivity", 0.3],
  ],
  "chipset:apple-silicon": [
    ["Software", 0.5],
    ["Security", 0.3],
    ["Gaming", 0.2],
  ],
  "chipset:exynos-flagship": [
    ["Gaming", 0.6],
    ["Software", 0.4],
  ],
  "chipset:exynos": [
    ["Software", 0.5],
    ["Connectivity", 0.3],
    ["Gaming", 0.2],
  ],
  "chipset:google-tensor": [
    ["Software", 0.6],
    ["Camera", 0.4],
  ],
  "chipset:kirin": [
    ["Software", 0.4],
    ["Gaming", 0.3],
    ["Connectivity", 0.3],
  ],

  // tier:* — moderate. Flagship tier hints at the upper end of most
  // dims without committing to any one. Budget tier hints at Battery
  // (the priority for cheap phones).
  "tier:flagship": [
    ["Gaming", 0.25],
    ["Display", 0.25],
    ["Software", 0.2],
    ["Camera", 0.15],
    ["Connectivity", 0.15],
  ],
  "tier:premium": [
    ["Display", 0.3],
    ["Software", 0.25],
    ["Gaming", 0.2],
    ["Camera", 0.15],
    ["Battery", 0.1],
  ],
  "tier:mid": [
    ["Battery", 0.3],
    ["Storage", 0.25],
    ["Software", 0.2],
    ["Portability", 0.15],
    ["Connectivity", 0.1],
  ],
  "tier:budget": [
    ["Battery", 0.4],
    ["Storage", 0.25],
    ["Portability", 0.2],
    ["Software", 0.15],
  ],

  // brand:* — small but persistent. A repeated interest in "Samsung"
  // shifts nothing dramatic; it just nudges multiple dims slightly.
  "brand:Samsung": [
    ["Display", 0.3],
    ["Software", 0.25],
    ["Security", 0.2],
    ["Connectivity", 0.15],
    ["Camera", 0.1],
  ],
  "brand:Apple": [
    ["Software", 0.4],
    ["Security", 0.3],
    ["Camera", 0.2],
    ["Connectivity", 0.1],
  ],
  "brand:Google": [
    ["Software", 0.5],
    ["Camera", 0.3],
    ["Security", 0.2],
  ],
  "brand:OnePlus": [
    ["Gaming", 0.3],
    ["Software", 0.25],
    ["Display", 0.25],
    ["Connectivity", 0.2],
  ],
  "brand:Xiaomi": [
    ["Battery", 0.3],
    ["Camera", 0.3],
    ["Display", 0.2],
    ["Portability", 0.2],
  ],
  "brand:ASUS": [
    ["Gaming", 0.6],
    ["Display", 0.3],
    ["Battery", 0.1],
  ],
  "brand:ROG": [
    ["Gaming", 0.7],
    ["Display", 0.3],
  ],

  // query:* — small, generic. A repeated search query ("rog") lights
  // up the gaming-adjacent dims without strong category commitment.
  "query:rog": [["Gaming", 0.7], ["Display", 0.3]],
  "query:iphone": [
    ["Software", 0.4],
    ["Security", 0.3],
    ["Camera", 0.3],
  ],
  "query:pixel": [
    ["Software", 0.4],
    ["Camera", 0.4],
    ["Security", 0.2],
  ],
});

// ---- Mapping helpers ----

/**
 * Convert a single tag (e.g. "category:gaming") to the ML dimensions
 * it influences. Returns the empty list for tags we don't recognise —
 * unknown brands, exotic chipsets, ad-hoc search terms all fall into
 * this bucket and contribute nothing to the behaviour score.
 *
 * @param {string} tag
 * @returns {Array<[string, number]>}
 */
export const tagToDims = (tag) => {
  const mapped = TAG_TO_DIMS[tag];
  if (!mapped) return [];
  // Defensive copy so callers can't mutate the frozen table.
  return mapped.map(([d, w]) => [d, w]);
};

/**
 * Project a full behavior score map (Step B output shape) onto the
 * 9-dim behaviour weight vector.
 *
 * The result is `Map<dimName, score>` where score is unbounded —
 * callers that need a [0, 1] or [0, 5] range should pass through
 * `dimStars` (below) for the final mapping.
 *
 * @param {Record<string, number>} behaviorMap
 * @returns {Object<string, number>}
 */
export const behaviorToDims = (behaviorMap) => {
  const out = Object.create(null);
  if (!behaviorMap || typeof behaviorMap !== "object") return out;

  for (const [tag, score] of Object.entries(behaviorMap)) {
    const projections = tagToDims(tag);
    if (projections.length === 0) continue;
    // Negative behaviour scores (e.g. dismiss events) should not
    // *reward* a dim — but they can penalise it. We pass them
    // through; the per-dim cap in `dimStars` keeps the final number
    // sane.
    if (!Number.isFinite(score) || score === 0) continue;

    for (const [dim, weight] of projections) {
      out[dim] = (out[dim] ?? 0) + score * weight;
    }
  }
  return out;
};

// ---- Explicit-priority helpers ----
//
// The FE persona maps to the same 9-dim weights the ranker already
// uses. We re-declare the persona presets here (instead of importing
// from the FastAPI side) so this file stays self-contained — the
// Express side already keeps a redundant surface for `persona` keys.
//
// Values match ML Model/pipeline/recommend.py::PERSONA_PRESETS
// exactly. Update both files in lock-step.

const PERSONA_PRESETS = Object.freeze({
  Gamer: {
    Gaming: 1.0, Camera: 0.3, Battery: 0.7,
    Display: 0.8, Software: 0.3, Storage: 0.5,
    Connectivity: 0.4, Security: 0.2, Portability: 0.2,
  },
  Camera_Lover: {
    Gaming: 0.3, Camera: 1.0, Battery: 0.5,
    Display: 0.6, Software: 0.4, Storage: 0.6,
    Connectivity: 0.3, Security: 0.2, Portability: 0.4,
  },
  Battery_Focused: {
    Gaming: 0.4, Camera: 0.4, Battery: 1.0,
    Display: 0.4, Software: 0.3, Storage: 0.3,
    Connectivity: 0.3, Security: 0.2, Portability: 0.5,
  },
  All_Rounder: {
    Gaming: 0.6, Camera: 0.6, Battery: 0.6,
    Display: 0.6, Software: 0.5, Storage: 0.5,
    Connectivity: 0.5, Security: 0.4, Portability: 0.4,
  },
  Business_User: {
    Gaming: 0.2, Camera: 0.4, Battery: 0.8,
    Display: 0.5, Software: 0.9, Storage: 0.5,
    Connectivity: 0.7, Security: 0.9, Portability: 0.6,
  },
  Custom: {
    // Conservative default for unknown / Custom personas.
    Gaming: 0.5, Camera: 0.5, Battery: 0.5,
    Display: 0.5, Software: 0.5, Storage: 0.5,
    Connectivity: 0.5, Security: 0.5, Portability: 0.5,
  },
});

/**
 * Resolve an FE-friendly `persona` key to the 9-dim explicit
 * priority vector. Unknown personas fall back to All_Rounder.
 *
 * Accepts both FE keys ("gamer", "camera", "battery", "allrounder",
 * "business", "custom") and the Python enum values
 * ("Gamer", "Camera_Lover", ...).
 *
 * @param {string|null|undefined} persona
 * @returns {Object<string, number>}
 */
export const personaToExplicit = (persona) => {
  const key = normalisePersonaKey(persona);
  const preset = PERSONA_PRESETS[key] ?? PERSONA_PRESETS.All_Rounder;
  return { ...preset };
};

/**
 * Convert the FE's slider shape ({gaming, camera, battery, display})
 * — each value 1..5 — into the 9-dim `custom_weights_stars` shape
 * the ranker already accepts. Missing slider keys default to 3
 * (neutral: "I don't care about this dim"). Non-slider dims are
 * left at 3 too — the FE has no opinion about them.
 *
 * @param {Record<string, number>|null|undefined} sliders
 * @returns {Object<string, number>} 9-dim map, each value in [1, 5]
 */
export const slidersToExplicit = (sliders) => {
  const out = Object.create(null);
  for (const dim of SCORE_DIMENSIONS) out[dim] = 3;

  if (!sliders || typeof sliders !== "object") return out;

  for (const [rawKey, rawVal] of Object.entries(sliders)) {
    const dim = rawKeyToDim(rawKey);
    if (!dim) continue;
    const n = Number(rawVal);
    if (!Number.isFinite(n)) continue;
    out[dim] = Math.max(1, Math.min(5, Math.round(n)));
  }
  return out;
};

/**
 * Build the explicit-priority vector from the raw stored profile.
 * `sliders` (1..5) take precedence over the persona preset when
 * both are supplied — that's the on-by-default UX expectation
 * ("I picked Gamer but I also tweaked my camera slider").
 *
 * @param {string|null} persona
 * @param {Record<string, number>|null} sliders
 * @returns {Object<string, number>}
 */
export const buildExplicit = (persona, sliders) => {
  const fromPersona = personaToExplicit(persona);
  const fromSliders = slidersToExplicit(sliders);

  // Sliders operate on a different scale (1..5 vs 0..1), so we
  // can't just average. Convert slider stars → 0..1 weights
  // (stars / 5) and blend them onto the persona preset using a
  // fixed weight: 70% sliders, 30% persona. This keeps the
  // persona's broad shape while letting sliders make targeted
  // changes.
  const blended = Object.create(null);
  const SLIDER_BLEND = 0.7;
  for (const dim of SCORE_DIMENSIONS) {
    const personaWeight = fromPersona[dim] ?? 0.5;
    const sliderWeight = (fromSliders[dim] ?? 3) / 5.0;
    blended[dim] = SLIDER_BLEND * sliderWeight + (1 - SLIDER_BLEND) * personaWeight;
  }
  return blended;
};

// ---- Core fusion ----

/**
 * Fuse explicit + behaviour into a 9-dim final weight vector in
 * [0, 1]. This is the heart of Step C — pure, no I/O, idempotent.
 *
 * Algorithm per dimension:
 *
 *   final[dim] = β * explicit[dim] + (1 − β) * normalised_behavior[dim]
 *
 * We normalise `behaviour` separately per-call so a brand with a
 * huge absolute score (100 cumulative saves) doesn't dominate a
 * dim with a tiny one. The normaliser is max-abs within the call —
 * min-max would lose the sign of the dislike signal.
 *
 * @param {Record<string, number>|null|undefined} explicit   9-dim [0,1]
 * @param {Record<string, number>|null|undefined} behavior   tag→score map
 * @param {number} [beta=DEFAULT_BETA]
 * @returns {Object<string, number>} 9-dim [0, 1]
 */
export const fuse = (explicit, behavior, beta = DEFAULT_BETA) => {
  const out = Object.create(null);
  const behaviorDims = behaviorToDims(behavior);

  // Find the max-abs behaviour value so we can rescale the
  // behaviour vector into roughly [−1, 1]. We need at least one
  // non-zero behaviour dim to call this fusion — when the user has
  // no live behaviour signal at all, behaviourScore is empty and
  // `behaviorDims` is empty too. The "fuse → behaviour absent"
  // branch is the new-user case in the README verification
  // ("fusion output ≈ explicit_priority"). We must NOT treat the
  // absence as "neutral 0.5"; we must let explicit_priority speak.
  const behaviorEntries = Object.values(behaviorDims);
  let behaviorScale = 0;
  for (const v of behaviorEntries) {
    if (Math.abs(v) > behaviorScale) behaviorScale = Math.abs(v);
  }

  if (behaviorScale === 0) {
    // No live behaviour — pure explicit priority. This is the
    // path a brand-new user takes.
    for (const dim of SCORE_DIMENSIONS) {
      out[dim] = clamp01(explicit?.[dim] ?? 0.5);
    }
    return out;
  }

  for (const dim of SCORE_DIMENSIONS) {
    const e = clamp01(explicit?.[dim] ?? 0.5);
    // Map [-1, 1] → [0, 1] so a strong dislike shifts the
    // explicit priority *down*, not below zero.
    const b = (clampSymmetric(behaviorDims[dim] ?? 0) / behaviorScale + 1) / 2;
    const w = beta * e + (1 - beta) * b;
    out[dim] = clamp01(w);
  }
  return out;
};

/**
 * Translate the fused [0, 1] weights into the [1, 5] stars the
 * FastAPI ranker accepts as `custom_weights_stars`. Round-half-to-even
 * so two fused weights at 0.5 don't drift to 2.499 then 3.51.
 *
 * The result is what gets POSTed to /api/recommend/recommend.
 *
 * @param {Object<string, number>} fused   9-dim [0, 1]
 * @returns {Object<string, number>} 9-dim [1, 5]
 */
export const dimStars = (fused) => {
  const out = Object.create(null);
  for (const dim of SCORE_DIMENSIONS) {
    const w = Number(fused?.[dim] ?? 0.5);
    const clamped = clamp01(w);
    const stars = clampStars(1 + clamped * 4); // 0 → 1, 1 → 5
    out[dim] = Math.round(stars);
  }
  return out;
};

// ============================================================================
// Public convenience: one-call fusion used by recommendService.
// ============================================================================
//
// `fuseProfileForRequest` is the entry point the rest of the app
// should call. It takes:
//   - the stored persona (string or null)
//   - the stored slider prefs (1..5 dict, optional)
//   - the live behaviour score map (from Step B)
//
// and emits an object the FastAPI layer accepts *as-is* via
// `custom_weights_stars`. The orchestrator (recommendService) then
// just spreads it into the body.
//
// Steps A and B don't need to know about this file — they produce
// inputs in their own natural shapes. This is where the seam lives.
//
// Returns { customWeights: {dim: stars}, fused: {dim: [0,1]}, beta }
// so callers that want to display "we used 70% explicit / 30%
// behaviour" can; the orchestrator only needs `customWeights`.

export const fuseProfileForRequest = (
  persona,
  sliders,
  behaviorMap,
  { beta = DEFAULT_BETA } = {},
) => {
  const explicit = buildExplicit(persona, sliders);
  const fused = fuse(explicit, behaviorMap, beta);
  const customWeights = dimStars(fused);

  // Stats the recommendService can return to the FE for debugging.
  const stats = {
    beta,
    explicitNonZero: countAbove(explicit, 0.01),
    behaviorTagsUsed: countAbove(behaviorMap, 0.01),
  };

  return { customWeights, fused, stats };
};

// ============================================================================
// Internals
// ============================================================================

const clamp01 = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
};

const clampSymmetric = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < -1) return -1;
  if (n > 1) return 1;
  return n;
};

const clampStars = (v) => {
  if (v < 1) return 1;
  if (v > 5) return 5;
  return v;
};

const countAbove = (obj, threshold) => {
  if (!obj || typeof obj !== "object") return 0;
  let n = 0;
  for (const v of Object.values(obj)) {
    if (Number.isFinite(v) && Math.abs(v) > threshold) n += 1;
  }
  return n;
};

// FE persona keys → Python PersonaType values. Mirrors
// ML Model/pipeline/serve.py::PERSONA_ALIASES.
const FE_TO_PERSONA = Object.freeze({
  gamer: "Gamer",
  camera: "Camera_Lover",
  battery: "Battery_Focused",
  allrounder: "All_Rounder",
  business: "Business_User",
  custom: "Custom",
});

const normalisePersonaKey = (raw) => {
  if (typeof raw !== "string") return "All_Rounder";
  const key = raw.trim();
  // FE-shaped.
  if (FE_TO_PERSONA[key.toLowerCase()]) {
    return FE_TO_PERSONA[key.toLowerCase()];
  }
  // Already PascalCase / space-separated? Accept as-is.
  if (PERSONA_PRESETS[key]) return key;
  return "All_Rounder";
};

// FE slider lowercase → ML dim PascalCase. Same vocabulary as the
// validator's _DIM_KEY_NORMALIZE in serve.py.
const rawKeyToDim = (raw) => {
  if (typeof raw !== "string") return null;
  switch (raw.toLowerCase()) {
    case "gaming":       return "Gaming";
    case "camera":       return "Camera";
    case "battery":      return "Battery";
    case "display":      return "Display";
    case "software":     return "Software";
    case "storage":      return "Storage";
    case "connectivity": return "Connectivity";
    case "security":     return "Security";
    case "portability":  return "Portability";
    default:             return null;
  }
};