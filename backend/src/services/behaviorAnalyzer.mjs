// behaviorAnalyzer — Step B single source of truth for behaviour events.
//
// Three exports work together:
//   - `recordEvent`            the only thing controllers should call:
//                              writes the `Event` row AND the
//                              `BehaviorScore` deltas in one tx.
//   - `extractTagsForEvent`    pure (phone-aware) tag-delta mapper.
//   - `applyDecay`             bounded decay helper for one tag.
//
// Failure policy:
//   `recordEvent` is supposed to be called from the same fire-and-forget
//   helpers that record legacy signals (searchHistory, browsingHistory, …).
//   A throw here must NOT break the user-facing response, so callers wrap
//   the call in try/catch. We still surface the error to the server log so
//   it can be diagnosed post-hoc.
//
// Behaviour-learning refresh (2026-07):
//   - All magic numbers moved to `config/behaviorConfig.mjs` (Phase 0).
//   - Per-event deltas derived from the phone's actual spec via
//     `services/phoneFeatureProfile.mjs` (Phase 1 + Phase 2). The
//     legacy structural `gaming` / `chipset` / `category` hard-coding
//     is gone; we emit `feature:<dim>` tags instead.
//   - Scores are bounded via tanh saturation (Phase 3) so a long
//     history cannot grow scores without limit.
//   - Per-event delta magnitude is multiplied by the confidence ramp
//     (Phase 4) so the first few events barely shift the dial.
//   - Repeats within the dedup window still hard-skip; repeats outside
//     apply a smooth `f(n) = 1 / (1 + K * (n-1))` curve (Phase 5).
//   - Each BehaviorScore row carries an LRU of the last 5 reasons it
//     was updated (Phase 6) so the FE can render per-tag
//     "Gaming +2 — Compared RedMagic 10 Pro" without a separate query.
//
// The public API (`recordEvent`, `extractTagsForEvent`, `applyDecay`)
// is unchanged from the prior version — controllers and tests that
// imported this file do not need to be edited.

import { prisma } from "../config/prisma.mjs";
import {
  BEHAVIOR_CONFIG,
  eventBaseWeight,
  featureBaseWeight,
} from "../config/behaviorConfig.mjs";
import {
  buildPhoneFeatureProfile,
  buildPhoneFeatureTagDeltas,
  FEATURE_DIMS,
} from "./phoneFeatureProfile.mjs";
import {
  computeConfidence,
  isConfidenceSaturated,
  computeCompareConfidence,
  isCompareConfidenceSaturated,
} from "./behaviorConfidence.mjs";

// ---- Search-keyword table --------------------------------------------------
//
// Pure mapping from free-form search query to behaviour tags. We don't
// run NLP here; we grep for category / brand / tier keywords that exist
// in our own seed data and return the matching tag. Search evidence is
// weaker than a phone lookup, so each matched keyword contributes only
// half the per-event weight (see `extractTagsForEvent`).
const SEARCH_KEYWORDS = {
  // categories
  rog: "category:gaming",
  gaming: "category:gaming",
  gamer: "category:gaming",
  camera: "category:camera",
  photography: "category:camera",
  battery: "category:battery",
  battery_life: "category:battery",
  // tiers
  ultra: "tier:flagship",
  flagship: "tier:flagship",
  premium: "tier:flagship",
  budget: "tier:budget",
  midrange: "tier:mid",
  lite: "tier:mid",
  // brands
  apple: "brand:apple",
  iphone: "brand:apple",
  samsung: "brand:samsung",
  galaxy: "brand:samsung",
  xiaomi: "brand:xiaomi",
  redmi: "brand:xiaomi",
  poco: "brand:xiaomi",
  oneplus: "brand:oneplus",
  google: "brand:google",
  pixel: "brand:google",
};

function tagsFromSearchQuery(q) {
  const out = [];
  if (typeof q !== "string") return out;
  const lower = q.toLowerCase();
  // Avoid double-counting the same tag from synonymous keywords
  // (e.g. "iphone" and "apple" both → brand:apple).
  const seen = new Set();
  for (const [kw, tag] of Object.entries(SEARCH_KEYWORDS)) {
    if (lower.includes(kw) && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

// ---- Tier inference --------------------------------------------------------
//
// `tier:<X>` tags are emitted when the phone's metadata implies a
// tier (flagship / mid / budget) even if no `tier:<X>` was hard-coded
// for the brand. Mirrors the original `inferTier` so legacy callers
// that depend on these tags keep working.
function inferTier(meta) {
  if (!meta) return null;
  const antutu =
    typeof meta.antutuScore === "number" ? meta.antutuScore : null;
  if (antutu == null) return null;
  if (antutu >= 900_000) return "flagship";
  if (antutu >= 500_000) return "mid";
  return "budget";
}

// Build the brand tag from a meta row. Returns null if no usable
// brand name is present. Names are sanitized to a 40-char
// [A-Za-z0-9_-] string and lower-cased so the writer's tag matches
// the reader's expectation (`customerPreferenceFor` in
// fusionRanker.mjs lower-cases via `sanitizeBrand`).
// Without lowercasing here we'd write `brand:Apple` and `brand:apple`
// as two distinct rows and the brand lift from compares would never
// be visible to the ranker.
function safeBrandName(meta) {
  if (!meta || typeof meta.brandName !== "string") return null;
  const safe = meta.brandName
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 40)
    .toLowerCase();
  return safe || null;
}

// ---- Bounded decay helper --------------------------------------------------
//
// `applyDecay` now sits on top of the config — it consults
// `BEHAVIOR_CONFIG.score` for alpha, saturation tanh-k, positiveCap,
// and negativeFloor. The shape of the helper is unchanged for test
// stability: callers pass (prevScore, delta, optional alpha) and get
// back the new score.
//
// Math:
//   raw = prevScore * alpha + delta
//   then apply smooth saturation so abs(raw) approaches the cap
//   asymptotically:
//     - For raw ≥ 0:    next = positiveCap * tanh(k * raw / positiveCap)
//     - For raw < 0:    next = negativeFloor * tanh(|k * raw / negativeFloor|)
//                       (always negative)
export function applyDecay(score, delta, alpha) {
  const cfg = BEHAVIOR_CONFIG.score;
  const s = Number.isFinite(score) ? score : 0;
  const d = Number.isFinite(delta) ? delta : 0;
  const a =
    Number.isFinite(alpha) && alpha > 0 && alpha <= 1
      ? alpha
      : cfg.alpha;
  const raw = s * a + d;
  const k = cfg.saturationTanhK;
  let next;
  if (raw >= 0) {
    next = cfg.positiveCap * Math.tanh((k * raw) / cfg.positiveCap);
  } else {
    const absRaw = -raw;
    const floor = -cfg.negativeFloor; // magnitude of the negative asymptote
    next = -floor * Math.tanh((k * absRaw) / floor);
  }
  return Math.round(next * 10000) / 10000;
}

// Backwards-compatible plain-decay helper exposed for tests. Returns
// the un-bounded pre-tanh value so unit tests can assert the raw
// `s * a + d` formula without the saturation curve on top. Kept as
// `__applyDecayRaw` so it's obviously an internal symbol.
export function __applyDecayRaw(score, delta, alpha = BEHAVIOR_CONFIG.score.alpha) {
  const s = Number.isFinite(score) ? score : 0;
  const d = Number.isFinite(delta) ? delta : 0;
  const a = Number.isFinite(alpha) ? alpha : BEHAVIOR_CONFIG.score.alpha;
  const next = s * a + d;
  return Math.round(next * 10000) / 10000;
}

// ---- Diminishing returns ---------------------------------------------------
//
// Counter per (userId, eventType, phoneId). Lives for the lifetime of
// the BE process; seeded lazily on first use. A process restart
// resets the counter so the *worst* case is the user gets one extra
// full-weight bump after a redeploy — acceptable for the stability
// guarantee.
const phoneRepeatCounters = new Map(); // key: `${userId}::${eventType}::${phoneId}`

export function diminishingMultiplier(repeatCount) {
  const n = Number.isFinite(repeatCount) && repeatCount > 0 ? repeatCount : 1;
  const cfg = BEHAVIOR_CONFIG.repeats;
  return cfg.initial / (1 + cfg.curveK * (n - 1));
}

// Read & bump the per-phone repeat counter. Pure-ish (only touches
// an in-memory Map). Returns the repeat count AFTER the bump.
function bumpRepeatCounter(userId, eventType, phoneId) {
  if (!userId || !eventType || !phoneId) return 1;
  const key = `${userId}::${eventType}::${phoneId}`;
  const prev = phoneRepeatCounters.get(key) || 0;
  const next = prev + 1;
  phoneRepeatCounters.set(key, next);
  return next;
}

// ---- Compare pair-keyed diminishing counter (Phase 3) ----------------------
//
// Compares are special: a single user action fires TWO event rows (one per
// side) and the meaningful unit of "did the user do this twice" is the
// *pair* (phoneA, phoneB), not the per-phone counter above. This Map
// stores the count of sightings of each unordered pair for a given user.
//
//   key  = `${userId}::compare::${sorted([a,b]).join("::")}`
//   val  = { count: <number>, firstAt: <ms> }
//
// We keep `firstAt` so a lazy TTL eviction (`compare.counterTtlMs`,
// default 10 min) can drop entries that have aged out and re-allow the
// user to "discover" the same pair again at full weight after a long
// absence. Compare dedup is otherwise handled by `isDuplicatePair` below.
const comparePairCounters = new Map();

function buildPairKey(a, b) {
  if (!a || !b) return null;
  // Unordered — comparing {X, Y} and {Y, X} are the same logical event.
  const sorted = String(a) < String(b) ? [a, b] : [b, a];
  return sorted.join("::");
}

function bumpComparePairCounter(userId, pairKey) {
  if (!userId || !pairKey) return 1;
  const key = `${userId}::compare::${pairKey}`;
  const prev = comparePairCounters.get(key);
  const now = Date.now();
  const next = prev ? prev.count + 1 : 1;
  comparePairCounters.set(key, {
    count: next,
    firstAt: prev ? prev.firstAt : now,
  });
  return next;
}

// Diminishing multiplier for compare-pair counters. Uses the compare-
// specific diminishing curve (BEHAVIOR_CONFIG.compare.diminishing).
//   n=1 → 1.000   (first sight, full weight)
//   n=2 → 0.645
//   n=3 → 0.476
//   n=4 → 0.385
//   n=5 → 0.323
export function diminishingPairMultiplier(repeatCount) {
  const n = Number.isFinite(repeatCount) && repeatCount > 0 ? repeatCount : 1;
  const cfg = BEHAVIOR_CONFIG.compare.diminishing;
  return cfg.initial / (1 + cfg.curveK * (n - 1));
}

// Best-effort TTL eviction. Called lazily on every counter read so the
// cost is amortised. Drops entries whose `firstAt` is older than the
// configured TTL.
function evictStalePairCounters(now = Date.now()) {
  const ttl = BEHAVIOR_CONFIG.compare.counterTtlMs;
  if (!Number.isFinite(ttl) || ttl <= 0) return;
  for (const [key, val] of comparePairCounters.entries()) {
    if (!val || now - val.firstAt > ttl) comparePairCounters.delete(key);
  }
}

// Exposed for tests + ops debugging; never mutated by callers.
export const __compareDiminishingState = { comparePairCounters };

// Exposed for tests + ops debugging; never mutated by callers.
export const __diminishingState = { phoneRepeatCounters };

// ---- Phone metadata cache --------------------------------------------------
//
// Cached at module scope for the lifetime of the BE process. Phones
// don't change specs often, so a small Map is plenty. We carry this
// forward unchanged so the per-burst-of-clicks path is cheap.
const phoneMetaCache = new Map();
const PHONE_META_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function lookupPhoneMeta(phoneId) {
  if (!phoneId || typeof phoneId !== "string") return null;
  const cached = phoneMetaCache.get(phoneId);
  const now = Date.now();
  if (cached && now - cached.at < PHONE_META_TTL_MS) {
    return cached.value;
  }
  try {
    const phone = await prisma.phones.findUnique({
      where: { phoneId },
      select: {
        modelName: true,
        antutuScore: true,
        batteryMah: true,
        brand: { select: { name: true } },
        specs: {
          select: {
            chipset: true,
            mainCamera: true,
            refreshRate: true,
            displaySize: true,
          },
        },
      },
    });
    if (!phone) {
      phoneMetaCache.set(phoneId, { at: now, value: null });
      return null;
    }
    const cameraText = phone.specs?.mainCamera || "";
    const cameraMatch =
      typeof cameraText === "string"
        ? cameraText.match(/(\d+(?:\.\d+)?)\s*MP/i)
        : null;
    const mainCameraMp = cameraMatch ? Number(cameraMatch[1]) : null;

    const value = {
      modelName: phone.modelName || null,
      brandName: phone.brand?.name || null,
      chipset: phone.specs?.chipset || null,
      antutuScore: typeof phone.antutuScore === "number" ? phone.antutuScore : null,
      batteryMah: typeof phone.batteryMah === "number" ? phone.batteryMah : null,
      refreshRate:
        typeof phone.specs?.refreshRate === "number"
          ? phone.specs.refreshRate
          : null,
      displaySize:
        typeof phone.specs?.displaySize === "number"
          ? phone.specs.displaySize
          : null,
      mainCameraMp: Number.isFinite(mainCameraMp) ? mainCameraMp : null,
    };
    phoneMetaCache.set(phoneId, { at: now, value });
    return value;
  } catch {
    return null;
  }
}

// ---- Reasons-LRU helpers (Phase 6) -----------------------------------------
//
// Each BehaviorScore row carries an LRU of the most recent reasons it
// was updated. Shape (object form, plain JSONB):
//
//   { entries: [
//       { dim, delta, reason, phoneId, phoneLabel, eventType, at } ],
//     updatedAt: "2026-07-30T..." }
//
// `dim` is the user-readable tag name (e.g. "feature:gaming").
// `reason` is the human-readable phrase ("Compared RedMagic 10 Pro").
// `at` is the ISO timestamp; older entries are evicted past the
// per-tag limit from BEHAVIOR_CONFIG.

const REASONS_EMPTY = Object.freeze({ entries: [], updatedAt: null });

function pushReason(current, entry, limit) {
  const cur =
    current && typeof current === "object" && Array.isArray(current.entries)
      ? current
      : { entries: [], updatedAt: null };
  const next = cur.entries.slice(0, limit - 1);
  next.unshift(entry);
  return {
    entries: next,
    updatedAt: new Date().toISOString(),
  };
}

function describeReason(meta, eventType, payload) {
  // Compose a one-line human phrase from the cached phone meta + the
  // event type. Caps at ~80 chars so the FE can render it on one line.
  if (!meta) {
    if (eventType === "search") {
      const q = payload?.q || payload?.searchQuery;
      if (typeof q === "string" && q.trim().length > 0) {
        return `Searched "${q.trim().slice(0, 50)}"`;
      }
    }
    return `Action: ${eventType}`;
  }
  const name = meta.modelName || meta.brandName || "this phone";
  switch (eventType) {
    case "view":
      return `Viewed ${name}`;
    case "click":
      return `Opened ${name}`;
    case "compare":
      return `Compared ${name}`;
    case "recommend":
      return `Recommended ${name}`;
    case "save":
      return `Saved ${name}`;
    case "search":
      return `Searched "${(payload?.q || "").toString().slice(0, 40) || "phone"}"`;
    case "ignore":
      return `Dismissed ${name}`;
    default:
      return `Interaction with ${name}`;
  }
}

// ---- Public API ------------------------------------------------------------

// Map an incoming event to the per-tag deltas it should produce.
// Returns `Map<tag, delta>` and a side-channel `Map<tag, reason>` that
// the caller (recordEvent) writes onto the BehaviorScore row.
//
// Recognised eventTypes: "search" | "view" | "compare" | "click" |
// "save" | "ignore" | "recommend". Unknown types return empty maps.
export async function extractTagsForEvent(eventType, phoneId, payload) {
  const baseWeight = eventBaseWeight(eventType);
  if (baseWeight === 0) {
    return { deltas: new Map(), reasons: new Map() };
  }

  const deltas = new Map();
  const reasons = new Map();

  // Resolve phone meta once — used by both delta derivation and the
  // reason phraser. A failed lookup just means we emit fewer tags.
  let meta = phoneId ? await lookupPhoneMeta(phoneId) : null;

  // ----- Search path: keyword-based tags, weaker than a phoneId lookup
  if (eventType === "search") {
    const tags = tagsFromSearchQuery(payload?.q);
    if (tags.length === 0 && !meta) {
      return { deltas, reasons };
    }
    // Search evidence uses half the per-event weight — typing a
    // keyword is weaker than viewing an actual phone. The 0.5 lives
    // here, not in the config, because it only applies to search.
    const searchScale = 0.5;
    for (const tag of tags) {
      deltas.set(tag, (deltas.get(tag) || 0) + baseWeight * searchScale);
    }
    return {
      deltas,
      reasons: new Map(
        tags.map((t) => [t, describeReason(meta, "search", payload)]),
      ),
    };
  }

  // ----- Non-search path: per-phone feature profile + brand/tier
  if (!meta) {
    // No phoneId (or unknown phone). Nothing meaningful to emit.
    return { deltas, reasons };
  }

  // Phase 2: per-dim feature deltas via the feature profile.
  const tagDeltas = buildPhoneFeatureTagDeltas(meta, featureBaseWeight);
  for (const [tag, delta] of tagDeltas.entries()) {
    deltas.set(tag, (deltas.get(tag) || 0) + delta * baseWeight);
    reasons.set(tag, describeReason(meta, eventType, payload));
  }

  // Brand bump — single tag, weighted by `featureWeight.brand`.
  const brand = safeBrandName(meta);
  if (brand) {
    const brandTag = `brand:${brand}`;
    const w = featureBaseWeight("brand");
    deltas.set(
      brandTag,
      (deltas.get(brandTag) || 0) + baseWeight * w,
    );
    reasons.set(brandTag, describeReason(meta, eventType, payload));
  }

  // Tier bump — only if `inferTier` can derive one.
  const tier = inferTier(meta);
  if (tier) {
    const tierTag = `tier:${tier}`;
    const w = featureBaseWeight("tier");
    deltas.set(
      tierTag,
      (deltas.get(tierTag) || 0) + baseWeight * w,
    );
    reasons.set(tierTag, describeReason(meta, eventType, payload));
  }

  return { deltas, reasons };
}

// ---- Compare-specific tag emitter (Phase 3) --------------------------------
//
// Compare events fire a richer set of tags than the legacy path. We emit:
//
//   affinity:<phoneId>          per-phone affinity (the strongest signal)
//   model:<hash(modelName)>     per-model cluster (cohorts of same-model phones)
//   brand:<X>                   brand-level lift — GATED.
//                               The first-time a user touches a brand we
//                               emit a small "seed" delta so the row exists
//                               for admin-UI introspection; subsequent
//                               compares don't lift the brand until the
//                               gate (≥3 distinct phones of brand X) is met.
//   tier:<T>                    flagships / mid / budget
//   feature:<dim>               per-dim feature vector (gaming, camera, …)
//
// Compare deltas are pre-multiplied by `compareConfidence × pairDimScalar`
// before being returned to `recordEvent`. The legacy `extractTagsForEvent`
// is left untouched so search / view / click / save / recommend paths
// keep their existing semantics.
//
// Inputs:
//   phoneId              — the phoneId of THIS side (the phone we're boosting)
//   meta                 — `lookupPhoneMeta(phoneId)` cache row
//   baseWeight           — the eventWeight for `compare` (= 2.00)
//   compareConfidence    — multiplier from `computeCompareConfidence`
//   pairDimScalar        — multiplier from `diminishingPairMultiplier`
//   brandGateMet         — boolean: gate met for this phone's brand?
//   brandGateSeed        — multiplier (default 1.0) for the seed-delta path
//
// Outputs:
//   { deltas: Map<tag, delta>, reasons: Map<tag, reason> }
export function extractCompareTags(
  phoneId,
  meta,
  baseWeight,
  compareConfidence,
  pairDimScalar,
  brandGateMet,
  brandGateSeed = 1.0,
) {
  const deltas = new Map();
  const reasons = new Map();
  if (!meta || !phoneId) return { deltas, reasons };

  const aff = BEHAVIOR_CONFIG.affinity;
  const scalar = baseWeight * compareConfidence * pairDimScalar;
  if (!(scalar > 0)) return { deltas, reasons };

  // 1. affinity:<phoneId> — direct per-phone lift.
  const affTag = `affinity:${phoneId}`;
  deltas.set(affTag, (deltas.get(affTag) || 0) + scalar * aff.phoneAffinity);
  reasons.set(affTag, describeReason(meta, "compare", null));

  // 2. model:<hash> — same-model cluster.
  const modelHash = hashModelName(meta.modelName);
  if (modelHash) {
    const modelTag = `model:${modelHash}`;
    deltas.set(modelTag, (deltas.get(modelTag) || 0) + scalar * aff.modelAffinity);
    reasons.set(modelTag, describeReason(meta, "compare", null));
  }

  // 3. brand:<X> — gated. If gate met → full delta. If not → seed delta.
  const brand = safeBrandName(meta);
  if (brand) {
    const brandTag = `brand:${brand}`;
    const brandScalar = brandGateMet
      ? scalar * aff.brandGatedAffinity
      : scalar * aff.brandGatedAffinity * brandGateSeed;
    if (brandScalar > 0) {
      deltas.set(brandTag, (deltas.get(brandTag) || 0) + brandScalar);
      reasons.set(brandTag, describeReason(meta, "compare", null));
    }
  }

  // 4. tier:<T> — always emitted (no gate).
  const tier = inferTier(meta);
  if (tier) {
    const tierTag = `tier:${tier}`;
    deltas.set(tierTag, (deltas.get(tierTag) || 0) + scalar * aff.tierAffinity);
    reasons.set(tierTag, describeReason(meta, "compare", null));
  }

  // 5. feature:<dim> — per-dim feature vector (gaming, camera, …).
  // Reuse the existing `buildPhoneFeatureTagDeltas` so the per-dim
  // weights (BEHAVIOR_CONFIG.featureWeight) stay consistent with the
  // search / view / click path. We multiply the entire feature
  // vector by `featureAffinity` once, not per-dim, so a phone with
  // 3 active dims receives 3× the contribution of a single-dim phone.
  const featureTagDeltas = buildPhoneFeatureTagDeltas(meta, featureBaseWeight);
  for (const [tag, value] of featureTagDeltas.entries()) {
    deltas.set(
      tag,
      (deltas.get(tag) || 0) + scalar * value * aff.featureAffinity,
    );
    reasons.set(tag, describeReason(meta, "compare", null));
  }

  return { deltas, reasons };
}

// ---- Event → BehaviorScore write path --------------------------------------

// Cheap fetcher for "how many events has this user already recorded?".
// Used by the confidence ramp. Returns 0 on a read failure so a
// transient blip degrades to "no history yet" rather than throwing.
async function userEventCount(userId) {
  if (!userId) return 0;
  try {
    return await prisma.event.count({ where: { userId } });
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[behaviorAnalyzer] userEventCount failed:", err?.message || err);
    }
    return 0;
  }
}

// Hard-dedup: same (user, type, phoneId) within the dedup window is
// dropped entirely. Outside the window the event is recorded, just
// with a smaller weight from `diminishingMultiplier`.
const EVENT_DEDUPABLE_EVENTS = new Set(BEHAVIOR_CONFIG.events.dedupableTypes);
const EVENT_DEDUP_WINDOW_MS = BEHAVIOR_CONFIG.events.dedupWindowMs;

async function isDuplicateEvent(userId, eventType, phoneId) {
  if (!userId || !eventType || !phoneId) return false;
  const cutoff = new Date(Date.now() - EVENT_DEDUP_WINDOW_MS);
  try {
    const prior = await prisma.event.findFirst({
      where: {
        userId,
        eventType,
        phoneId,
        createdAt: { gte: cutoff },
      },
      orderBy: { createdAt: "desc" },
      select: { eventId: true },
    });
    return Boolean(prior);
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[behaviorAnalyzer] isDuplicateEvent read failed:",
        err?.message || err,
      );
    } else {
      console.warn("[behaviorAnalyzer] isDuplicateEvent read failed:", err);
    }
    return false;
  }
}

// Pair-keyed dedup for compare events. Compares share the same
// `compare.pairDedupWindowMs` window but are keyed by pairKey (the
// sorted `phoneA::phoneB` string) instead of per-phoneId. The DB
// stores pairKey inside `event.payload` JSONB. We don't index it
// here — the volume is low enough that a sequential filter is cheap,
// and the in-memory `comparePairCounters` Map above already prevents
// runaway back-to-back spam loops.
async function isDuplicatePair(userId, pairKey) {
  if (!userId || !pairKey) return false;
  const cutoff = new Date(Date.now() - BEHAVIOR_CONFIG.compare.pairDedupWindowMs);
  try {
    const prior = await prisma.event.findFirst({
      where: {
        userId,
        eventType: "compare",
        createdAt: { gte: cutoff },
        payload: { path: ["pairKey"], equals: pairKey },
      },
      orderBy: { createdAt: "desc" },
      select: { eventId: true },
    });
    return Boolean(prior);
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[behaviorAnalyzer] isDuplicatePair read failed:",
        err?.message || err,
      );
    } else {
      console.warn("[behaviorAnalyzer] isDuplicatePair read failed:", err);
    }
    return false;
  }
}

// Count distinct compare pairs the user has fired. One compare fires
// two event rows (one per side) but pairKey is identical for both, so
// counting distinct pairKey values gives "how many UNIQUE pairings
// has this user explored?". Feeds `computeCompareConfidence`.
//
// Falls back to 0 on a read failure so a transient blip degrades to
// "no history yet" rather than throwing — same policy as
// `userEventCount`.
async function countUniqueComparePairs(userId) {
  if (!userId) return 0;
  try {
    // DISTINCT over payload->>'pairKey' requires a raw SQL string in
    // some Prisma versions. We use the JSONB path operator which
    // Postgres supports natively and Prisma passes through.
    const rows = await prisma.$queryRaw`
      SELECT DISTINCT payload->>'pairKey' AS pair_key
      FROM "events"
      WHERE "user_id" = ${userId}::uuid
        AND "event_type" = 'compare'
        AND payload ? 'pairKey'
        AND payload->>'pairKey' IS NOT NULL
    `;
    return Array.isArray(rows) ? rows.length : 0;
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[behaviorAnalyzer] countUniqueComparePairs failed:",
        err?.message || err,
      );
    } else {
      console.warn("[behaviorAnalyzer] countUniqueComparePairs failed:", err);
    }
    return 0;
  }
}

// Brand-gate derivation. Counts how many DISTINCT phones of each
// brand the user has touched via compare events. Used to decide
// whether to emit a full `brand:<X>` delta on the next compare (gate
// met → full delta) or only a seed delta (gate not yet met).
//
// Implementation: for each compare event row we join with
// Phones.brand.name, then group by brand and count distinct
// phoneIds. The output is
//   Map<sanitizedBrandName, distinctPhoneCount>
//
// Previously this was wrapped in a 5-min module-scope cache, but the
// cache stranded `brandGateMet` at "not met" for fast back-to-back
// compares (cache hit always returned the count observed before the
// current compare's event was written). We dropped the cache — the
// query is one indexed scan over a small per-user partition and
// compares are user-driven (rare), so the extra ~5 ms per compare
// is invisible. Each `recordCompareEvent` call now sees the latest
// state, so the gate flips immediately once the user has touched
// ≥3 distinct phones of a brand.
export async function getBrandGateState(userId) {
  if (!userId) return new Map();
  try {
    const rows = await prisma.event.findMany({
      where: { userId, eventType: "compare", phoneId: { not: null } },
      distinct: ["phoneId"],
      select: {
        phoneId: true,
      },
    });
    const phoneIds = rows.map((r) => r.phoneId).filter(Boolean);
    if (phoneIds.length === 0) return new Map();
    const phones = await prisma.phones.findMany({
      where: { phoneId: { in: phoneIds } },
      select: {
        phoneId: true,
        brand: { select: { name: true } },
      },
    });
    const out = new Map();
    for (const p of phones) {
      const brand = p.brand && p.brand.name;
      if (!brand) continue;
      const key = brand.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40).toLowerCase();
      if (!key) continue;
      out.set(key, (out.get(key) || 0) + 1);
    }
    return out;
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[behaviorAnalyzer] getBrandGateState failed:",
        err?.message || err,
      );
    } else {
      console.warn("[behaviorAnalyzer] getBrandGateState failed:", err);
    }
    return new Map();
  }
}

// Hash a model name into a short, comparable tag-suffix. Used to
// build `model:<hash>` rows so two phones of the same model (e.g.
// "Apple iPhone 17e") share a tag and lift together.
//
// 8 chars from a lowercase-alphanum fold. Collision risk is small
// because the tag only nudges a phone whose model name ALSO has the
// same fold — false positives just produce a tiny extra lift.
export function hashModelName(name) {
  if (typeof name !== "string" || name.length === 0) return null;
  // 22 chars so iPhone 17 / 17 Pro / 17 Pro Max / 17e each get a
  // distinct model cluster — 8-char and 16-char hashes collapse the
  // "appleiphone17pro*" prefix. 22 chars is still well under the
  // BehaviorScore.tag VARCHAR(60) cap once the "model:" prefix is
  // added (22 + 6 = 28 chars).
  return name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 22);
}

// Read-only helper exposed for ops dashboards and tests. Tells the
// caller what tag-emission mode the next compare will use given the
// current gate state for the user's brand. Pure — does not mutate
// anything.
export function compareBrandGateIsMet(gateState, brandName) {
  if (!gateState || !brandName) return false;
  const key = brandName
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 40)
    .toLowerCase();
  const count = gateState.get(key) || 0;
  return count >= BEHAVIOR_CONFIG.compare.brandGate.distinctPhonesRequired;
}

// Single entry point controllers should use. Writes the Event row
// first (audit trail), then upserts every tag delta into BehaviorScore
// with bounded decay + confidence scaling + repeating discount.
//
// Returns:
//   { eventId, tagsUpdated: string[], skipped?: 'duplicate' }
//
// Throws on DB error; callers wrap in try/catch (fire-and-forget).
export async function recordEvent(userId, eventType, opts = {}) {
  if (!userId) throw new Error("recordEvent requires a userId");
  if (typeof eventType !== "string" || !eventType) {
    throw new Error("recordEvent requires a non-empty eventType");
  }

  const phoneId =
    typeof opts.phoneId === "string" && opts.phoneId ? opts.phoneId : null;
  const payload =
    opts.payload && typeof opts.payload === "object" ? opts.payload : null;

  // Compare events take a separate path. They use pair-keyed dedup +
  // pair-keyed diminishing + a pair-count confidence ramp, and emit
  // their own richer tag set (affinity:/model:/brand/tier/feature).
  // Branching here keeps the legacy view/click/search/save path
  // bit-for-bit identical to its pre-Phase-3 behaviour.
  if (eventType === "compare") {
    return recordCompareEvent(userId, phoneId, payload);
  }

  // ----- Legacy path (view / click / search / save / recommend / ignore) ----

  // Hard-dedup: same (user, type, phoneId) within the window is a
  // no-op. Outside the window we still write the row + a smaller bump.
  if (phoneId && EVENT_DEDUPABLE_EVENTS.has(eventType)) {
    const dup = await isDuplicateEvent(userId, eventType, phoneId);
    if (dup) {
      return { eventId: null, tagsUpdated: [], skipped: "duplicate" };
    }
  }

  // Diminishing-returns: each repeat on the same phone+event adds
  // less weight. The multiplier is computed BEFORE we know the
  // per-event deltas, so it's a flat scalar per (user, type, phone).
  let repeatScalar = 1.0;
  if (phoneId && EVENT_DEDUPABLE_EVENTS.has(eventType)) {
    const n = bumpRepeatCounter(userId, eventType, phoneId);
    repeatScalar = diminishingMultiplier(n);
  }

  // Confidence ramp: scale the per-event bump by event count so a
  // first-click user writes a smaller delta than a 30-event user.
  // Reading the count is one indexed row-count query; cheap.
  const eventCount = await userEventCount(userId);
  const confidence =
    isConfidenceSaturated(eventCount) ? 1.0 : computeConfidence(eventCount);

  // Derive per-tag deltas (pure, cache-backed).
  const { deltas, reasons } = await extractTagsForEvent(
    eventType,
    phoneId,
    payload,
  );
  if (deltas.size === 0) {
    // Still worth recording the Event row so the audit trail exists,
    // even though no BehaviourScore bump is meaningful.
    const created = await prisma.event.create({
      data: {
        userId,
        eventType,
        phoneId: phoneId || undefined,
        payload: payload || undefined,
      },
      select: { eventId: true },
    });
    return { eventId: created.eventId, tagsUpdated: [] };
  }

  // Pre-multiply every delta by `repeatScalar * confidence` so the
  // downstream upsert sees the final value. Pure (no side effects).
  const effectiveDeltas = new Map();
  for (const [tag, delta] of deltas.entries()) {
    const scaled = delta * repeatScalar * confidence;
    if (scaled !== 0) effectiveDeltas.set(tag, scaled);
  }
  const tagsUpdated = Array.from(effectiveDeltas.keys());

  return prisma.$transaction(async (tx) => {
    const created = await tx.event.create({
      data: {
        userId,
        eventType,
        phoneId: phoneId || undefined,
        payload: payload || undefined,
      },
      select: { eventId: true },
    });

    for (const [tag, delta] of effectiveDeltas.entries()) {
      const existing = await tx.behaviorScore.findUnique({
        where: { userId_tag: { userId, tag } },
        select: { score: true, reasons: true },
      });
      const prev = existing?.score || 0;
      const next = applyDecay(prev, delta);

      // Build the new reasons LRU. `reasons` is shape `{entries:[], updatedAt}`.
      const prevReasons =
        existing?.reasons && typeof existing.reasons === "object"
          ? existing.reasons
          : null;
      const reasonEntry = reasons.get(tag);
      const newReasons = reasonEntry
        ? pushReason(
            prevReasons,
            {
              dim: tag,
              delta: Math.round(delta * 1000) / 1000,
              reason: reasonEntry,
              phoneId: phoneId || null,
              eventType,
              at: new Date().toISOString(),
            },
            BEHAVIOR_CONFIG.reasons.perTagLimit,
          )
        : prevReasons || null;

      await tx.behaviorScore.upsert({
        where: { userId_tag: { userId, tag } },
        create: {
          userId,
          tag,
          score: next,
          reasons: newReasons || undefined,
        },
        update: {
          score: next,
          reasons: newReasons || undefined,
        },
      });
    }

    return { eventId: created.eventId, tagsUpdated };
  });
}

// ---- Compare-event write path (Phase 3) ------------------------------------
//
// Compare events take a different code path from the legacy view/click/
// search/save handlers because:
//
//   1. They fire TWO event rows per user action (one per side), so the
//      meaningful unit of "did this user compare the same pair twice" is
//      the unordered pair, not the per-phoneId tuple.
//   2. They emit a richer tag set: `affinity:<phoneId>`, `model:<hash>`,
//      `brand:<X>` (gated), `tier:<T>`, and the existing `feature:<dim>`
//      vector. The legacy `extractTagsForEvent` only emits `feature:*` +
//      `brand:*` + `tier:*` and lacks the per-phone affinity row.
//   3. They ramp on UNIQUE PAIR COUNT rather than raw event count, so
//      a 3-compare user is at ~0.78 ramp (vs ~0.48 with the legacy ramp
//      on 6 raw events).
//
// The pairKey is read from `payload.pairKey` (set by
// `safeRecordCompareEvent` in `profileService.mjs`).
//
// Returns:
//   { eventId, tagsUpdated: string[], skipped?: 'duplicate' }
async function recordCompareEvent(userId, phoneId, payload) {
  const pairKey =
    payload && typeof payload.pairKey === "string" && payload.pairKey
      ? payload.pairKey
      : null;

  // Pair-level dedup gate. If the same pair was compared within the
  // window, we drop both this side and (by extension, since both sides
  // share the same pairKey) the other side's row from the same compare.
  if (pairKey) {
    const dup = await isDuplicatePair(userId, pairKey);
    if (dup) {
      return { eventId: null, tagsUpdated: [], skipped: "duplicate" };
    }
  }

  // Lazy TTL eviction — keep the in-memory counter bounded.
  evictStalePairCounters();

  // Pair-level diminishing scalar. For a brand-new pair the scalar is
  // 1.0 (full weight); a repeat pair shrinks toward 0.
  let pairDimScalar = 1.0;
  if (pairKey) {
    const n = bumpComparePairCounter(userId, pairKey);
    pairDimScalar = diminishingPairMultiplier(n);
  }

  // Pair-count confidence ramp. Computed via the compare-specific
  // ramp curve so 1 unique pair → ~0.69, 3 → ~0.91.
  const uniquePairCount = await countUniqueComparePairs(userId);
  const compareConfidence = isCompareConfidenceSaturated(uniquePairCount)
    ? 1.0
    : computeCompareConfidence(uniquePairCount);

  // Resolve phone meta + brand gate.
  const meta = phoneId ? await lookupPhoneMeta(phoneId) : null;
  let brandGateMet = false;
  if (meta && meta.brandName) {
    const gateState = await getBrandGateState(userId);
    brandGateMet = compareBrandGateIsMet(gateState, meta.brandName);
  }
  const seedScalar = brandGateMet
    ? 1.0
    : BEHAVIOR_CONFIG.compare.brandGate.seedDelta;

  // Emit the per-tag deltas. Compare deltas are pre-multiplied by
  // compareConfidence * pairDimScalar inside `extractCompareTags`.
  const baseWeight = eventBaseWeight("compare");
  const { deltas, reasons } = extractCompareTags(
    phoneId,
    meta,
    baseWeight,
    compareConfidence,
    pairDimScalar,
    brandGateMet,
    seedScalar,
  );

  if (deltas.size === 0) {
    const created = await prisma.event.create({
      data: {
        userId,
        eventType: "compare",
        phoneId: phoneId || undefined,
        payload: payload || undefined,
      },
      select: { eventId: true },
    });
    return { eventId: created.eventId, tagsUpdated: [] };
  }

  const tagsUpdated = Array.from(deltas.keys());

  return prisma.$transaction(async (tx) => {
    const created = await tx.event.create({
      data: {
        userId,
        eventType: "compare",
        phoneId: phoneId || undefined,
        payload: payload || undefined,
      },
      select: { eventId: true },
    });

    for (const [tag, delta] of deltas.entries()) {
      const existing = await tx.behaviorScore.findUnique({
        where: { userId_tag: { userId, tag } },
        select: { score: true, reasons: true },
      });
      const prev = existing?.score || 0;
      const next = applyDecay(prev, delta);

      const prevReasons =
        existing?.reasons && typeof existing.reasons === "object"
          ? existing.reasons
          : null;
      const reasonEntry = reasons.get(tag);
      const newReasons = reasonEntry
        ? pushReason(
            prevReasons,
            {
              dim: tag,
              delta: Math.round(delta * 1000) / 1000,
              reason: reasonEntry,
              phoneId: phoneId || null,
              eventType: "compare",
              at: new Date().toISOString(),
            },
            BEHAVIOR_CONFIG.reasons.perTagLimit,
          )
        : prevReasons || null;

      await tx.behaviorScore.upsert({
        where: { userId_tag: { userId, tag } },
        create: {
          userId,
          tag,
          score: next,
          reasons: newReasons || undefined,
        },
        update: {
          score: next,
          reasons: newReasons || undefined,
        },
      });
    }

    return { eventId: created.eventId, tagsUpdated };
  });
}

// Re-export helper so tests can invalidate the cache.
export const __test__ = { lookupPhoneMeta, phoneMetaCache };

// ---- Behaviour-score reasons helper (read side) ---------------------------
//
// Read the per-tag reason LRU for a single tag. Used by the
// `/api/events/behavior/me` route (or any future FE helper) to render
// "Boosted by your activity → Gaming +2 (Compared RedMagic 10 Pro)".
// Returns the empty-freeze constant when nothing is recorded yet.
export function getReasonsForTag(reasonsColumn) {
  if (!reasonsColumn || typeof reasonsColumn !== "object") {
    return REASONS_EMPTY;
  }
  const entries = Array.isArray(reasonsColumn.entries)
    ? reasonsColumn.entries
    : [];
  return {
    entries,
    updatedAt: reasonsColumn.updatedAt || null,
  };
}

// Export the empty marker for tests + callers that want to compare
// against "no reasons yet".
export const __REASONS_EMPTY = REASONS_EMPTY;
export { FEATURE_DIMS };
