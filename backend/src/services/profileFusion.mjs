// profileFusion — Step C. Request-time, in-memory fusion of explicit
// (Step A) + behaviour (Step B) preference signals into a single 4-dim
// weight map. The fused output is *not* persisted; it lives only as long
// as the recommend request that produced it.
//
// Shape contract:
//   in:  { explicit?: {gaming,camera,battery,display}, behavior?: same }
//   out: { gaming?, camera?, battery?, display? }   // each ∈ [1,5]
//
// The FastAPI /recommend endpoint already accepts `preferences: Dict[str,int]`
// with exactly those four keys (validated 1..5). So the fused output flows
// straight through `recommendService.mjs` → FastAPI without any Python
// changes.

import { prisma } from "../config/prisma.mjs";
import { getExplicitPreferences } from "./profileService.mjs";

// ---- Dim taxonomy -----------------------------------------------------------
//
// The 4-dim space mirrors what FastAPI's `_DIM_KEY_NORMALIZE` accepts.
// Anything outside this space is dropped at the fusion boundary — brand /
// tier affinity is a *phone-level* signal that belongs in Step D's
// re-ranker, not in the user-preference vector.

export const FUSION_DIMS = ["gaming", "camera", "battery", "display"];

// Map a Step B `BehaviorScore.tag` onto one of the 4 fusion dims.
// Behaviour tags produced by `behaviorAnalyzer` today are:
//   "feature:gaming" | "feature:camera" | "feature:battery"
//   "feature:performance" | "feature:display"
//   "brand:<X>" | "tier:<X>"
// Search-query events additionally emit:
//   "category:gaming" | "category:camera" | "category:battery"
//
// The `feature:*` tags are the dominant signal for view / compare /
// recommend events. Before these aliases existed they were silently
// dropped at the `if (!dim) continue` guard in `loadBehaviorScores`,
// so behaviour never reached the fused Custom weights. We now translate
// them onto the 4-dim fusion space. `feature:performance` has no
// dedicated fusion dim, so it folds into `gaming` — the same rationale
// the legacy `chipset → gaming` alias uses ("cares about raw
// performance").
//
// The brand:<X> / tier:<X> tags are still intentionally skipped here —
// brand / tier affinity is a phone-level signal that belongs in Step D's
// re-ranker (searchHistoryScore), not in the 4-dim preference vector.
const DIM_ALIASES = {
  // Canonical short tags (kept for backwards-compat with any legacy rows).
  gaming: "gaming",
  camera: "camera",
  battery: "battery",
  display: "display",
  chipset: "gaming", // a phone's chipset bump is the strongest "this user
                     //  cares about performance" signal we have
  category: "camera", // generic "category" tag → camera stand-in (mirrors
                      // behaviorAnalyzer.phoneMetaTags behaviour)
  // Feature-profile tags — the vocabulary the analyser actually writes.
  "feature:gaming": "gaming",
  "feature:camera": "camera",
  "feature:battery": "battery",
  "feature:performance": "gaming", // no fusion dim for perf → fold into gaming
  "feature:display": "display",
  // Search-query category tags.
  "category:gaming": "gaming",
  "category:camera": "camera",
  "category:battery": "battery",
};

// Persona → preset dim weights. Mirrors the FE's
// `PERSONA_WEIGHT_PRESETS` (Dashboard.jsx) byte-for-byte so the BE never
// returns a different ranking than the modal sliders suggested.
//
// `null` means "user has touched the sliders" — Step A's
// `recommendationPersona = "Custom"`. In that case the explicit layer
// must come from the FE-supplied `preferences` for this request, not
// from this table.
const PERSONA_WEIGHT_PRESETS = {
  gamer: { gaming: 5, camera: 2, battery: 4, display: 4 },
  camera: { gaming: 2, camera: 5, battery: 3, display: 3 },
  battery: { gaming: 2, camera: 2, battery: 5, display: 2 },
  allrounder: { gaming: 3, camera: 3, battery: 3, display: 3 },
  custom: null,
  // Personas the FE may send but whose preset isn't on the FE side. The
  // coarse fallback in `loadExplicitPriority` handles these via the
  // usageType / cameraPreference enum values from Step A.
  business: { gaming: 2, camera: 2, battery: 4, display: 4 },
};

// ---- Pure helpers ----------------------------------------------------------

// `final_weight[dim] = β · explicit[dim] + (1 − β) · behavior[dim]`
//
// `beta` defaults to 0.7 per the architecture doc — explicit dominates.
// Zero contributions are dropped so the fused output only contains dims
// where at least one source had a value.
export function fuseProfile(explicit, behavior, beta = 0.7) {
  const out = {};
  const dims = new Set([
    ...Object.keys(explicit || {}),
    ...Object.keys(behavior || {}),
  ]);
  for (const dim of dims) {
    const e = Number(explicit?.[dim] ?? 0);
    const b = Number(behavior?.[dim] ?? 0);
    if (!e && !b) continue;
    out[dim] = beta * e + (1 - beta) * b;
  }
  return out;
}

// Map a (possibly unbounded) raw score into the [1, 5] range FastAPI's
// `_preferences_in_range` validator requires. Behaviour scores typically
// sit in [0, 5] after a handful of events thanks to the 0.95 decay, but
// we clamp defensively in case a long history pushes a tag above 5.
//
// Rounding is to 2 decimals (a whole-number preference survives the
// round-trip; FastAPI is int-safe, but the validator requires int — we
// Math.round to whole numbers before sending so the request never 400s).
export function clampToStars(raw, { min = 1, max = 5 } = {}) {
  if (!Number.isFinite(raw)) return min;
  if (raw <= 0) return min;
  if (raw >= max) return max;
  // Round to integer so FastAPI's int validator never trips.
  return Math.round(raw);
}

// Convert a free-form `weights` dict into an integer-stars dim map.
// Anything not in the 4-dim space is dropped. Anything outside [1,5] is
// clamped. Used when the FE sends explicit `preferences` for a Custom
// persona — we honour the sliders verbatim and don't re-derive from
// Step A.
export function normalizeExplicit(input) {
  if (!input || typeof input !== "object") return null;
  const out = {};
  for (const dim of FUSION_DIMS) {
    const v = input[dim];
    if (Number.isFinite(v)) out[dim] = clampToStars(v);
  }
  return Object.keys(out).length ? out : null;
}

// ---- Read helpers (DB I/O is fine; the result is in-memory only) ------------

// Read Step A (`UserPreference` + `CustomerProfile`) and return the
// explicit-priority dim map, or null when nothing useful is stored.
//
// `customPersonaExplicit` is the explicit layer for "Custom" personas:
// when Step A says the persona is "Custom", the FE-supplied sliders are
// the truth, so we use those instead of guessing from `usageType` /
// `cameraPreference`.
export async function loadExplicitPriority(userId, customPersonaExplicit) {
  // "Custom" persona: explicit layer = whatever the FE sent in this
  // request. Skip the DB round-trip.
  if (customPersonaExplicit) {
    return normalizeExplicit(customPersonaExplicit);
  }

  const explicit = await getExplicitPreferences(userId);
  if (!explicit) return null;

  const persona = String(explicit.persona || "").toLowerCase();
  if (persona && Object.prototype.hasOwnProperty.call(PERSONA_WEIGHT_PRESETS, persona)) {
    const preset = PERSONA_WEIGHT_PRESETS[persona];
    if (preset) return { ...preset };
    // persona="custom" with no FE override → fall through to the coarse
    // enum-based fallback below.
  }

  // Coarse fallback for personas / personas-without-presets. Mirrors
  // the FE's `deriveCameraPreference` + the persona→usageType mapping
  // in profileService.mjs.
  const out = { gaming: 3, camera: 3, battery: 3, display: 3 };
  if (explicit.cameraPreference === "Camera_Lover") out.camera = 5;
  if (explicit.usageType === "Gaming") out.gaming = 5;
  if (explicit.usageType === "Business") {
    out.battery = 4;
    out.display = 4;
  }
  return out;
}

// Read Step B's `BehaviorScore` rows for the user and collapse them
// onto the 4-dim bucket via DIM_ALIASES.
//
// Strategy: SUM every tag that maps to the same dim, then clamp to
// [1,5]. A user who has searched "ROG" 5× ends up with
// `gaming: 4.81`; someone who has also viewed three Honor gaming
// phones pushes past 5.0 and saturates at 5 — exactly the "nudge,
// not a takeover" behaviour we want.
export async function loadBehaviorScores(userId) {
  if (!userId) return null;
  let rows;
  try {
    rows = await prisma.behaviorScore.findMany({
      where: { userId },
      select: { tag: true, score: true },
    });
  } catch (err) {
    // DB blip on the read side — fall back to "no behaviour data".
    console.warn(
      "[step-c] BehaviorScore read failed:",
      err?.message || err,
    );
    return null;
  }
  if (!rows.length) return null;

  const bucket = {};
  for (const { tag, score } of rows) {
    const dim = DIM_ALIASES[tag];
    if (!dim) continue; // brand:X / tier:X intentionally skipped
    const s = Number(score);
    if (!Number.isFinite(s)) continue;
    bucket[dim] = (bucket[dim] || 0) + s;
  }

  const out = {};
  for (const dim of FUSION_DIMS) {
    if (bucket[dim] !== undefined) {
      out[dim] = clampToStars(bucket[dim]);
    }
  }
  return Object.keys(out).length ? out : null;
}

// ---- Top-level orchestrator ------------------------------------------------

// Build the fused preference map for a given request. Always returns
// either:
//   - a `{ gaming?, camera?, battery?, display? }` map with each value ∈
//     [1, 5], suitable for FastAPI's `preferences` field, OR
//   - `null` when both sources are empty (caller should pass no
//     preferences to FastAPI and let the persona preset drive ranking).
//
// Failure isolation: any DB / logic error inside this function is
// logged and resolved to `null` so the recommend flow can still pass
// the request through.
export async function buildFusedWeights(
  userId,
  { preferencesFromRequest, beta = 0.7 } = {},
) {
  // Custom-persona fast path: explicit layer = the FE sliders for this
  // request. We still consult behaviour so a Custom persona still gets
  // the same-session nudge.
  const isCustom =
    typeof preferencesFromRequest === "object" &&
    preferencesFromRequest !== null &&
    Object.keys(preferencesFromRequest).length > 0;

  try {
    const [behavior, explicit] = await Promise.all([
      loadBehaviorScores(userId),
      loadExplicitPriority(
        userId,
        isCustom ? preferencesFromRequest : null,
      ),
    ]);

    if (!explicit && !behavior) return null;
    if (!behavior) return explicit;
    if (!explicit) {
      // Behaviour-only path (e.g. brand-new user who never filled the
      // questionnaire but has been clicking around). Each dim is the
      // behaviour score, already clamped.
      return { ...behavior };
    }

    const raw = fuseProfile(explicit, behavior, beta);
    const out = {};
    for (const dim of FUSION_DIMS) {
      if (raw[dim] !== undefined) out[dim] = clampToStars(raw[dim]);
    }
    return Object.keys(out).length ? out : null;
  } catch (err) {
    console.warn(
      "[step-c] buildFusedWeights failed; falling back to passthrough:",
      err?.message || err,
    );
    return null;
  }
}