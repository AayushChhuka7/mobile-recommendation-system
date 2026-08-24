import { ML_BASE_URL } from "../config/ml.mjs";
import { badRequest, internal } from "../utils/ApiError.mjs";
import { prisma } from "../config/prisma.mjs";
import { buildFusedWeights } from "./profileFusion.mjs";
import { fusionRank, personalizedRank } from "./fusionRanker.mjs";
import { fetchContentSimilarity } from "./similarityClient.mjs";
import { phoneToTags } from "./searchHistoryScore.mjs";
import { buildShortTermInterest } from "./shortTermInterest.mjs";
import { resolvePhoneIds, enrichPhonesById } from "./enrichmentClient.mjs";
import { loadStockAndTrend, applyStockPenalty } from "./stockSignal.mjs";
import { mmrRerank } from "./mmrReranker.mjs";
import { applyExploration } from "./exploration.mjs";
import {
  getProfileBundle,
  loadBehaviorScoreMap,
  getRecentEvents,
  loadPhoneMetaMap,
  loadUserLikedAndViewed,
  safeRecordRecommendationLog,
} from "./profileService.mjs";
import { AUTO_MULTI_RETRIEVER_ENABLED } from "../config/autoRetrieval.mjs";
import {
  bucketUserForRollout,
  orchestrate as orchestrateMultiRetriever,
  LEGACY_VERSION,
} from "./autoMultiRetriever.mjs";
import { isColdStart } from "./coldStartService.mjs";
import {
  getCfRecommendations,
  checkCfHealth,
  safeRecordCfLog,
  safeUpsertCustomerCluster,
} from "./cfRecommendationService.mjs";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// CSV-backed image lookup
//
// The Python ML ranker and CF service both surface phones that the local
// `phones` table doesn't have a row for — the catalog grid below renders
// their real `imageUrl` because that endpoint filters down to DB rows,
// but the auto-rec cards end up with `imageUrl: null` and the FE falls
// through to the generic `backup.png` placeholder.
//
// To avoid that, we read the GSMArena CSV snapshot once at module load
// and index it by `(brand, modelName)` → `Model_Image` URL. When the rec
// service builds a row that's not in the DB, it looks up the CSV image
// by brand+model and attaches it as `imageUrl`. The CSV's `Model_Image`
// is the same GSMArena CDN URL the importer used to seed the DB's
// `phones.image_url` column, so the rec card image is consistent with
// the catalog grid for in-DB phones.
//
// We use a lazy loader with try/catch so a missing CSV (fresh checkout,
// CI) just leaves `imageUrl: null` — same behaviour as before, no crash.
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CSV_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "dataset",
  "GSMArena_Cleaned_Dataset.csv",
);

let csvImageIndex = null;
const loadCsvImageIndex = () => {
  if (csvImageIndex !== null) return csvImageIndex;
  csvImageIndex = new Map();
  if (!existsSync(CSV_PATH)) return csvImageIndex;
  try {
    const raw = readFileSync(CSV_PATH, "utf-8");
    // Minimal CSV split — the rows we need (Brand, Model_Name,
    // Model_Image, Model_URL) don't contain embedded commas in this
    // dataset because GSMArena model names never do. A full csv-parse
    // round-trip would also work, but the header-locating first-row
    // scan is enough for the ~10k rows and avoids an import.
    const lines = raw.split(/\r?\n/);
    const header = lines[0].split(",");
    const brandIdx = header.indexOf("Brand");
    const modelIdx = header.indexOf("Model_Name");
    const imageIdx = header.indexOf("Model_Image");
    const urlIdx = header.indexOf("Model_URL");
    if (brandIdx === -1 || modelIdx === -1 || imageIdx === -1) {
      return csvImageIndex;
    }
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      const brand = (cols[brandIdx] || "").trim();
      const model = (cols[modelIdx] || "").trim();
      const image = (cols[imageIdx] || "").trim();
      const url = urlIdx >= 0 ? (cols[urlIdx] || "").trim() : "";
      if (!brand || !model || !image) continue;
      // Each entry holds both the image and the GSMArena detail page.
      // Out-of-DB recs use the URL as a click-through target when
      // there's no `phones.id` to navigate to.
      csvImageIndex.set(`${brand}::${model}`, { image, url });
    }
  } catch (err) {
    console.warn(
      "[recommendService] CSV image index failed to load:",
      err?.message || err,
    );
    csvImageIndex = new Map();
  }
  return csvImageIndex;
};

const csvEntryFor = (brand, modelName) => {
  if (!brand || !modelName) return null;
  const idx = loadCsvImageIndex();
  return idx.get(`${brand}::${modelName}`) || null;
};

const csvImageFor = (brand, modelName) =>
  csvEntryFor(brand, modelName)?.image || null;

const csvUrlFor = (brand, modelName) =>
  csvEntryFor(brand, modelName)?.url || null;


// Auto-recommend pulls FULL_LIST_TOP_N candidates back from the
// Python ranker (default 200). With ~8.4k catalog rows × 9 per-dim
// scores, a cold-cache topN=200 call regularly exceeds 8s on the
// ML side — the prior default made every dashboard mount fail
// with "ML service timed out". Bumped to 30s so the eager call
// reliably returns, while the auto path keeps the cache-hot
// per-call latency below ~10s. The lazy /recommend/slice path
// also reuses this same timeout (it asks for topN=200 again by
// default in `getRecommendationsSlice`).
const TIMEOUT_MS = 30000;

// Eager slice shipped in the first response (#8 — pagination).
// Lazy expansion fetches the next LAZY_BATCH on FE scroll.
const EAGER_TOP_N = 60;
const LAZY_BATCH = 30;

// MMR rerank window. Only the top-50 of the 200 candidates is
// re-ordered by diversity. The remaining 150 keep their relevance
// order so the long tail is still relevance-dominant.
const MMR_TOP_K = 50;
const MMR_LAMBDA = 0.78;

// Exploration pass (#6) is also gated by relevance in the top-50.
// Outside that window the slot injection would land on a phone the
// user is unlikely to ever see.
const EXPLORATION_TOP_K = 50;

// Soft-constraint candidate floor. If the BE forwards min_candidates
// to the Python side, the ranker widens constraints to keep at
// least this many candidates in the pool (#2). Matches the Python
// default in `recommend.py::MIN_CANDIDATES`.
const MIN_CANDIDATES = 10;

// De-duplicate a recommendation list by a stable identity key.
//
// The ML ranker already de-dupes by `[Brand, Model_Name]` before
// returning (see `ML Model/pipeline/recommend.py::recommend` lines
// 156–159), and the BE's enrichment step does a best-effort
// `findFirst` per ML item. In practice the same DB row can still be
// returned under multiple ML items when model/brand names share a
// substring (the BE enrichment uses Prisma `contains`, not `equals`),
// and the FE renders one card per result entry. That produced visible
// duplicates in the "Recommend Me a Phone" output.
//
// This helper enforces the API contract: the served recommendation
// list never contains duplicate phones. Ranking is preserved by
// `first-occurrence wins` — both pipelines sort by score desc before
// calling this, so the kept row is always the highest-ranked one for
// that identity. For entries that didn't match a DB row (`id` is
// null), we fall back to the `[brand, modelName]` pair so an
// unmatched phone is still only shown once.
const dedupeByStableId = (list) => {
  if (!Array.isArray(list) || list.length === 0) return list;
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = item && item.id
      ? String(item.id)
      : `${item?.brand?.name || ""}::${item?.modelName || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
};

// ---------------------------------------------------------------------------
// CF (collaborative-filtering) hybrid merge.
//
// The new CF service runs in parallel with the existing
// rule-based → content-based pipeline (the FastAPI at port 8002). When
// the CF service returns ≥1 result we union it into the candidate set
// WITHOUT removing anything the ML pipeline already produced:
//
//   1. Each CF result is enriched into the same DB shape as the ML
//      result (same Prisma findFirst, same `formatRecommendation`).
//   2. Rows that already exist in the ML candidate list (matched by
//      `[brand, modelName]`) are kept as-is — the ML enrichment is
//      strictly richer than the CF envelope (Full_Score, Overall_Score,
//      Value_Score, Match_Score, Why, tags, contentSim, etc.). We
//      only attach a `cfReasons: string[]` field to those rows so the
//      FE can show a "people like you also liked" badge.
//   3. Rows that are CF-only (no ML match) are appended at the end
//      with `cfSource: true` and `cfReasons: [reason]` so the FE knows
//      where they came from. Their matchScore is derived from the CF
//      score (0..1) scaled to 0..100 so the percentage UI keeps
//      working unchanged.
//
// All fallbacks are silent:
//   - CF service unreachable / timeout → empty `{results, ...}` envelope,
//     no exception, no impact on the served list.
//   - CF returns results but the user has no CF counterpart (real
//     registration, no `@import.local` email) → empty envelope, no
//     impact.
//   - CF row can't be matched to a DB phone → still surfaced in the
//     list with `inDatabase: false`, `id: null`, model_name + brand
//     only (dedupeByStableId falls back to the [brand, modelName] key
//     for those rows).
// ---------------------------------------------------------------------------
const CF_CANDIDATE_TOP_N = 10;

const cfKey = (brand, modelName) =>
  `${String(brand || "").trim().toLowerCase()}::${String(modelName || "").trim().toLowerCase()}`;

// Build a CF-only enriched candidate. Mirrors the ML enrichment above
// but without the sub-scores, tags, or contentSim that the CF service
// doesn't produce. Stays "fat" enough that the existing FE card
// renderer doesn't have to special-case anything.
//
// `contentSim` is set to the CF score so the two-stage pipeline's
// `sort by contentSim desc` can still rank this row against the
// rule-based candidates — otherwise the CF-only row falls to the
// bottom and is sliced out of the top-5.
const buildCfCandidate = (cfItem) => {
  const modelName = String(cfItem?.model_name || "").trim();
  const brandName = String(cfItem?.model_name || "").includes(" ")
    ? String(cfItem.model_name).split(" ")[0]
    : "";
  // The CF service emits `model_name` as the full label
  // (e.g. "Samsung Galaxy A55"). We split off the brand as the first
  // token; if the DB findFirst fails the fallback below still works
  // because `formatRecommendation` tolerates missing brand.
  const inferredBrand = brandName;
  const score = Number.isFinite(cfItem?.score) ? Number(cfItem.score) : 0;
  const reason = typeof cfItem?.reason === "string" ? cfItem.reason : "";
  return {
    id: null,
    modelName,
    brand: { name: inferredBrand },
    // Same CSV-image fallback as `formatRecommendation` so the CF path
    // shows the right photo when the row isn't in the DB.
    imageUrl: csvImageFor(inferredBrand, modelName),
    // GSMArena URL — FE opens this in a new tab when the row isn't
    // navigable to an in-app detail page.
    sourceUrl: csvUrlFor(inferredBrand, modelName),
    keySpecs: null,
    cheapestVariant: null,
    matchScore: score * 100,
    why: [],
    inDatabase: false,
    cfSource: true,
    cfReasons: reason ? [reason] : [],
    contentSim: score,
    matchScoreFastApi: score * 100,
  };
};

// Lightweight DB enrichment for a single CF candidate. Mirrors the
// fields fetched by the ML enrichment above but lazy — only fields the
// FE actually renders need to be populated. Crashes on the DB read are
// swallowed so a transient DB error on a CF row can never break the
// recommendation response.
const enrichCfCandidate = async (cfItem) => {
  const modelName = String(cfItem?.model_name || "").trim();
  const score = Number.isFinite(cfItem?.score) ? Number(cfItem.score) : 0;
  const reason = typeof cfItem?.reason === "string" ? cfItem.reason : "";

  if (!modelName) return null;

  try {
    const phone = await prisma.phones.findFirst({
      where: {
        modelName: { contains: modelName, mode: "insensitive" },
        isActive: true,
      },
      include: {
        brand: { select: { brandId: true, name: true, logoUrl: true } },
        specs: {
          select: {
            os: true,
            chipset: true,
            displaySize: true,
            displayType: true,
            refreshRate: true,
            mainCamera: true,
            batteryMah: true,
            supports5g: true,
            supportsNfc: true,
          },
        },
        variants: {
          where: { isAvailable: true },
          orderBy: { price: "asc" },
          select: {
            variantId: true,
            ramGb: true,
            storageGb: true,
            price: true,
            storageType: true,
          },
        },
      },
    });

    if (!phone) {
      // CF row not in the DB — surface the model_name + brand so the
      // FE can still render a card (price-less, no image). Shows up
      // in the audit log as `inDatabase: false`.
      return {
        ...buildCfCandidate(cfItem),
        brand: {
          name: String(cfItem?.model_name || "").split(" ")[0] || "",
        },
      };
    }

    const cheapestVariant = phone.variants?.[0];
    return {
      id: phone.phoneId,
      modelName: phone.modelName,
      imageUrl: phone.imageUrl,
      antutuScore: phone.antutuScore,
      brand: phone.brand,
      keySpecs: {
        os: phone.specs?.os || null,
        display: phone.specs?.displaySize || null,
        refreshRate: phone.specs?.refreshRate || null,
        camera: phone.specs?.mainCamera || null,
        battery: phone.specs?.batteryMah || null,
        has5G: phone.specs?.supports5g || false,
        hasNfc: phone.specs?.supportsNfc || false,
      },
      cheapestVariant: cheapestVariant
        ? {
            ram: cheapestVariant.ramGb,
            storage: cheapestVariant.storageGb,
            price: cheapestVariant.price,
            storageType: cheapestVariant.storageType,
          }
        : null,
      // matchScore is left undefined for CF rows that matched the DB
      // — the ML pipeline has already assigned a richer score, and
      // merging it would clobber the ranker output. The FE can show
      // the CF reason as a "people like you also liked" badge via
      // `cfReasons`.
      matchScore: undefined,
      why: [],
      inDatabase: true,
      cfSource: true,
      cfReasons: reason ? [reason] : [],
      // Synthetic contentSim derived from the CF score so the
      // two-stage pipeline (which sorts by contentSim desc) can rank
      // CF-only rows fairly. The CF score is in [0,1] and content
      // similarity is also in [0,1], so a direct assignment is
      // apples-to-apples. Without this, CF-only rows would always
      // sort to the bottom of the two-stage top-5 because their
      // contentSim is missing (defaulted to 0 by the sorter).
      contentSim: Number.isFinite(score) ? score : 0,
      // Same idea for the tie-breaker — FastAPI Match_Score is the
      // implicit tie-breaker when two rows have equal contentSim.
      // Mirror the CF score into matchScoreFastApi so a high-CF
      // pick still wins over a low-ML pick on tie.
      matchScoreFastApi: Number.isFinite(score) ? score * 100 : 0,
    };
  } catch (err) {
    console.warn("[cf] db enrichment failed for", modelName, err?.message || err);
    return null;
  }
};

// Merge CF candidates into the existing ML-enriched list. See the
// block comment above for the full contract. Returns the merged list
// (deduped by `[brand, modelName]`, ML rows win on conflict) plus
// the raw CF envelope so the caller can decide whether to log it.
const mergeCfCandidates = async (mlEnriched, cfPayload) => {
  const cfResults = Array.isArray(cfPayload?.results) ? cfPayload.results : [];
  if (cfResults.length === 0) {
    return { merged: mlEnriched, mergedAny: false };
  }

  // Pre-compute the ML keys once so the dedupe is O(N+M) not O(N*M).
  const mlKeys = new Set();
  for (const c of mlEnriched || []) {
    if (!c) continue;
    mlKeys.add(cfKey(c.brand?.name, c.modelName));
  }

  // Enrich every CF row that isn't already in the ML list.
  const enrichedCf = await Promise.all(
    cfResults.map(async (cfItem) => {
      const k = cfKey(
        String(cfItem?.model_name || "").split(" ")[0],
        cfItem?.model_name,
      );
      if (mlKeys.has(k)) {
        // Same phone already in the ML list — skip the DB read and
        // attach the CF reason instead. The caller will sweep the
        // merged list and write `cfReasons` onto the existing ML row.
        return { existingKey: k, reason: cfItem?.reason || "" };
      }
      const enriched = await enrichCfCandidate(cfItem);
      return enriched ? { candidate: enriched } : null;
    }),
  );

  const cfOnlyCandidates = [];
  const cfReasonsByKey = new Map();
  for (const entry of enrichedCf) {
    if (!entry) continue;
    if (entry.candidate) {
      cfOnlyCandidates.push(entry.candidate);
    } else if (entry.existingKey && entry.reason) {
      const list = cfReasonsByKey.get(entry.existingKey) || [];
      list.push(entry.reason);
      cfReasonsByKey.set(entry.existingKey, list);
    }
  }

  // Attach CF reasons to the surviving ML rows. Mutates the existing
  // list (in-place) so the FE renders the badge without a re-render.
  for (const c of mlEnriched || []) {
    if (!c) continue;
    const k = cfKey(c.brand?.name, c.modelName);
    const reasons = cfReasonsByKey.get(k);
    if (reasons && reasons.length > 0) {
      c.cfReasons = reasons;
    }
  }

  const merged = [...(mlEnriched || []), ...cfOnlyCandidates];
  return { merged, mergedAny: cfOnlyCandidates.length > 0 || cfReasonsByKey.size > 0 };
};

// Fire-and-forget CF analytics. Persists the served CF list into
// `cf_recommendation_logs` and the lazy `CustomerCluster` row. Never
// awaited, never throws.
const recordCfArtifacts = (userId, cfPayload) => {
  if (!userId) return;
  if (!cfPayload || !Array.isArray(cfPayload.results) || cfPayload.results.length === 0) return;

  safeRecordCfLog(userId, {
    cfCustomerId: cfPayload.customerId || null,
    coldStart: Boolean(cfPayload.coldStart),
    results: cfPayload.results,
  });

  if (cfPayload.cluster && cfPayload.cluster.id != null) {
    safeUpsertCustomerCluster(userId, {
      cfCustomerId: cfPayload.customerId || null,
      clusterId: cfPayload.cluster.id,
      clusterName: cfPayload.cluster.name || `Cluster ${cfPayload.cluster.id}`,
    });
  }
};

// Issue 1 fix — default topN is now large enough to surface the full
// ranked catalog in the recs panel instead of a top-6 picks list.
// The ranker still returns phones in `Match_Score` desc order; widening
// the slice just exposes more of the same ordering.
const FULL_LIST_TOP_N = 200;

// Cap the per-call impression log at this many rows. The ranker can
// serve up to FULL_LIST_TOP_N candidates; logging every one would
// spam `recommendation_logs` for marginal analytics value (the top-N
// are the ones the user actually sees and interacts with).
const REC_LOG_WRITE_CAP = 50;

// Two-stage "Recommend Me a Phone" pipeline tunables.
//
// STAGE1_TOP_N — size of the reduced candidate domain returned by the
// rule-based stage. The rule-based stage (FastAPI /recommend) applies
// all the user's hard filters (budget, brand, RAM, 5G, persona weights)
// and returns the top-N matches. The content-based stage then re-ranks
// ONLY this set, not the full catalog, so we want it large enough that
// the top-5 by content similarity are high quality but small enough to
// keep the similarity call cheap.
const STAGE1_TOP_N = 200;

// STAGE2_FINAL_TOP_N — phones returned to the FE for the click flow.
// Hard requirement: exactly 5.
const STAGE2_FINAL_TOP_N = 5;

// Coerce any value into a clean one-line human message for error
// envelopes. Avoids the "[object Object]" trap when FastAPI replies
// with a 422 carrying a `detail: [{msg, loc, type}, ...]` array
// (or any other non-string payload).
const describeError = (value) => {
  if (value == null) return "ML service error";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    // FastAPI / pydantic validation error shape: [{msg, loc, type}, ...]
    const parts = value
      .map((entry) => {
        if (!entry) return null;
        if (typeof entry === "string") return entry;
        const where = Array.isArray(entry.loc) ? entry.loc.join(".") : null;
        const msg = typeof entry.msg === "string" ? entry.msg : null;
        return [where, msg].filter(Boolean).join(": ") || null;
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join("; ") : JSON.stringify(value);
  }
  if (typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    if (typeof value.detail === "string") return value.detail;
    if (typeof value.error === "string") return value.error;
    try {
      return JSON.stringify(value);
    } catch {
      return "ML service error";
    }
  }
  return String(value);
};

// Pull a clean error message out of a caught value, falling back
// through err.cause → err.message → a generic string. Avoids the
// template-literal `[object Object]` smell when upstream errors are
// non-stringified.
const safeErrorMessage = (err) => {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  const fromMessage = describeError(err.message);
  if (fromMessage !== "ML service error") return fromMessage;
  if (err.cause) {
    const fromCause = describeError(err.cause?.message ?? err.cause);
    if (fromCause) return fromCause;
  }
  return err.name || "unknown error";
};

const mlFetch = async (path, options = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${ML_BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      // Build a single readable message from whatever FastAPI sent.
      // Common shapes: {message: "..."}, {detail: "..."},
      // {detail: [{msg, loc, type}, ...]} (422 validation),
      // {error: "..."}.
      const msg = describeError(data?.message ?? data?.detail ?? data?.error);
      throw badRequest(msg);
    }

    return data;
  } catch (err) {
    // Re-throw already-shaped ApiError factories unchanged. NOTE: the
    // factory errors expose `err.status`, not `err.statusCode` — fix
    // a pre-existing bug where the wrong property was being checked
    // and shaped errors were being re-wrapped as "unreachable".
    if (err && err.status) throw err;
    if (err && err.name === "AbortError") throw internal("ML service timed out");
    throw internal(`ML service unreachable (${safeErrorMessage(err)})`);
  } finally {
    clearTimeout(timer);
  }
};

export const checkHealth = async () => {
  // Probe the existing rule-based ML service (port 8002) AND the new
  // CF service (port 9001) in parallel. The dashboard's admin health
  // panel surfaces both. Either can fail independently — failures
  // surface as `status: "unhealthy" / "unreachable"` but never throw,
  // so the route can still answer with the partial state.
  const [mlHealth, cfHealth] = await Promise.all([
    mlFetch("/health").catch((err) => ({
      status: "unhealthy",
      error: safeErrorMessage(err),
    })),
    checkCfHealth().catch((err) => ({
      status: "unreachable",
      error: safeErrorMessage(err),
    })),
  ]);

  return {
    ml: mlHealth,
    cf: cfHealth,
  };
};

export const getRecommendations = async (body, userId, opts = {}) => {
  const { persona, budget, preferences, brandFilter, topN } = body || {};
  // `source` is forwarded by the controller to flag the call origin.
  // The auto-recommendation flow passes "auto" so the impression log
  // is tagged with `source: "auto"` (Fix #1) — it is NOT suppressed
  // anymore; the trainer (#3) filters on `isTrainingEligible` to
  // avoid pollution.
  // `requestId` is the FE's per-mount UUID. It's required for the
  // impression upsert key (userId, phoneId, source, requestId).
  const source = opts && typeof opts.source === "string" ? opts.source : "click";
  const requestId = opts && typeof opts.requestId === "string" ? opts.requestId : null;
  // `softPrice` is an internal-call flag, NOT a user-facing body
  // field. When true, the Python scorer treats `budget.max` as a
  // soft penalty instead of a hard drop (auto-recommend path).
  // Default false preserves the click-flow hard ceiling. Set by
  // `getAutoRecommendations`; the controller never sets it.
  const softPrice = !!(opts && opts.softPrice);

  // Brand include/exclude from the "Find your phone" modal. The FE
  // sends `{ mode: "include" | "exclude", list: string[] }`; we map it
  // to the ranker's `preferred_brands` / `exclude_brands` slots. Both
  // slots are HARD drops on the Python side (see
  // `ML Model/pipeline/recommend.py::_hard_filter_drops` steps 6 + 7)
  // — non-matching brands are removed from the candidate pool
  // outright, never ranked-and-penalised. When the user has not
  // picked anything (or sent an invalid shape) we emit `undefined`
  // so the field is dropped by JSON.stringify — that keeps the ranker
  // on its unfiltered default path.
  const brandList = Array.isArray(brandFilter?.list) ? brandFilter.list : null;
  const preferredBrands =
    brandList && brandList.length > 0 && brandFilter.mode === "include"
      ? brandList
      : undefined;
  const excludeBrands =
    brandList && brandList.length > 0 && brandFilter.mode === "exclude"
      ? brandList
      : undefined;

  // Two-stage pipeline trigger: the "Recommend Me a Phone" click flow
  // passes topN=5 to switch off the 5-signal fusionRank and onto the
  // rule-based → content-based → top-5 pipeline. Any other topN keeps
  // the legacy full-fusion behaviour (auto-recommend, future callers).
  if (topN === STAGE2_FINAL_TOP_N) {
    return getRecommendationsTwoStage(body, userId, { source, requestId });
  }

  if (!persona) throw badRequest("persona is required");
  if (!budget || typeof budget.max !== "number")
    throw badRequest("budget.max is required");

  // ---- Step C: Profile Fusion ---------------------------------------------
  let fusedPreferences = null;
  if (userId) {
    fusedPreferences = await buildFusedWeights(userId, {
      preferencesFromRequest: preferences,
    });
  }

  const effectivePersona = fusedPreferences ? "Custom" : persona;

  // 1. Get ML results — and CF candidates in parallel (CF NEVER
  //    blocks the response; failures degrade to empty results).
  //    Fix #2 — soft constraints + progressive relaxation live in
  //    Python. `minCandidates` matches the Python `MIN_CANDIDATES`
  //    default. `softPrice` is forwarded ONLY when
  //    `opts.softPrice === true` (auto-recommend path). Click path
  //    leaves it false (the Pydantic schema default) so the user's
  //    budget.max stays a hard ceiling.
  const [data, cfPayload] = await Promise.all([
    mlFetch("/recommend", {
      method: "POST",
      body: JSON.stringify({
        persona: effectivePersona,
        budget: { min: budget.min || 0, max: budget.max },
        preferences: fusedPreferences || preferences || {},
        preferred_brands: preferredBrands,
        exclude_brands: excludeBrands,
        softPrice,
        topN: topN || FULL_LIST_TOP_N,
        minCandidates: MIN_CANDIDATES,
      }),
    }),
    userId
      ? getCfRecommendations(userId, CF_CANDIDATE_TOP_N).catch((err) => {
          console.warn("[cf] promise rejected unexpectedly:", err?.message || err);
          return { results: [], coldStart: true, customerId: null, cluster: null, error: "rejected" };
        })
      : Promise.resolve({ results: [], coldStart: true, customerId: null, cluster: null, error: null }),
  ]);

  const mlResults = data.results || [];

  if (mlResults.length === 0) return [];

  // ---- Fix #7 — batched enrichment ---------------------------------------
  // 2a. Resolve (brand, model) → phoneId in ONE findMany (was N=200).
  const idMap = await resolvePhoneIds(
    mlResults.map((m) => ({ brand: m.Brand, modelName: m.Model })),
  );
  const phoneIds = Array.from(new Set(idMap.values()));
  // 2b. Pull full enrichment in ONE findMany (was N=200).
  const phoneById = await enrichPhonesById(phoneIds);

  // 2c. Stock / trend / freshness (Fix #9) — one extra findMany.
  const stockMap = await loadStockAndTrend(phoneIds);

  // 2d. Re-attach everything to the ML list in original order.
  let enriched = mlResults.map((item) => {
    const key = `${(item.Brand || "").toLowerCase()}::${(item.Model || "").toLowerCase()}`;
    const phoneId = idMap.get(key) || null;
    const phone = phoneId ? phoneById.get(phoneId) : null;
    const stock = phoneId ? stockMap.get(phoneId) : null;

    const base = formatRecommendation(item, phone);
    return {
      ...base,
      overallScore: Number.isFinite(item.Overall_Score) ? Number(item.Overall_Score) : null,
      matchScoreFastApi: Number.isFinite(item.Match_Score) ? Number(item.Match_Score) : null,
      valueScore: Number.isFinite(item.Value_Score) ? Number(item.Value_Score) : null,
      // Fix #9 — wire the freshness + trending sub-scores into the
      // ranker via the candidate object. Defaulted to 0.5 (neutral)
      // when stock/trend metadata is missing.
      trendScore: stock?.trendScore ?? 0,
      freshness:  stock?.freshness ?? 0.5,
      stockState: stock?.stockState ?? "in_stock",
      stockPenalty: stock?.stockPenalty ?? 1.0,
      tags: phoneToTags(phone || {}),
    };
  });

  // 2e. Fix #9 pre-fusion stock gate. Out-of-stock phones are
  //     dropped from the auto response (the user did not ask for
  //     them). Low-stock phones pass through and are penalised at
  //     rank time. The legacy behaviour (no gate) is preserved for
  //     the explicit "click" flow, where the user actively asked.
  if (source === "auto") {
    const before = enriched.length;
    const dropped = [];
    enriched = enriched.filter((c) => {
      const gate = (c.stockState || "in_stock") === "out_of_stock" ? false : true;
      if (!gate) dropped.push(`${c.brand?.name || "?"} ${c.modelName || "?"} (stockState=${c.stockState})`);
      return gate;
    });
    // One-shot diagnostic — surfaces phones the auto gate silently
    // dropped so the ops team can audit "why doesn't this phone show
    // up in my top-N?" without re-running the pipeline. Gated to
    // non-production so there is zero cost in prod.
    if (process.env.NODE_ENV !== "production" && dropped.length > 0) {
      console.warn(
        `[auto-recommend] stock gate dropped ${dropped.length}/${before}: ${dropped.slice(0, 10).join(" | ")}${dropped.length > 10 ? " | …" : ""}`,
      );
    }
    if (enriched.length === 0) return [];
  }

  // ---- Fix #4 — content similarity against USER history -----------------
  // The user history is the union of: browsed phones + compared
  // phones. Empty history = cold start = fall back to the legacy
  // "centroid of candidates" score, which the FastAPI side also
  // reports as `similarityToCatalog` so the BE can blend.
  //
  // Disabled for the auto path: the user no longer wants content
  // similarity to influence the auto ranking. We keep the read pipeline
  // (loadUserLikedAndViewed / fetchContentSimilarity) intact so the
  // `getRecommendationsTwoStage` path can keep using it unchanged — set
  // the guard to `true` to re-enable.
  const USE_CONTENT_SIMILARITY_FOR_AUTO = false;
  let seedPhones = [];
  let simRows = [];
  if (USE_CONTENT_SIMILARITY_FOR_AUTO && userId) {
    seedPhones = await loadUserLikedAndViewed(userId, { limit: 25 });
    simRows = await fetchContentSimilarity(
      enriched.map((c) => ({
        brand: c.brand?.name || null,
        modelName: c.modelName,
      })),
      seedPhones.map((s) => ({ brand: s.brandName, modelName: s.phoneLabel })),
    );
    // Cold-start blend: when the user has < 3 history phones, mix in
    // the catalog score so the long tail doesn't collapse.
    const seedWeight = seedPhones.length >= 3
      ? 1.0
      : Math.max(0.4, seedPhones.length / 3);
    for (const c of enriched) {
      const key = `${c.brand?.name || ""}::${c.modelName}`;
      const row = simRows.find((r) => `${r.brand}::${r.modelName}` === key);
      const simSeed  = row && Number.isFinite(row.similarityToSeed)    ? row.similarityToSeed    : 0;
      const simCat   = row && Number.isFinite(row.similarityToCatalog) ? row.similarityToCatalog : 0;
      c.contentSim = (seedWeight * simSeed) + ((1 - seedWeight) * simCat);
    }
  }

  // Step D — behaviour score map for the search_history sub-score.
  const behaviorScoresMap = userId
    ? await loadBehaviorScoreMap(userId)
    : null;

  // Step E — short-term interest vector.
  let interestVec = new Map();
  let candidateMetaMap = new Map();
  if (userId) {
    const recentEvents = await getRecentEvents(userId);
    if (Array.isArray(recentEvents) && recentEvents.length > 0) {
      const interactedIds = recentEvents.map((e) => e.phoneId).filter(Boolean);
      const candidateIds = enriched.map((c) => c.id).filter(Boolean);
      candidateMetaMap = await loadPhoneMetaMap([
        ...interactedIds,
        ...candidateIds,
      ]);
      interestVec = buildShortTermInterest(recentEvents, candidateMetaMap);
    }
  }

  // Step E — personalized fusion. The stock multiplier is a function
  // so each candidate can have its own penalty (low_stock → 0.85,
  // in_stock → 1.0). Cold users (no stockMultiplier) keep the
  // legacy path.
  const stockMultiplier = (c) =>
    Number.isFinite(c.stockPenalty) ? c.stockPenalty : 1.0;
  const ranked = personalizedRank(
    enriched,
    behaviorScoresMap,
    interestVec,
    candidateMetaMap,
  );


  // Re-shape for the FE. The existing `matchScore` (0..100) is
  // overwritten with the fused score so the "% match" UI keeps working
  // unchanged. `matchComponents` is opt-in for the FE (used by the
  // "Boosted by your activity" badge).
  const finalRanked = ranked.map((c) => ({
    ...c,
    matchScore: c.finalScore * 100,
    matchComponents: c.components,
  }));

  // Enforce the "no duplicate phones" contract on the API response.
  // See `dedupeByStableId` for rationale. Ranking order is preserved
  // because `fusionRank` returns phones in `finalScore` desc order —
  // the first occurrence is always the highest-ranked row for each
  // identity.
  const finalRankedUnique = dedupeByStableId(finalRanked);

  // ---- Fix #1 — fire-and-forget impression log ---------------------------
  // No longer suppressed on `source === "auto"`. The trainer filters
  // on `is_training_eligible` (set true by the FE's
  // `POST /impressions` when dwell >= 1.5s && !skipped). requestId
  // is the FE's per-mount UUID; pass null when the FE didn't supply
  // one (defensive — should never happen in production).
  if (userId && Array.isArray(finalRankedUnique) && finalRankedUnique.length > 0) {
    const topLogged = finalRankedUnique.slice(0, REC_LOG_WRITE_CAP);
    void safeRecordRecommendationLog(
      userId,
      topLogged.map((c, i) => ({
        rank: i + 1,
        phoneId: c.id,
        finalScore: c.matchScore,
        source,
        requestId,
        explorationArm: c.explorationArm || null,
        firstSeenAt: new Date(),
      })),
    );
  }

  // ---- Fix #8 — pagination-aware payload ---------------------------------
  // Ship the first EAGER_TOP_N fully enriched, plus a thin "lazy"
  // descriptor list for the rest. The FE uses `lazy[]` to request
  // expansion as the user scrolls. We never re-serve the same phone
  // twice; the FE is expected to render positions [0..eager-1] in
  // order and append lazy[0], lazy[1], ... as the user scrolls.
  const eagerSlice = finalRankedUnique.slice(0, EAGER_TOP_N);
  const lazyQueue  = finalRankedUnique.slice(EAGER_TOP_N);
  const response = {
    results: eagerSlice,
    lazy: lazyQueue.map((c, i) => ({
      offset: EAGER_TOP_N + i,
      phoneId: c.id,
      finalScore: c.matchScore,
    })),
    totalRanked: finalRankedUnique.length,
    eagerCount: eagerSlice.length,
  };
  return response;
};

// ---------------------------------------------------------------------------
// Two-stage pipeline — used by the "Recommend Me a Phone" button click.
//
//   Full Dataset
//      ↓
//   Stage 1 — Rule-Based (FastAPI /recommend)
//      · applies budget, brand, RAM, 5G, persona weights
//      · returns STAGE1_TOP_N (200) candidates — the reduced domain
//      ↓
//   Stage 2 — Content-Based (FastAPI /similarity/score)
//      · runs ONLY on the Stage-1 reduced set, NOT on the full catalog
//      · each candidate gets a cosine similarity to the centroid of the set
//      ↓
//   Sort by content_similarity desc → slice to STAGE2_FINAL_TOP_N (5)
//
// Compared to `getRecommendations` (the 5-signal fusionRank path used by
// auto-recommend), this deliberately:
//   - drops the fusionRank call (final rank is content similarity only)
//   - drops the behaviour score lookup (irrelevant when content rank wins)
//   - drops the impression log (top-5 is still logged by the controller
//     via safeRecordRecommendationEvent/safeRecordRecommendationCall)
//
// Backward compatibility: triggered only when the FE passes topN === 5.
// Any other topN continues to use `getRecommendations` above.
// ---------------------------------------------------------------------------
export const getRecommendationsTwoStage = async (body, userId, opts = {}) => {
  const { persona, budget, preferences, brandFilter } = body || {};
  const source = opts && typeof opts.source === "string" ? opts.source : "click";
  const requestId = opts && typeof opts.requestId === "string" ? opts.requestId : null;

  // Brand include/exclude from the "Find your phone" modal — see the
  // mirror copy in `getRecommendations` for the full comment. Kept
  // identical so both call sites stay in lock-step. Both slots are
  // HARD drops on the Python side (see
  // `ML Model/pipeline/recommend.py::_hard_filter_drops` steps 6 + 7).
  const brandList = Array.isArray(brandFilter?.list) ? brandFilter.list : null;
  const preferredBrands =
    brandList && brandList.length > 0 && brandFilter.mode === "include"
      ? brandList
      : undefined;
  const excludeBrands =
    brandList && brandList.length > 0 && brandFilter.mode === "exclude"
      ? brandList
      : undefined;

  if (!persona) throw badRequest("persona is required");
  if (!budget || typeof budget.max !== "number")
    throw badRequest("budget.max is required");

  let fusedPreferences = null;
  if (userId) {
    fusedPreferences = await buildFusedWeights(userId, {
      preferencesFromRequest: preferences,
    });
  }
  const effectivePersona = fusedPreferences ? "Custom" : persona;

  // ---- Stage 1: Rule-based filtering + persona-weight ranking ------------
  // Same FastAPI call as the legacy path — applies budget, brand, RAM,
  // 5G filters on the full catalog and returns STAGE1_TOP_N candidates.
  // This is the "reduced candidate domain" Stage 2 runs on.
  //
  // CF candidates are fetched in parallel (CF NEVER blocks the response;
  // failures degrade to empty results). Mirrors the dual-fetch in
  // `getRecommendations` so both code paths share the same CF behaviour.
  const [data, cfPayload] = await Promise.all([
    mlFetch("/recommend", {
      method: "POST",
      body: JSON.stringify({
        persona: effectivePersona,
        budget: { min: budget.min || 0, max: budget.max },
        preferences: fusedPreferences || preferences || {},
        topN: STAGE1_TOP_N,
      }),
    }),
    userId
      ? getCfRecommendations(userId, CF_CANDIDATE_TOP_N).catch((err) => {
          console.warn("[cf] promise rejected unexpectedly:", err?.message || err);
          return { results: [], coldStart: true, customerId: null, cluster: null, error: "rejected" };
        })
      : Promise.resolve({ results: [], coldStart: true, customerId: null, cluster: null, error: null }),
  ]);

  const mlResults = data.results || [];
  if (mlResults.length === 0) {
    // Edge case: no rule-based candidates. Still attempt to serve CF
    // results as a last-ditch fallback before giving up entirely.
    const cfOnly = await mergeCfCandidates([], cfPayload);
    if (userId && cfPayload?.results?.length) {
      void recordCfArtifacts(userId, cfPayload);
    }
    return dedupeByStableId(cfOnly.merged).slice(0, STAGE2_FINAL_TOP_N).map((c) => ({
      ...c,
      matchScore: (Number.isFinite(c.contentSim) ? c.contentSim : 0) * 100,
    }));
  }

  // ---- Fix #7 — batched enrichment (same path as the legacy call) -------
  const idMap = await resolvePhoneIds(
    mlResults.map((m) => ({ brand: m.Brand, modelName: m.Model })),
  );
  const phoneIds = Array.from(new Set(idMap.values()));
  const phoneById = await enrichPhonesById(phoneIds);
  const stockMap = await loadStockAndTrend(phoneIds);

  const enriched = mlResults.map((item) => {
    const key = `${(item.Brand || "").toLowerCase()}::${(item.Model || "").toLowerCase()}`;
    const phoneId = idMap.get(key) || null;
    const phone = phoneId ? phoneById.get(phoneId) : null;
    const stock = phoneId ? stockMap.get(phoneId) : null;
    const base = formatRecommendation(item, phone);
    return {
      ...base,
      overallScore: Number.isFinite(item.Overall_Score)
        ? Number(item.Overall_Score)
        : null,
      matchScoreFastApi: Number.isFinite(item.Match_Score)
        ? Number(item.Match_Score)
        : null,
      valueScore: Number.isFinite(item.Value_Score)
        ? Number(item.Value_Score)
        : null,
      trendScore: stock?.trendScore ?? 0,
      freshness: stock?.freshness ?? 0.5,
      stockState: stock?.stockState ?? "in_stock",
      stockPenalty: stock?.stockPenalty ?? 1.0,
      tags: phoneToTags(phone || {}),
    };
  });

  // ---- Fix #4 — content similarity against user history -----------------
  const seedPhones = userId
    ? await loadUserLikedAndViewed(userId, { limit: 25 })
    : [];
  const simRows = await fetchContentSimilarity(
    enriched.map((c) => ({
      brand: c.brand?.name || null,
      modelName: c.modelName,
    })),
    seedPhones.map((s) => ({ brand: s.brandName, modelName: s.phoneLabel })),
  );
  const seedWeight = seedPhones.length >= 3
    ? 1.0
    : Math.max(0.4, seedPhones.length / 3);
  for (const c of enriched) {
    const key = `${c.brand?.name || ""}::${c.modelName}`;
    const row = simRows.find((r) => `${r.brand}::${r.modelName}` === key);
    const simSeed = row && Number.isFinite(row.similarityToSeed) ? row.similarityToSeed : 0;
    const simCat  = row && Number.isFinite(row.similarityToCatalog) ? row.similarityToCatalog : 0;
    c.contentSim = (seedWeight * simSeed) + ((1 - seedWeight) * simCat);
  }

  // ---- CF hybrid merge -----------------------------------------------------
  // Union CF candidates into the enriched list before ranking. The CF
  // candidates don't have a contentSim (they came from a different
  // pipeline) so they'll rank below the rule-based candidates on the
  // sort below — except CF rows that match a brand+modelName already
  // in the list, which just receive a `cfReasons` hint without
  // disturbing the ranking.
  //
  // `mergeCfCandidates` mutates ML rows to add `cfReasons: string[]`
  // when a corresponding CF row was found. The FE renders that as a
  // "people like you also liked" badge.
  const { merged: cfMergedTwoStage } = await mergeCfCandidates(enriched, cfPayload);
  if (userId && cfPayload?.results?.length) {
    void recordCfArtifacts(userId, cfPayload);
  }

  // ---- Final ranking: content similarity only, then slice top 5 -----------
  // No 5-signal fusion. No behaviour score. The contract for this flow
  // is "Rank the remaining phones using the content-based similarity
  // score and return exactly 5 phones with the highest similarity."
  //
  // CF-only candidates (no `contentSim`) use their CF score as a
  // fallback so they still get a fair rank. In practice they appear
  // below the rule-based picks because the rule-based stage
  // already produced a high-quality content-similarity-ranked list.
  //
  // Dedupe BEFORE the slice so the top-5 are guaranteed to be 5 unique
  // phones, even when the underlying rule-based candidates share a
  // DB row (see `dedupeByStableId`). `dedupeByStableId` preserves
  // the order of first occurrence, so the highest-ranked row for
  // each identity is what survives.
  const rankedUnique = dedupeByStableId(
    cfMergedTwoStage.slice().sort((a, b) => {
      const aSim = Number.isFinite(a.contentSim) ? a.contentSim : 0;
      const bSim = Number.isFinite(b.contentSim) ? b.contentSim : 0;
      if (bSim !== aSim) return bSim - aSim;
      const aMatch = Number.isFinite(a.matchScoreFastApi)
        ? a.matchScoreFastApi
        : 0;
      const bMatch = Number.isFinite(b.matchScoreFastApi)
        ? b.matchScoreFastApi
        : 0;
      return bMatch - aMatch;
    }),
  );


  const finalRanked = rankedUnique.slice(0, STAGE2_FINAL_TOP_N);

  // Re-shape for the FE. The 0..100 matchScore the dashboard renders
  // is derived from the content similarity (already in [0,1]) so the UI
  // percentage keeps working without a special case in the renderer.
  const shaped = finalRanked.map((c) => ({
    ...c,
    matchScore: (Number.isFinite(c.contentSim) ? c.contentSim : 0) * 100,
  }));

  // Top-5 impression log (Fix #1 — now writes for ALL sources; the
  // trainer filters on is_training_eligible).
  if (userId && shaped.length > 0) {
    void safeRecordRecommendationLog(
      userId,
      shaped.map((c, i) => ({
        rank: i + 1,
        phoneId: c.id,
        finalScore: c.matchScore,
        source,
        requestId,
        firstSeenAt: new Date(),
      })),
    );
  }

  return shaped;
};

// ---------------------------------------------------------------------------
// Fix #8 — lazy expansion. The FE calls this as the user scrolls past
// the eager slice. Re-runs the FULL pipeline (stateful per-call
// pipelines are a trap) but only enriches / returns the
// [offset, offset+limit) window. The score / order are identical to
// what the eager response would have shown at those positions, so the
// FE can just append without re-sorting.
//
// We deliberately do NOT cache between calls — the user's behavior
// changes between calls and a cached response would be stale. The
// full pipeline is ~30-80ms on warm cache; the lazy slice is fine.
// ---------------------------------------------------------------------------
export const getRecommendationsSlice = async (body, userId, opts = {}) => {
  const { persona, budget, preferences, topN } = body || {};
  const source = opts && typeof opts.source === "string" ? opts.source : "click";
  const requestId = opts && typeof opts.requestId === "string" ? opts.requestId : null;
  const offset = Number.isFinite(opts.offset) ? Math.max(0, opts.offset) : EAGER_TOP_N;
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(60, opts.limit)) : LAZY_BATCH;

  // Run the same full pipeline, but only return the requested window.
  // We do this by calling the main path and slicing the response.
  const full = await getRecommendations({ ...(body || {}), topN: topN || FULL_LIST_TOP_N }, userId, {
    source,
    requestId,
  });
  const all = full && Array.isArray(full.results) ? full.results : [];
  const slice = all.slice(offset, offset + limit);
  return {
    results: slice,
    offset,
    limit,
    totalRanked: full?.totalRanked ?? all.length,
  };
};

// ---------------------------------------------------------------------------
// Auto-recommend — derive persona + budget from the stored profile and run
// the same fusion pipeline the click "Recommend Me" button uses.
//
// Reuses `getRecommendations` end-to-end so ML / similarity / fusion paths
// stay single-source-of-truth. No new FastAPI endpoint, no new fields in
// the bundle, no new recommendation route — the FE composes the same
// `POST /recommend` call dressed up as automatic.
//
// Fallback policy:
//   - No userId → return []. The route never fires for anonymous users.
//   - No stored persona → default to "allrounder" (matches Dashboard.jsx
//     selectedCategory default on a fresh account).
//   - No budget.max → default to €1500 (covers the full catalog).
//   - Either fallback fires a `defaultedAt` flag so the FE can show
//     "showing cold-start picks" UX if it wants to.
// ---------------------------------------------------------------------------
export const getAutoRecommendations = async (userId, opts = {}) => {
  if (!userId) {
    return {
      results: [],
      lazy: [],
      totalRanked: 0,
      eagerCount: 0,
      defaultedAt: { persona: false, budget: false },
    };
  }

  const source = opts && typeof opts.source === "string" ? opts.source : "auto";
  const requestId = opts && typeof opts.requestId === "string" ? opts.requestId : null;

  // Single read; buildFusedWeights inside getRecommendations will also
  // pull behavior_scores, so we don't double-load that table here.
  const bundle = await getProfileBundle(userId);

  const persona =
    bundle?.customerProfile?.recommendationPersona || "allrounder";
  const maxBudget =
    bundle?.preference?.maxBudget != null
      ? Number(bundle.preference.maxBudget)
      : null;

  // Track which fields we defaulted so the FE can show a
  // "Suggested for you — no preferences yet" badge if both defaulted.
  const defaultedAt = {
    persona: !bundle?.customerProfile?.recommendationPersona,
    budget: maxBudget == null,
  };

  // Hard-floor at 0 (matches the FE's validation: budget.min may be 0).
  const budget = {
    min: 0,
    max: maxBudget != null && maxBudget > 0 ? maxBudget : 1500,
  };

  // ---- Multi-retriever rollout bucketing (Step 1B) --------------------
  // When the kill switch is OFF, AUTO stays on the legacy single-source
  // path (this file's `getRecommendations` call below). When ON, the
  // user is bucketed by a deterministic hash of `userId` against the
  // rollout percentage; users outside the bucket keep the legacy path
  // (untouched percentage forms the canary control group).
  const rolloutBucket = bucketUserForRollout(userId);
  // Step 1 (plan): cold-start users should NEVER trigger a
  // behavior_scores query — the orchestrator's `loadBehaviorScoreMap`
  // call is wasted work because the user has no rows yet. Skip the
  // orchestrator for cold-start users and let them fall through to the
  // legacy `getRecommendations` path, which short-circuits via its own
  // cold-start handling (returns the global persona top-N).
  const userIsColdStart = await isColdStart(userId);
  const useMultiRetriever =
    AUTO_MULTI_RETRIEVER_ENABLED &&
    !userIsColdStart &&
    rolloutBucket !== "legacy";

  if (useMultiRetriever) {
    try {
      return await getAutoRecommendationsMultiRetriever(userId, {
        source,
        requestId,
        persona,
        budget,
        defaultedAt,
      });
    } catch (err) {
      // Orchestrator has internal Promise.allSettled + persona fallback
      // for per-source failures. This catch is only for catastrophic
      // orchestration failures — fall through to the legacy path.
      if (process.env.NODE_ENV === "production") {
        console.warn("[auto-recommend] orchestrator crashed, falling back:", err?.message || err);
      } else {
        console.error("[auto-recommend] orchestrator crashed, falling back:", err);
      }
      // intentional fall-through
    }
  }

  // Skip the explicit-prefs layer in the click flow — auto-recommend
  // is offline-of-the-moment, so fused weights do all the work.
  //
  // Behaviour tracking policy (updated 2026-08 — Fix #1):
  // The impression log inside `getRecommendations` is now WRITTEN
  // (not suppressed) with `source: "auto"`. The trainer (#3)
  // filters on `is_training_eligible` (set true by the FE's
  // POST /impressions when dwell >= 1.5s && !skipped) so noisy
  // "scrolled past" impressions don't pollute the regression.
  let results = [];
  try {
    const response = await getRecommendations(
      // Auto path does NOT forward a `brandFilter`. The Python
      // ranker treats `preferred_brands` / `exclude_brands` as HARD
      // drops (see `ML Model/pipeline/recommend.py::_hard_filter_drops`
      // steps 6 + 7), so forwarding the user's stored brand list here
      // would silently hide phones the user never asked to hide.
      // Auto-recommend surfaces ALL brands and lets the score decide.
      // The click flow ("Recommend Me a Phone") continues to honour
      // the modal's brand filter as a hard drop — that path is
      // untouched.
      { persona, budget, topN: FULL_LIST_TOP_N },
      userId,
      // Auto path opts OUT of the hard price ceiling. Out-of-budget
      // phones still surface (ranked, not dropped) with a soft
      // penalty proportional to how far over-budget they are. The
      // click flow ("Recommend Me a Phone") leaves `softPrice`
      // unset so the user's stated budget stays a hard ceiling.
      { source, requestId, softPrice: true },
    );
    // Fix #8 — the new response shape is { results, lazy, totalRanked,
    // eagerCount }. The auto path returns the full shape so the FE
    // can drive lazy expansion.
    if (response && Array.isArray(response.results)) {
      return { ...response, defaultedAt, recommendationVersion: "legacy_v0" };
    }
    // Legacy fallback (the inner getRecommendations returned a plain
    // array; preserve the old contract).
    results = Array.isArray(response) ? response : [];
  } catch (err) {
    // Don't bubble the error up to the route — the FE will simply show
    // an empty recs section. We surface the failure via console for ops.
    if (process.env.NODE_ENV === "production") {
      console.warn("[auto-recommend] failed:", err?.message || err);
    } else {
      console.error("[auto-recommend] failed:", err);
    }
    results = [];
  }

  return {
    results,
    lazy: [],
    totalRanked: results.length,
    eagerCount: results.length,
    defaultedAt,
    // Tag every legacy AUTO response so analytics reading the API can
    // always compare legacy_v0 vs multi_retriever_v1 outcomes using
    // the rollout split as a control group. See autoRetrieval.mjs +
    // migration 20260822000000_add_recommendation_version.
    recommendationVersion: "legacy_v0",
  };
};

// ---------------------------------------------------------------------------
// Multi-retriever AUTO path. Runs `orchestrateMultiRetriever` to fetch
// candidates from the new persona + behavioral union, then runs the
// existing personalisedRank + eager/lazy slice pipeline. Used only when
// `AUTO_MULTI_RETRIEVER_ENABLED=true` and the user is bucketed into
// `multi_retriever_v1`. All POST callers are unaffected — this function
// is reachable only from `getAutoRecommendations`.
// ---------------------------------------------------------------------------
async function getAutoRecommendationsMultiRetriever(userId, opts) {
  const { source, requestId, persona, budget, defaultedAt } = opts;

  const orchestrated = await orchestrateMultiRetriever(userId, {
    requestId,
    persona,
    budget,
  });
  const enriched = Array.isArray(orchestrated?.candidates)
    ? orchestrated.candidates
    : [];

  // Empty pool — return empty response, do NOT cold-start (user is
  // warm; multi-retriever just had nothing to give).
  if (enriched.length === 0) {
    return {
      results: [],
      lazy: [],
      totalRanked: 0,
      eagerCount: 0,
      defaultedAt,
      recommendationVersion: orchestrated?.recommendationVersion || "multi_retriever_v1",
    };
  }

  // Behaviour score map for the search_history sub-score (same as the
  // legacy `getRecommendations` does at lines 700-702).
  const behaviorScoresMap = userId
    ? await loadBehaviorScoreMap(userId)
    : null;

  // Short-term interest vector (same as legacy lines 704-718).
  let interestVec = new Map();
  let candidateMetaMap = new Map();
  if (userId) {
    const recentEvents = await getRecentEvents(userId);
    if (Array.isArray(recentEvents) && recentEvents.length > 0) {
      const interactedIds = recentEvents.map((e) => e.phoneId).filter(Boolean);
      const candidateIds = enriched.map((c) => c.id).filter(Boolean);
      candidateMetaMap = await loadPhoneMetaMap([
        ...interactedIds,
        ...candidateIds,
      ]);
      interestVec = buildShortTermInterest(recentEvents, candidateMetaMap);
    }
  }

  // Step E — personalised fusion. The stock multiplier is a function
  // so each candidate can have its own penalty (low_stock → 0.85,
  // in_stock → 1.0). Mirrors legacy lines 720-731.
  const stockMultiplier = (c) =>
    Number.isFinite(c.stockPenalty) ? c.stockPenalty : 1.0;
  const ranked = personalizedRank(
    enriched,
    behaviorScoresMap,
    interestVec,
    candidateMetaMap,
    stockMultiplier,
  );

  // Re-shape for FE — same as legacy lines 738-742.
  const finalRanked = ranked.map((c) => ({
    ...c,
    matchScore: c.finalScore * 100,
    matchComponents: c.components,
  }));

  const finalRankedUnique = dedupeByStableId(finalRanked);

  // Eager/lazy slice (Fix #8) — mirrors legacy lines 779-790.
  const eagerSlice = finalRankedUnique.slice(0, EAGER_TOP_N);
  const lazyQueue = finalRankedUnique.slice(EAGER_TOP_N);
  const response = {
    results: eagerSlice,
    lazy: lazyQueue.map((c, i) => ({
      offset: EAGER_TOP_N + i,
      phoneId: c.id,
      finalScore: c.matchScore,
    })),
    totalRanked: finalRankedUnique.length,
    eagerCount: eagerSlice.length,
  };

  // Impression log with `recommendationVersion = "multi_retriever_v1"`.
  // POST callers are unaffected — they go through `getRecommendations`
  // which does not pass `recommendationVersion`.
  if (userId && Array.isArray(finalRankedUnique) && finalRankedUnique.length > 0) {
    const topLogged = finalRankedUnique.slice(0, REC_LOG_WRITE_CAP);
    void safeRecordRecommendationLog(
      userId,
      topLogged.map((c, i) => ({
        rank: i + 1,
        phoneId: c.id,
        finalScore: c.matchScore,
        source,
        requestId,
        explorationArm: c.explorationArm || null,
        firstSeenAt: new Date(),
        recommendationVersion: orchestrated?.recommendationVersion || "multi_retriever_v1",
      })),
    );
  }

  return {
    ...response,
    defaultedAt,
    recommendationVersion: orchestrated?.recommendationVersion || "multi_retriever_v1",
  };
}

// Format ML result + DB data into frontend-friendly shape
const formatRecommendation = (mlItem, phone) => {
  if (!phone) {
    return {
      id: null,
      modelName: mlItem.Model,
      brand: { name: mlItem.Brand },
      // Out-of-DB recs: still try the CSV image index so the card
      // shows the actual GSMArena photo instead of the generic
      // placeholder. Falls through to null if the CSV doesn't have
      // an entry (e.g. extremely new ML-only entries).
      imageUrl: csvImageFor(mlItem.Brand, mlItem.Model),
      // GSMArena URL from the CSV. The FE uses this as a click target
      // since there's no `phones.id` to open the in-app detail page.
      sourceUrl: csvUrlFor(mlItem.Brand, mlItem.Model),
      keySpecs: null,
      cheapestVariant: { price: mlItem.Price_EUR },
      matchScore: mlItem.Match_Score,
      why: mlItem.Why || [],
      inDatabase: false,
    };
  }

  const cheapestVariant = phone.variants?.[0];

  return {
    id: phone.phoneId,
    modelName: phone.modelName,
    imageUrl: phone.imageUrl,
    antutuScore: phone.antutuScore,
    brand: phone.brand,
    keySpecs: {
      os: phone.specs?.os || null,
      display: phone.specs?.displaySize || null,
      refreshRate: phone.specs?.refreshRate || null,
      camera: phone.specs?.mainCamera || null,
      battery: phone.specs?.batteryMah || null,
      has5G: phone.specs?.supports5g || false,
      hasNfc: phone.specs?.supportsNfc || false,
    },
    cheapestVariant: cheapestVariant
      ? {
          ram: cheapestVariant.ramGb,
          storage: cheapestVariant.storageGb,
          price: cheapestVariant.price,
          storageType: cheapestVariant.storageType,
        }
      : null,
    matchScore: mlItem.Match_Score,
    why: mlItem.Why || [],
    inDatabase: true,
  };
};

export const compareWithML = async (modelNameA, modelNameB) => {
  if (!modelNameA || !modelNameB) throw badRequest("Both phone model names are required");

  try {
    const data = await mlFetch("/compare", {
      method: "POST",
      body: JSON.stringify({
        model_name_a: modelNameA,
        model_name_b: modelNameB,
      }),
    });
    return data;
  } catch (err) {
    // Same `err.status` vs `err.statusCode` fix as `mlFetch`. The
    // `safeErrorMessage` helper is already defined at module scope.
    if (err && err.status) throw err;
    throw internal(`ML compare failed (${safeErrorMessage(err)})`);
  }
};