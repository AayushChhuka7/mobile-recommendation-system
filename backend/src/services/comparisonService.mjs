// comparisonService — side-by-side compare for 2-5 phones.
//
// Pipeline:
//   1. Load phones from Prisma (1 read, includes brand/specs/variants).
//   2. Per phone, compute the composite via
//      `candidateScoringService.getOrComputeComposite` so we don't
//      re-derive what the ranker already knows.
//   3. Per dim (the 5 fusion dims + the raw spec dims batteryMah,
//      camera MP, refreshRate, RAM, antutu, has5G, hasNfc, price),
//      pick a winner. Multiple ties share the win.
//   4. Per phone, attach a SHAP-style explanation via
//      `explanationService.explain`.
//   5. Compute overall winner by weighted sum of components. Compute
//      confidence from (winner - runnerUp) / winner.
//   6. Return FE-friendly JSON.
//
// Failure policy:
//   - DB errors → bubble up as shaped `internal`/`notFound`.
//   - SHAP/explanation errors → empty lines, never throw.
//
// Public API:
//   - comparePhones(phoneIds, userId)

import { prisma } from "../config/prisma.mjs";
import { comparePhones as fetchPhones } from "./phoneService.mjs";
import { getOrComputeComposite } from "./candidateScoringService.mjs";
import { loadBehaviorScoreMap } from "./profileService.mjs";
import { explain as explainWithShap } from "./explanationService.mjs";
import { FUSION_WEIGHTS } from "./fusionRanker.mjs";
import { badRequest, notFound } from "../utils/ApiError.mjs";

// ---- Constants -----------------------------------------------------------

const MIN_PHONES = 2;
const MAX_PHONES = 5;

// Per-dim comparison. The 5 fusion dims give the ranking reason;
// the raw spec dims give the FE something visual to highlight.
const COMPARE_DIMS = Object.freeze([
  { key: "battery_mah",  label: "Battery",           higherIsBetter: true,  unit: "mAh" },
  { key: "antutu_score", label: "Performance",       higherIsBetter: true,  unit: "" },
  { key: "ram_gb",       label: "RAM",               higherIsBetter: true,  unit: "GB" },
  { key: "storage_gb",   label: "Storage",           higherIsBetter: true,  unit: "GB" },
  { key: "camera_mp",    label: "Camera (main MP)",  higherIsBetter: true,  unit: "MP" },
  { key: "refresh_rate", label: "Refresh rate",      higherIsBetter: true,  unit: "Hz" },
  { key: "display_size", label: "Display size",      higherIsBetter: true,  unit: "in" },
  { key: "supports_5g",  label: "5G support",        higherIsBetter: true,  unit: "" },
  { key: "supports_nfc", label: "NFC",               higherIsBetter: true,  unit: "" },
  { key: "price_eur",    label: "Price (lowest)",    higherIsBetter: false, unit: "€" },
]);

// ---- Pure helpers --------------------------------------------------------

// Read the spec field for a phone in a defensive way. Variants are
// optional (some phones have none); specs may be missing fields.
const readSpec = (phone, key) => {
  const specs = phone.specs || {};
  const variant = phone.variants?.[0] || {};

  switch (key) {
    case "battery_mah":
      return typeof specs.batteryMah === "number" ? specs.batteryMah : null;
    case "antutu_score":
      return typeof phone.antutuScore === "number" ? phone.antutuScore : null;
    case "ram_gb":
      return typeof variant.ramGb === "number" ? variant.ramGb : null;
    case "storage_gb":
      return typeof variant.storageGb === "number" ? variant.storageGb : null;
    case "camera_mp":
      return parseCameraMp(specs.mainCamera);
    case "refresh_rate":
      return typeof specs.refreshRate === "number" ? specs.refreshRate : null;
    case "display_size":
      return specs.displaySize != null ? Number(specs.displaySize) : null;
    case "supports_5g":
      return specs.supports5g === true ? 1 : 0;
    case "supports_nfc":
      return specs.supportsNfc === true ? 1 : 0;
    case "price_eur":
      return variant.price != null ? Number(variant.price) : null;
    default:
      return null;
  }
};

// Parse "50MP + 12MP + 8MP" → max int. Returns null when unparseable.
const parseCameraMp = (raw) => {
  if (typeof raw !== "string") return null;
  const matches = raw.match(/\d+\s*MP/gi);
  if (!matches) return null;
  let max = 0;
  for (const m of matches) {
    const n = parseInt(m, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max > 0 ? max : null;
};

// Pick the phone ids that "win" a dim. Ties share the win (multiple
// winners per dim). `phones` is a list of { phoneId, value } records.
const winnersFor = (phones, higherIsBetter) => {
  const numeric = phones
    .map((p) => ({ phoneId: p.phoneId, value: p.value }))
    .filter((p) => Number.isFinite(p.value));
  if (numeric.length === 0) return [];
  let best = higherIsBetter ? -Infinity : Infinity;
  for (const p of numeric) {
    if (higherIsBetter ? p.value > best : p.value < best) best = p.value;
  }
  return numeric
    .filter((p) => p.value === best)
    .map((p) => p.phoneId);
};

// Compute overall winner by summing the per-phone fusion components
// weighted by FUSION_WEIGHTS. Returns { winnerId, scores: {id→score} }.
const computeOverallWinner = (entries) => {
  const scores = new Map();
  for (const e of entries) {
    const components = e.composite?.components || {};
    let total = 0;
    let weightSum = 0;
    for (const [dim, weight] of Object.entries(FUSION_WEIGHTS)) {
      const v = components[dim];
      if (Number.isFinite(v)) {
        total += v * weight;
        weightSum += weight;
      }
    }
    scores.set(e.phoneId, weightSum > 0 ? total / weightSum : 0);
  }
  if (scores.size === 0) return { winnerId: null, scores: {}, runnerUpScore: 0 };
  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  return {
    winnerId: sorted[0][0],
    scores: Object.fromEntries(scores),
    runnerUpScore: sorted[1]?.[1] ?? 0,
  };
};

// Confidence score in [0, 1]: (winner - runnerUp) / winner.
// Wider gap → higher confidence. Equal scores → 0.
const computeConfidence = (winnerScore, runnerUpScore) => {
  if (!Number.isFinite(winnerScore) || winnerScore <= 0) return 0;
  const gap = winnerScore - (Number.isFinite(runnerUpScore) ? runnerUpScore : 0);
  return Math.max(0, Math.min(1, gap / winnerScore));
};

// Build a per-phone featureValues map for explanationService.
const phoneToFeatureValues = (phone) => {
  const cheapest = phone.variants?.[0] || {};
  return {
    battery_mah: readSpec(phone, "battery_mah") || 0,
    ram_gb: readSpec(phone, "ram_gb") || 0,
    storage_gb: readSpec(phone, "storage_gb") || 0,
    antutu_score: readSpec(phone, "antutu_score") || 0,
    camera_mp: readSpec(phone, "camera_mp") || 0,
    refresh_rate_hz: readSpec(phone, "refresh_rate") || 0,
    supports_5g: readSpec(phone, "supports_5g") === 1,
    price_eur: readSpec(phone, "price_eur") || 0,
    display_size: readSpec(phone, "display_size") || 0,
    has_ois: phone.specs?.ois === true,
    chipset: phone.specs?.chipset || null,
  };
};

// Build a SHAP-like vector from the per-phone composite components.
// Same convention as recommendationService — illustrative until
// FastAPI ships SHAP.
const phoneToShap = (composite) => {
  const c = composite?.components || {};
  const out = {
    gaming: c.customer_preference ?? 0,
    camera: c.content_similarity ?? 0,
    battery: c.value ?? 0,
    display: c.compatibility ?? 0,
    search_history: c.search_history ?? 0,
  };
  for (const k of Object.keys(out)) {
    out[k] = Number(((out[k] || 0) - 0.5).toFixed(4));
  }
  return out;
};

// ---- Public API ----------------------------------------------------------

/**
 * Compare 2-5 phones side-by-side.
 *
 * @param {string[]} phoneIds
 * @param {string|null} [userId]
 * @returns {Promise<{ phones, dimensions, winnerId, confidence, generatedAt }>}
 */
export const comparePhones = async (phoneIds, userId = null) => {
  if (!Array.isArray(phoneIds) || phoneIds.length < MIN_PHONES) {
    throw badRequest(`At least ${MIN_PHONES} phones are required for comparison`);
  }
  if (phoneIds.length > MAX_PHONES) {
    throw badRequest(`At most ${MAX_PHONES} phones can be compared at once`);
  }
  // Dedupe defensively so the per-dim logic doesn't see duplicates.
  const uniqueIds = [...new Set(phoneIds)];
  if (uniqueIds.length < MIN_PHONES) {
    throw badRequest(`At least ${MIN_PHONES} distinct phones are required`);
  }

  // 1. Load phones (uses phoneService for the canonical include).
  const phones = await fetchPhones(uniqueIds);
  if (phones.length !== uniqueIds.length) {
    throw notFound("One or more phones not found");
  }

  // 2. Composite scores per phone. Cache hit when the same
  // (phoneId, behaviorScores, weights) combo is requested again.
  const behaviorScores = userId ? await loadBehaviorScoreMap(userId) : null;
  const composites = await getOrComputeComposite(
    uniqueIds,
    behaviorScores,
    { modelVersion: "v1" },
  );

  // 3. Per-dim winners + per-phone values.
  const perDim = {};
  for (const dim of COMPARE_DIMS) {
    const entries = phones.map((p) => ({
      phoneId: p.phoneId,
      value: readSpec(p, dim.key),
    }));
    perDim[dim.key] = {
      label: dim.label,
      unit: dim.unit,
      higherIsBetter: dim.higherIsBetter,
      winners: winnersFor(entries, dim.higherIsBetter),
      values: Object.fromEntries(entries.map((e) => [e.phoneId, e.value])),
    };
  }

  // 4. Overall winner + confidence.
  const entriesWithComposite = phones.map((p) => ({
    phoneId: p.phoneId,
    composite: composites.get(p.phoneId) || null,
  }));
  const { winnerId, scores, runnerUpScore } = computeOverallWinner(entriesWithComposite);
  const confidence = computeConfidence(scores[winnerId], runnerUpScore);

  // 5. Per-phone FE-facing shape + explanation.
  const formattedPhones = phones.map((p) => {
    const composite = composites.get(p.phoneId) || null;
    const featureValues = phoneToFeatureValues(p);
    const shapValues = phoneToShap(composite);
    const score = scores[p.phoneId] ?? composite?.score ?? null;

    let explanation = { overall: "Match summary", lines: [] };
    try {
      explanation = explainWithShap({
        shapValues,
        featureValues,
        score: score ?? 0.5,
        options: { topN: 3, minImportance: 0.04 },
      });
    } catch (err) {
      if (process.env.NODE_ENV === "production") {
        console.warn("[compare] explain failed:", err?.message || err);
      } else {
        console.error("[compare] explain failed:", err);
      }
    }

    return {
      phoneId: p.phoneId,
      modelName: p.modelName,
      imageUrl: p.imageUrl,
      antutuScore: p.antutuScore,
      brand: p.brand
        ? {
            id: p.brand.brandId,
            name: p.brand.name,
            logoUrl: p.brand.logoUrl,
          }
        : null,
      keySpecs: p.specs
        ? {
            os: p.specs.os || null,
            display: p.specs.displaySize ? Number(p.specs.displaySize) : null,
            refreshRate: p.specs.refreshRate || null,
            camera: p.specs.mainCamera || null,
            battery: p.specs.batteryMah || null,
            has5G: p.specs.supports5g === true,
            hasNfc: p.specs.supportsNfc === true,
            ois: p.specs.ois === true,
            chipset: p.specs.chipset || null,
          }
        : null,
      cheapestVariant: p.variants?.[0]
        ? {
            ram: p.variants[0].ramGb,
            storage: p.variants[0].storageGb,
            price: p.variants[0].price,
            storageType: p.variants[0].storageType,
          }
        : null,
      scores: {
        composite: score,
        match: score != null ? score * 100 : null,
        components: composite?.components || null,
      },
      explanation,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    phones: formattedPhones,
    dimensions: perDim,
    winnerId,
    confidence: Number(confidence.toFixed(4)),
    overallScores: scores,
  };
};

// ---------------------------------------------------------------------------
// Example usage
// ---------------------------------------------------------------------------
//
//   import { comparePhones } from "./comparisonService.mjs";
//
//   const result = await comparePhones([idA, idB, idC], userId);
//   // result.dimensions.battery_mah.winners → [phoneIdA]
//   // result.winnerId → phoneIdA
//   // result.confidence → 0.34
//   // result.phones[0].explanation.lines → [...]
//
// ---------------------------------------------------------------------------
// Suggested unit tests
// ---------------------------------------------------------------------------
//
//   - Reject < 2 phones, > 5 phones.
//   - Dedupe identical ids (must keep ≥ 2 distinct).
//   - winnersFor ties return all tied ids.
//   - computeConfidence returns 0 when scores are equal.
//   - SHAP vector is signed (subtracted baseline).
//
// ---------------------------------------------------------------------------
// Assumptions
// ---------------------------------------------------------------------------
//
//   - The lower-level `phoneService.comparePhones` is the canonical
//     phone loader for compare (it already handles 5-phone limit + DB
//     shape). If we ever change `phoneService.comparePhones`, update
//     the input-validation here accordingly.
//   - The cache hit-rate for compare is high because users often
//     re-compare the same phones in the same session. The composite
//     pre-compute keeps p99 latency low.
//
// ---------------------------------------------------------------------------
// Reusable functions
// ---------------------------------------------------------------------------
//
//   - `comparePhones` consumes `candidateScoringService` so any
//     future scoring change automatically flows into the comparison.
//   - `explainWithShap` is reused — no duplicated SHAP→text logic.
//
// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
//
//   - < 2 or > 5 phones → badRequest.
//   - Unknown phoneId → notFound (via `phoneService.comparePhones`).
//   - Per-phone explanation failures → empty lines, never throw.
//   - Prisma blips on the composite hydrate → empty composite, the
//     per-dim comparison still works (it uses raw spec fields).